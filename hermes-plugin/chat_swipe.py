"""In-chat swiping: one message per deck, one tap per card, a note on any card.

Platform-agnostic. A chat layer (chat_telegram.py today) draws the card and turns taps and
incoming messages into calls here; this module owns the state and writes the verdicts to the
same file the board uses, so a deck can start in the chat and finish on the board.

Notes follow one rule: a note sent after a tap belongs to the card just tapped; a note sent
right after an Undo is held for the card on screen. Until the first tap on a deck, typed
messages go to Hermes as usual (a fresh deck shouldn't swallow a chat that was mid-sentence);
only a reply to the card itself is held as its note.

One deck is on screen per chat. A deck published while the person is still swiping another
waits in line and shows up when that one is sent.
"""
from __future__ import annotations

import secrets
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import swipe_core as core

ACTIONS = {"k": "keep", "c": "discard", "r": "revise"}
LABEL = {"keep": "Kept", "discard": "Cut", "revise": "Redo"}
NOTE_WINDOW_MINUTES = 10  # after this long with no tap, messages go to Hermes again
FINISH_WINDOW_SECONDS = 360  # a finished deck waits for a last note at most this long (the
# chat layer's grace timer is 3-300 s); past it the deck counts as done even if no timer fired
MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_SESSIONS = 100
MAX_QUEUE = 20  # decks waiting their turn in one chat
PREVIEW_CHARS = 300  # how much of a picture card's text rides along in its caption
STALE_FINISH_HOURS = 24
UNHEARD = "(voice note: couldn't be turned into text; the clip is saved)"
AUDIO_EXT = {".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".webm", ".flac", ".aac"}

_lock = threading.Lock()


# --------------------------------------------------------------------------- storage


def _path(root: Path) -> Path:
    return Path(root) / "data" / "chat-swipe.json"


def _lock_path(root: Path) -> Path:
    return Path(root) / "data" / "locks" / "chat-swipe.lock"


def chat_key(platform: str, chat_id: Any, thread_id: Any = "") -> str:
    thread = str(thread_id or "")
    if thread == "1":  # a forum's General topic: Hermes says "1", Telegram's own messages say nothing
        thread = ""
    return f"{str(platform).lower()}:{chat_id}:{thread}"


def _load(root: Path, strict: bool = False) -> dict:
    data = core.read_json(_path(root), {}, strict=strict) or {}
    return data if isinstance(data, dict) and isinstance(data.get("chats"), dict) else {"chats": {}}


def _update(root: Path, fn) -> Any:
    """Read-modify-write the session file under both a thread and a file lock."""
    root = core.ensure_root(root)
    with _lock, core.file_lock(_lock_path(root)):
        data = _load(root, strict=True)  # never write an empty file over one that was only locked
        out = fn(data["chats"])
        if len(data["chats"]) > MAX_SESSIONS:
            oldest = sorted(data["chats"], key=lambda k: data["chats"][k].get("touched", ""))
            for k in oldest[: len(data["chats"]) - MAX_SESSIONS]:
                data["chats"].pop(k, None)
        core.atomic_write_json(_path(root), data)
        return out


def get(root: Path, key: str) -> dict | None:
    s = _load(root)["chats"].get(key)
    return dict(s) if isinstance(s, dict) else None


def _minutes_since(iso: Any) -> float:
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return float("inf")
    if not t.tzinfo:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 60


# --------------------------------------------------------------------------- deck helpers


def _verdicts(root: Path, deck_id: str) -> dict:
    store = core.read_verdicts(root, deck_id)
    return {v.get("cardId"): v for v in store.get("verdicts") or [] if isinstance(v, dict)}


def _cards(root: Path, deck_id: str) -> tuple[dict, list[dict]]:
    loaded = core.load_deck(root, deck_id)
    if not loaded:
        raise core.SwipeError(f"no deck named {deck_id!r}")
    return loaded["deck"], loaded["cards"]


def _next_open(order: list, start: int, decided: dict, mine: set) -> int:
    """First position at or after `start` whose card has no verdict (cards decided on the board
    meanwhile are skipped; cards this chat decided are never revisited going forward)."""
    i = start
    while i < len(order) and (order[i] in decided or order[i] in mine):
        i += 1
    return i


def _join_note(old: str, new: str) -> str:
    old, new = (old or "").strip(), (new or "").strip()
    joined = f"{old} / {new}" if old and new else (old or new)
    return core.clean_text(joined, core.MAX_NOTE_CHARS)


# --------------------------------------------------------------------------- operations


def _live(s: Any) -> bool:
    """Is the person in the middle of this deck (opened or tapped lately, or waiting on a last note)?"""
    if not isinstance(s, dict):
        return False
    if s.get("status") == "finishing":
        return _still_finishing(s)
    return (s.get("status") == "active"
            and _minutes_since(s.get("tapped") or s.get("touched")) <= NOTE_WINDOW_MINUTES)


def _queue_of(s: Any) -> list[dict]:
    rows = s.get("queue") if isinstance(s, dict) else None
    return [dict(e) for e in rows or [] if isinstance(e, dict) and isinstance(e.get("deck"), str)]


def open_session(root: Path, deck_id: str, platform: str, chat_id: Any, user_id: Any,
                 thread_id: Any = "", queue: list | None = None) -> dict:
    """Start swiping `deck_id` in this chat.

    If the person is in the middle of another deck here, this one waits in line instead and
    the result is {"queued": place_in_line, "session": the deck on screen}. Otherwise it takes
    the chat; an earlier deck that was left open comes back as result["replaced"].
    `queue`: decks that were already waiting behind this one."""
    root = core.ensure_root(root)
    _deck, cards = _cards(root, deck_id)
    if not cards:
        raise core.SwipeError("this deck has no cards")
    order = [c["id"] for c in cards]
    decided = _verdicts(root, deck_id)
    key = chat_key(platform, chat_id, thread_id)
    session = {
        "key": key, "token": secrets.token_hex(4), "deck_id": deck_id,
        "platform": str(platform).lower(), "chat_id": str(chat_id), "thread_id": str(thread_id or ""),
        "user_id": str(user_id or ""), "order": order, "pos": _next_open(order, 0, decided, set()),
        "history": [], "last": None, "held": "", "held_audio": [], "message_id": None,
        "message_kind": None, "file_ids": {}, "notice": "", "status": "active",
        "started": core.now_iso(), "touched": core.now_iso(), "tapped": core.now_iso(),
    }
    if session["pos"] >= len(order):
        session["status"] = "finishing"

    def fn(chats):
        old = chats.get(key)
        waiting = [e for e in _queue_of(old) + _queue_of({"queue": queue}) if e["deck"] != deck_id]
        seen: set = set()
        waiting = [e for e in waiting if not (e["deck"] in seen or seen.add(e["deck"]))]
        if _live(old) and old.get("deck_id") != deck_id:
            mine = {"deck": deck_id, "user": str(user_id or "")}
            behind = _queue_of({"queue": queue})
            line = _queue_of(old)
            if not any(e["deck"] == deck_id for e in line):  # asked twice: it keeps its place
                line = [e for e in line if e not in behind]
                line = (line + [mine] + [e for e in behind if e["deck"] != deck_id])[:MAX_QUEUE]
            old["queue"] = line
            place = next((i for i, e in enumerate(line, start=1) if e["deck"] == deck_id), 0)
            return {"queued": place, "session": dict(old)}
        session["queue"] = waiting[:MAX_QUEUE]
        chats[key] = session
        out = dict(session)
        if isinstance(old, dict) and old.get("status") in ("active", "finishing") and old.get("deck_id") != deck_id:
            out["replaced"] = dict(old)
        return out

    return _update(root, fn)


def take_next(root: Path, key: str, token: str) -> dict | None:
    """After a deck is sent or stopped: the next deck waiting in this chat, and the ones behind it.
    Returns {"deck", "user", "rest"} once, or None."""
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token or s.get("status") not in ("sent", "stopped"):
            return None
        line = _queue_of(s)
        if not line:
            return None
        s["queue"] = []
        return {"deck": line[0]["deck"], "user": line[0].get("user") or s.get("user_id") or "", "rest": line[1:]}

    return _update(root, fn)


def set_message(root: Path, key: str, token: str, message_id: Any, kind: str,
                file_id: tuple[str, str] | None = None) -> None:
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token:
            return
        s["message_id"] = str(message_id) if message_id is not None else None
        s["message_kind"] = kind
        if file_id and file_id[1]:
            s.setdefault("file_ids", {})[file_id[0]] = file_id[1]

    _update(root, fn)


def tap(root: Path, key: str, token: str, pos: int, action: str, user_id: Any,
        message_id: Any = None) -> dict:
    """One button press. Returns {"ok", "reason"?, "session", "finished", "decision"?, "card"?}.

    reason: "gone" (no such session), "not_yours", "stale" (old message, double tap, or the card
    moved on), "nothing_to_undo". `action` is k/c/r (keep/cut/redo), u (undo) or s (send now)."""
    root = core.ensure_root(root)

    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token:
            return {"ok": False, "reason": "gone"}
        if not s.get("user_id") or str(user_id) != s["user_id"]:
            return {"ok": False, "reason": "not_yours", "session": dict(s)}
        if message_id is not None and s.get("message_id") and str(message_id) != s["message_id"]:
            return {"ok": False, "reason": "stale", "session": dict(s)}
        if s.get("status") in ("sent", "stopped"):
            return {"ok": False, "reason": "stale", "session": dict(s)}
        order = s["order"]
        out: dict[str, Any] = {"ok": True, "finished": False}
        if action in ACTIONS:
            if pos != s["pos"] or s["pos"] >= len(order) or s.get("status") != "active":
                return {"ok": False, "reason": "stale", "session": dict(s)}
            card_id = order[s["pos"]]
            decision = ACTIONS[action]
            extra = {"audio": list(s.get("held_audio") or [])} if s.get("held_audio") else None
            core.set_verdict(root, s["deck_id"], card_id, decision, s.get("held") or "", via="chat", extra=extra)
            s["history"].append(card_id)
            s["last"] = card_id
            s["held"], s["held_audio"] = "", []
            mine = set(s["history"])
            s["pos"] = _next_open(order, s["pos"] + 1, _verdicts(root, s["deck_id"]), mine)
            s["notice"] = ""
            out.update(decision=decision, card=card_id)
            if s["pos"] >= len(order):
                s["status"] = "finishing"
                out["finished"] = True
        elif action == "u":
            if pos != s["pos"]:
                return {"ok": False, "reason": "stale", "session": dict(s)}
            if not s["history"]:
                return {"ok": False, "reason": "nothing_to_undo", "session": dict(s)}
            card_id = s["history"].pop()
            old = _verdicts(root, s["deck_id"]).get(card_id) or {}
            core.set_verdict(root, s["deck_id"], card_id, None)
            s["pos"] = order.index(card_id)
            s["held"] = old.get("note") or ""
            s["held_audio"] = list(old.get("audio") or []) if isinstance(old.get("audio"), list) else []
            s["last"] = None  # a note now is about the card back on screen
            s["status"] = "active"
            s["notice"] = ""
            out.update(decision="undo", card=card_id)
        elif action == "s":
            if s.get("status") != "finishing":
                return {"ok": False, "reason": "stale", "session": dict(s)}
            s["status"] = "sent"
            out["finished"] = True
            out["decision"] = "send"
        else:
            return {"ok": False, "reason": "stale", "session": dict(s)}
        s["touched"] = s["tapped"] = core.now_iso()
        s["swiped"] = True  # from here on, a typed message is a note
        out["session"] = dict(s)
        return out

    return _update(root, fn)


def _still_finishing(s: Any) -> bool:
    return (isinstance(s, dict) and s.get("status") == "finishing"
            and _minutes_since(s.get("touched")) * 60 <= FINISH_WINDOW_SECONDS)


def finishing_sessions(root: Path) -> list[dict]:
    """Chat sessions swiped to the end and still inside the wait for a last note."""
    return [dict(s) for s in _load(root)["chats"].values() if _still_finishing(s)]


def overdue_sessions(root: Path) -> list[dict]:
    """Swiped to the end, but the wait ran out and nothing sent them (Hermes restarted mid-wait)."""
    return [dict(s) for s in _load(root)["chats"].values()
            if isinstance(s, dict) and s.get("status") == "finishing" and not _still_finishing(s)
            and _minutes_since(s.get("touched")) <= STALE_FINISH_HOURS * 60]


def note_target(session: dict | None) -> str | None:
    """The card a note sent right now belongs to: the one just tapped, else the one on screen."""
    if not session:
        return None
    if session.get("last"):
        return session["last"]
    order, pos = session.get("order") or [], session.get("pos") or 0
    return order[pos] if pos < len(order) else None


def owes_note(root: Path, session: dict | None) -> bool:
    """The card just tapped was sent back (Redo) and has no note yet."""
    last = (session or {}).get("last")
    if not last:
        return False
    v = _verdicts(root, session["deck_id"]).get(last) or {}
    return v.get("decision") == "revise" and not v.get("note")


def still_open(root: Path, deck_id: str) -> bool:
    """Does this deck exist and still have a card nobody has decided?"""
    try:
        _deck, cards = _cards(root, deck_id)
    except core.SwipeError:
        return False
    decided = _verdicts(root, deck_id)
    return any(c.get("id") not in decided for c in cards)


def finishing_decks(root: Path) -> set:
    """Decks swiped to the end in a chat but still open for a last note."""
    return {s.get("deck_id") for s in finishing_sessions(root)}


def wants_note(session: dict | None, user_id: Any, to_card: bool = False) -> bool:
    """Should a message from `user_id` in this chat be taken as a note right now?

    `to_card`: the message is a reply to the card itself. Before the first tap only those
    count; anything else typed then is for Hermes."""
    if not session or session.get("status") not in ("active", "finishing"):
        return False
    if not session.get("user_id") or str(user_id) != session["user_id"]:
        return False  # no known swiper: never swallow anyone's messages
    if session.get("status") == "finishing":
        return _still_finishing(session)
    if not (to_card or session.get("swiped") or session.get("history")):
        return False  # nothing tapped on this deck yet
    return _minutes_since(session.get("tapped") or session.get("touched")) <= NOTE_WINDOW_MINUTES


def _keep_audio(root: Path, deck_id: str, card_id: str, audio_path: Any) -> str | None:
    """Copy a voice clip next to the deck's data (Hermes' media cache gets cleaned)."""
    try:
        src = Path(str(audio_path))
        if not src.is_file() or src.suffix.lower() not in AUDIO_EXT or src.stat().st_size > MAX_AUDIO_BYTES:
            return None
        dest_dir = Path(root) / "data" / "chat-notes" / deck_id
        dest_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
        dest = dest_dir / f"{card_id}-{stamp}{src.suffix.lower()}"
        shutil.copyfile(src, dest)
        return str(dest.relative_to(root)).replace("\\", "/")
    except OSError:
        return None


def add_note(root: Path, key: str, user_id: Any, text: str, audio_path: Any = None,
             target: str | None = None, to_card: bool = False) -> dict:
    """Attach a note. Returns {"ok", "card", "title", "held"(bool), "session"} or {"ok": False}.

    `target`: the card the note was meant for when it arrived (see note_target), for a voice
    note that took a while to turn into text while the person kept swiping. A voice note with
    no text still counts: the clip is kept and the note says so. `to_card`: a reply to the
    card (see wants_note)."""
    root = core.ensure_root(root)
    text = core.clean_text(text, core.MAX_NOTE_CHARS)

    def fn(chats):
        s = chats.get(key)
        if not wants_note(s, user_id, to_card):
            return {"ok": False, "reason": "not_listening"}
        if not text and not audio_path:
            return {"ok": False, "reason": "empty"}
        deck_id, order, pos = s["deck_id"], s["order"], s["pos"]
        on_screen = order[pos] if pos < len(order) else None
        card_id = target or s.get("last") or on_screen
        if not card_id or card_id not in order:
            return {"ok": False, "reason": "no_card"}
        v = _verdicts(root, deck_id).get(card_id)
        decided = bool(v and v.get("decision") in core.DECISIONS)
        if not decided and card_id != on_screen:
            return {"ok": False, "reason": "no_card"}  # undone, and the deck has moved on
        held = not decided
        clip = _keep_audio(root, deck_id, card_id, audio_path) if audio_path else None
        words = text or (UNHEARD if clip else "")
        if not words:
            return {"ok": False, "reason": "empty"}
        if held:
            s["held"] = _join_note(s.get("held", ""), words)
            if clip:
                s.setdefault("held_audio", []).append(clip)
        else:
            audio = list(v.get("audio") or []) if isinstance(v.get("audio"), list) else []
            if clip:
                audio.append(clip)
            core.set_verdict(root, deck_id, card_id, v["decision"], _join_note(v.get("note", ""), words),
                             via="chat", extra={"audio": audio} if audio else None)
        s["touched"] = core.now_iso()
        return {"ok": True, "card": card_id, "held": held, "heard": bool(text), "session": dict(s)}

    out = _update(root, fn)
    if out.get("ok"):
        out["title"] = card_title(root, out["session"]["deck_id"], out["card"])
    return out


def set_notice(root: Path, key: str, token: str, notice: str, touch: bool = False) -> dict | None:
    """Put one line at the top of the card. `touch`: the person just did something, so the
    waits (for notes, for the last note) start over."""
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token:
            return None
        s["notice"] = core.clean_text(notice, 300)
        if touch:
            s["touched"] = core.now_iso()
        return dict(s)

    return _update(root, fn)


def set_delivery(root: Path, key: str, token: str, delivered: bool) -> dict | None:
    """Record whether Hermes was told straight away ("sent") or picks the verdicts up with the
    person's next message ("next_message"), so the finished card says which."""
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token:
            return None
        s["delivery"] = "sent" if delivered else "next_message"
        return dict(s)

    return _update(root, fn)


def finish(root: Path, key: str, token: str) -> dict | None:
    """Mark a finishing deck as sent; returns the session if this call did it (so it runs once)."""
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("token") != token or s.get("status") != "finishing":
            return None
        s["status"] = "sent"
        s["touched"] = core.now_iso()
        return dict(s)

    return _update(root, fn)


def close_finished(root: Path, deck_id: str) -> list[dict]:
    """The rest of a deck was swiped on the board while its card was still up in a chat: that
    chat is done with it too. Returns the sessions this call closed (so each closes once). A note
    typed for the card on screen and not yet attached goes onto that card's verdict."""
    root = core.ensure_root(root)

    def fn(chats):
        closed: list[dict] = []
        if still_open(root, deck_id):
            return closed
        for s in chats.values():
            if not isinstance(s, dict) or s.get("deck_id") != deck_id or s.get("status") != "active":
                continue
            order, pos = s.get("order") or [], s.get("pos") or 0
            if (s.get("held") or s.get("held_audio")) and pos < len(order):
                v = _verdicts(root, deck_id).get(order[pos]) or {}
                if v.get("decision") in core.DECISIONS:
                    audio = (list(v.get("audio") or []) if isinstance(v.get("audio"), list) else []) \
                        + list(s.get("held_audio") or [])
                    core.set_verdict(root, deck_id, order[pos], v["decision"],
                                     _join_note(v.get("note", ""), s.get("held") or ""),
                                     via="chat", extra={"audio": audio} if audio else None)
            s["held"], s["held_audio"] = "", []
            s["status"] = "sent"
            s["notice"] = "Finished on the board."
            s["touched"] = core.now_iso()
            closed.append(dict(s))
        return closed

    return _update(root, fn)


def stop(root: Path, key: str, token: str | None = None) -> dict | None:
    """Stop swiping in this chat (only the session with `token`, when given). Decks waiting in
    line are dropped from the chat too; they stay on the board."""
    def fn(chats):
        s = chats.get(key)
        if not s or s.get("status") not in ("active", "finishing"):
            return None
        if token is not None and s.get("token") != token:
            return None
        s["status"] = "stopped"
        s["dropped"] = len(_queue_of(s))
        s["queue"] = []
        return dict(s)

    return _update(root, fn)


# --------------------------------------------------------------------------- view


def card_title(root: Path, deck_id: str, card_id: str) -> str:
    try:
        _deck, cards = _cards(root, deck_id)
    except core.SwipeError:
        return card_id
    return next((c.get("title") or card_id for c in cards if c.get("id") == card_id), card_id)


def view(root: Path, session: dict) -> dict:
    """What the chat message should show now: the card (or the last one, when done), the
    caption lines, and which buttons."""
    deck, cards = _cards(root, session["deck_id"])
    by_id = {c["id"]: c for c in cards}
    order = session["order"]
    pos = session["pos"]
    total = len(order)
    status = session.get("status")
    shown = by_id.get(order[pos]) if pos < total else by_id.get(session.get("last") or order[-1])
    lines: list[str] = []
    if session.get("notice"):
        lines.append(session["notice"])
    last = session.get("last")
    s = core.summarize(root, session["deck_id"])
    if status in ("finishing", "sent", "stopped"):
        t = s["tally"]
        tally = f"{t['keep']} keep, {t['revise']} redo, {t['discard']} cut"
        if status == "finishing":
            lines.append(f"All {total} swiped: {tally}.")
            if last:
                name = card_title(root, session["deck_id"], last)
                v = _verdicts(root, session["deck_id"]).get(last) or {}
                if v.get("decision") == "revise" and not v.get("note"):
                    lines.append(f"Redo “{name}”: say what should change, or tap Send.")
                else:
                    lines.append(f"Type a note to add to “{name}”, or tap Send.")
        elif status == "sent" and session.get("delivery") == "next_message":
            lines.append(f"Done: {tally}. Hermes gets these with your next message.")
        elif status == "sent":
            lines.append(f"Sent to Hermes: {tally}.")
        else:
            lines.append(f"Stopped. {s['decided']} of {total} swiped; the rest are on the board.")
            dropped = session.get("dropped") or 0
            if dropped:
                lines.append(f"{dropped} more deck{'s' if dropped != 1 else ''} that {'were' if dropped != 1 else 'was'} "
                             "next in line: on the board too.")
    else:
        if last and not session.get("notice"):
            v = _verdicts(root, session["deck_id"]).get(last) or {}
            name = card_title(root, session["deck_id"], last)
            if v.get("decision") == "revise" and not v.get("note"):
                lines.append(f"Redo “{name}”: what should change? Type a note.")
            elif v.get("decision") in LABEL:
                lines.append(f"{LABEL[v['decision']]} “{name}”. Type a note to say why.")
        elif not last and not session.get("notice") and not session.get("held"):
            lines.append("Tap a button, then type a note on any card.")
        if session.get("held"):
            lines.append(f"Note for this one: “{core.clean_text(session['held'], 120)}”")
        if shown:
            lines.append("")
            lines.append(shown.get("title") or "")
            if shown.get("kind") in ("image", "video", "audio") and shown.get("preview"):
                words = " ".join(str(shown["preview"]).split())
                lines.append(words if len(words) <= PREVIEW_CHARS else words[: PREVIEW_CHARS - 1].rstrip() + "…")
            extra = " · ".join(x for x in (shown.get("caption"), shown.get("tag")) if x)
            if extra:
                lines.append(extra)
            waiting = len(_queue_of(session))
            lines.append(f"{pos + 1} of {total} · {deck.get('name', '')}"
                         + (f" · {waiting} more deck{'s' if waiting != 1 else ''} after this" if waiting else ""))
    buttons: list[list[tuple[str, str]]] = []
    if status == "active" and pos < total:
        buttons.append([("✓ Keep", "k"), ("✕ Cut", "c"), ("↻ Redo", "r")])
        if session.get("history"):
            buttons.append([("↶ Undo", "u")])
    elif status == "finishing":
        row = [("Send ➜", "s")]
        if session.get("history"):
            row.insert(0, ("↶ Undo", "u"))
        buttons.append(row)
    return {"card": shown, "caption": "\n".join(lines).strip(), "buttons": buttons, "status": status,
            "pos": pos, "total": total, "deck": deck}


def media_of(root: Path, card: dict | None) -> tuple[str | None, str | None]:
    """(kind, source) for a card's media: source is a local path, an https URL or a data: URI."""
    if not card:
        return None, None
    kind = card.get("kind")
    media = card.get("media")
    if isinstance(media, dict):
        media = media.get("src")
    if not isinstance(media, str) or kind not in ("image", "video", "audio"):
        return None, None
    if media.startswith(("https://", "data:")):
        return kind, media
    path = (Path(root) / media).resolve()
    if not core.is_within(path, [Path(root) / "decks"]) or not path.is_file():
        return None, None
    return kind, str(path)


def card_text(card: dict | None, limit: int = 3500) -> str:
    text = (card or {}).get("preview") or ""
    if len(text) > limit:
        text = text[:limit].rstrip() + "\n… (the full text is on the board)"
    return text
