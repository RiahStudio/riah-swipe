"""Riah Swipe core: build decks, read verdicts, summarize. Pure stdlib, no Hermes imports.

Layout under the plugin's data root:

    <root>/decks/<deckId>.swipe.json     a deck the board loads
    <root>/decks/<deckId>/<media>        media copied in for that deck
    <root>/data/results/<deckId>.results.json   last payload the board sent
    <root>/data/verdicts/<deckId>.json   merged verdicts (one per card)
    <root>/data/server.json              where the board server is listening (+ its secret)
    <root>/data/*.lock, data/locks/      lock files for cross-process read-modify-write
"""
from __future__ import annotations

import contextlib
import json
import mimetypes
import os
import random
import re
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
DECISIONS = ("keep", "revise", "discard")
TEXT_KINDS = ("text", "script", "line", "chapter", "logline")
CARD_KINDS = ("image", "video", "audio") + TEXT_KINDS
MAX_CARDS = 60
MAX_MEDIA_BYTES = 200 * 1024 * 1024  # per file
MAX_DECK_BYTES = 1024 * 1024 * 1024  # all copied media in one deck
MAX_DATA_URI_BYTES = 4 * 1024 * 1024
MAX_INLINE_BYTES = 16 * 1024 * 1024  # all data: URIs in one deck (they live inside the deck json)
MAX_NOTE_CHARS = 500
MAX_TITLE_CHARS = 120
MAX_TEXT_CHARS = 20_000
MAX_CAPTION_CHARS = 200
MAX_TAG_CHARS = 40
MAX_DECK_NOTE_CHARS = 2_000
MAX_SELECTING_CHARS = 200

# No .svg: an svg served from the board's origin can carry script.
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXT = {".mp4", ".m4v", ".mov", ".webm", ".mkv"}
AUDIO_EXT = {".mp3", ".wav", ".ogg", ".m4a", ".flac"}
MEDIA_EXT = IMAGE_EXT | VIDEO_EXT | AUDIO_EXT

_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
# Control characters, zero-width space, line/paragraph separators and bidi overrides.
# ZWNJ/ZWJ (U+200C/D) stay: emoji sequences and several scripts need them.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b\u2028-\u202e\u2066-\u2069\ufeff]")
_CONTROL_KEEP_LINES = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b\u2028-\u202e\u2066-\u2069\ufeff]")


class SwipeError(ValueError):
    """A problem with the caller's input. The message is safe to show the model."""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def slug(text: str, limit: int = 48) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(text or "")).strip("-").lower()
    return (s[:limit].strip("-")) or "deck"


def atomic_write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2, ensure_ascii=False)
        # Windows refuses to replace a file another process is reading; wait it out.
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(random.uniform(0.025, 0.05))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    for attempt in range(5):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except PermissionError:  # briefly locked by a writer on Windows
            time.sleep(0.02 * (attempt + 1))
        except (OSError, ValueError):
            return default
    return default


_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def _os_lock(fh) -> None:
    if os.name == "nt":
        import msvcrt

        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _os_unlock(fh) -> None:
    if os.name == "nt":
        import msvcrt

        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def file_lock(lock_path: Path, timeout: float = 15.0):
    """Exclusive lock across threads and processes, held on `lock_path` (a `.lock` file).
    Not re-entrant: never nest it for the same path."""
    lock_path = Path(lock_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    key = str(lock_path)
    with _THREAD_LOCKS_GUARD:
        tl = _THREAD_LOCKS.setdefault(key, threading.Lock())
    if not tl.acquire(timeout=timeout):
        raise TimeoutError(f"timed out waiting for {lock_path.name}")
    fh = None
    try:
        fh = open(lock_path, "a+b")
        deadline = time.monotonic() + timeout
        while True:
            try:
                _os_lock(fh)
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise TimeoutError(f"timed out waiting for {lock_path.name}")
                time.sleep(0.03)
        try:
            yield
        finally:
            try:
                _os_unlock(fh)
            except OSError:
                pass
    finally:
        if fh is not None:
            fh.close()
        tl.release()


def clean_text(value: Any, limit: int) -> str:
    """Single-line, control-free text capped at `limit` characters."""
    s = str(value if value is not None else "")
    for ch in ("\r\n", "\n", "\r", "\t"):
        s = s.replace(ch, " ")
    return _CONTROL.sub("", s).strip()[:limit]


def clean_block(value: Any, limit: int) -> str:
    """Like clean_text, but keeps line breaks and tabs (script pages, long copy)."""
    s = str(value if value is not None else "").replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL_KEEP_LINES.sub("", s).strip()[:limit]


# --------------------------------------------------------------------------- root


def ensure_root(root: Path) -> Path:
    root = Path(root).expanduser().resolve()
    (root / "decks").mkdir(parents=True, exist_ok=True)
    (root / "data" / "results").mkdir(parents=True, exist_ok=True)
    (root / "data" / "verdicts").mkdir(parents=True, exist_ok=True)
    return root


def deck_path(root: Path, deck_id: str) -> Path:
    check_id(deck_id, "deck id")
    return Path(root) / "decks" / f"{deck_id}.swipe.json"


def is_safe_id(value: Any) -> bool:
    """Letters, digits, '.', '_', '-'; no Windows device names, no all-dot ids."""
    if not isinstance(value, str) or not SAFE_ID.match(value):
        return False
    if set(value) == {"."} or value.endswith("."):
        return False
    return value.split(".", 1)[0].upper() not in _RESERVED_NAMES


def check_id(value: str, what: str = "id") -> str:
    if not is_safe_id(value):
        raise SwipeError(f"invalid {what}: use letters, digits, '.', '_' or '-' (max 128), "
                         "and not a reserved name like CON or NUL")
    return value


# --------------------------------------------------------------------------- media


def _kind_for_ext(ext: str) -> str | None:
    ext = ext.lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    if ext in AUDIO_EXT:
        return "audio"
    return None


def _kind_for_data_uri(uri: str) -> str | None:
    m = re.match(r"^data:(image|video|audio)/[A-Za-z0-9.+-]+[;,]", uri)
    return m.group(1) if m else None


def _magic_ok(ext: str, head: bytes) -> bool:
    """Do the file's first bytes match what its extension claims?"""
    ext = ext.lower()
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8\xff")
    if ext == ".gif":
        return head[:6] in (b"GIF87a", b"GIF89a")
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if ext in (".mp4", ".m4v", ".mov", ".m4a"):
        return head[4:8] == b"ftyp"
    if ext in (".webm", ".mkv"):
        return head.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".mp3":
        return head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    if ext == ".wav":
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if ext == ".ogg":
        return head.startswith(b"OggS")
    if ext == ".flac":
        return head.startswith(b"fLaC")
    return False


def _base_dir() -> Path:
    return Path(os.environ.get("TERMINAL_CWD") or os.getcwd())


def _url_path(src: str) -> str:
    """The path part of a URL, without ?query or #fragment."""
    return src.split("#", 1)[0].split("?", 1)[0]


def _norm(p: Any) -> str:
    return os.path.normcase(str(Path(p).expanduser().resolve()))


def is_within(path: Any, roots: list) -> bool:
    """Is `path` (already resolved) inside one of `roots`?"""
    target = _norm(path)
    for r in roots:
        try:
            base = _norm(r)
            if os.path.commonpath([target, base]) == base:
                return True
        except (ValueError, OSError):  # different drives, bad path
            continue
    return False


def new_budget() -> dict:
    return {"files": MAX_DECK_BYTES, "inline": MAX_INLINE_BYTES}


def _place_media(src: str, root: Path, deck_id: str, stem: str, budget: dict | None = None, *,
                 want: str | None = None, allowed_roots: list | None = None,
                 base_dir: Any = None) -> tuple[str, str]:
    """Return (media value for the deck, kind). Copies local files into the deck folder.

    `budget` holds the bytes this deck may still copy ("files") and still inline ("inline").
    `want` requires one kind (a poster must be an image). `allowed_roots`, when given,
    lists the only folders local files may come from."""
    src = str(src).strip()
    if not src:
        raise SwipeError("empty media path")

    def _check_kind(kind: str) -> None:
        if want and kind != want:
            raise SwipeError(f"expected an {want} here, got {kind}")

    if src.startswith("data:"):
        kind = _kind_for_data_uri(src)
        if not kind:
            raise SwipeError("data URI must be image/*, video/* or audio/*")
        _check_kind(kind)
        if len(src) > MAX_DATA_URI_BYTES:
            raise SwipeError("data URI too large (max 4 MB); pass a file path instead")
        if budget is not None:
            if len(src) > budget["inline"]:
                raise SwipeError(f"this deck's inline data: media adds up to more than "
                                 f"{MAX_INLINE_BYTES // (1024 * 1024)} MB; pass file paths instead")
            budget["inline"] -= len(src)
        return src, kind
    if re.match(r"^http://", src, re.I):
        raise SwipeError("only https:// media links are accepted (http:// is not)")
    if re.match(r"^https://", src, re.I):
        kind = _kind_for_ext(os.path.splitext(_url_path(src))[1])
        if not kind:
            raise SwipeError(f"can't tell the media type of URL {src!r}; give it a file extension")
        _check_kind(kind)
        return src, kind
    path = Path(src).expanduser()
    if not path.is_absolute():
        path = Path(base_dir or _base_dir()) / path
    path = path.resolve()
    # Checked before anything touches the file, so nothing leaks about files outside.
    if allowed_roots is not None and not is_within(path, allowed_roots):
        raise SwipeError(f"{src} is outside the folders Riah Swipe may copy media from. Move it into "
                         "the working folder, or add its folder to "
                         "plugins.entries.riah-swipe.settings.media_dirs")
    if not path.is_file():
        raise SwipeError(f"media file not found: {src}")
    ext = path.suffix.lower()
    kind = _kind_for_ext(ext)
    if not kind:
        raise SwipeError(f"unsupported media type {ext!r} (png/jpg/gif/webp, mp4/mov/webm/mkv, mp3/wav/ogg/m4a/flac)")
    _check_kind(kind)
    size = path.stat().st_size
    if size > MAX_MEDIA_BYTES:
        raise SwipeError(f"media file too large: {src}")
    if budget is not None and size > budget["files"]:
        raise SwipeError(f"this deck's media adds up to more than {MAX_DECK_BYTES // (1024 * 1024)} MB")
    with open(path, "rb") as fh:
        head = fh.read(16)
    if not _magic_ok(ext, head):
        raise SwipeError(f"{src} doesn't look like a real {ext} file (its first bytes don't match)")
    dest_dir = Path(root) / "decks" / deck_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{stem}{ext}"
    shutil.copyfile(path, dest)
    if budget is not None:
        budget["files"] -= size
    return f"decks/{deck_id}/{dest.name}", kind


# --------------------------------------------------------------------------- decks


def build_deck(
    root: Path,
    title: str,
    cards: list[dict],
    *,
    note: str = "",
    selecting_for: str = "",
    source: str = "hermes",
    deck_id: str | None = None,
    allowed_roots: list | None = None,
    base_dir: Any = None,
) -> dict:
    """Write a deck from simple card specs. Returns {deck, cards, path}.

    Card spec keys: title, text, image | video | audio | media, poster, caption, tag,
    kind, meta. Each card needs a title, text or media.

    `allowed_roots`: the only folders local media may be copied from (None = anywhere).
    `base_dir`: where relative media paths start (default: TERMINAL_CWD or the cwd).
    """
    root = ensure_root(root)
    title = str(title or "").strip()
    if not title:
        raise SwipeError("title is required")
    if not isinstance(cards, list) or not cards:
        raise SwipeError("cards must be a non-empty list")
    if len(cards) > MAX_CARDS:
        raise SwipeError(f"too many cards (max {MAX_CARDS} per deck)")

    reserved = False
    if deck_id:
        check_id(deck_id, "deck id")
    else:
        # Claim the media folder with an atomic mkdir, so two publishes in the same
        # second can't pick the same id and write into each other's folder.
        base = f"{slug(title)}-{time.strftime('%Y%m%d-%H%M%S')}"
        deck_id, n = base, 2
        while True:
            if not deck_path(root, deck_id).exists():
                try:
                    (Path(root) / "decks" / deck_id).mkdir()
                    reserved = True
                    break
                except FileExistsError:
                    pass
            deck_id = f"{base}-{n}"
            n += 1

    old = read_json(deck_path(root, deck_id), {}) or {}
    old_rev = 0
    for d in old.get("decks") or []:
        if d.get("id") == deck_id:
            try:
                old_rev = int(d.get("rev") or 0)
            except (TypeError, ValueError):
                old_rev = 0

    deck_dir = Path(root) / "decks" / deck_id
    dir_existed = deck_dir.exists() and not reserved
    try:
        out = _build(root, deck_id, title, cards, note, selecting_for, source, old_rev, allowed_roots, base_dir)
    except BaseException:
        if not dir_existed:  # don't leave half a deck behind
            shutil.rmtree(deck_dir, ignore_errors=True)
        raise
    if reserved:
        try:
            deck_dir.rmdir()  # only succeeds when no media was copied
        except OSError:
            pass
    return out


def _build(root: Path, deck_id: str, title: str, cards: list, note: str, selecting_for: str, source: str,
           old_rev: int, allowed_roots: list | None = None, base_dir: Any = None) -> dict:
    out_cards: list[dict] = []
    kinds: set[str] = set()
    budget = new_budget()
    place = lambda src, stem, want=None: _place_media(  # noqa: E731
        src, root, deck_id, stem, budget, want=want, allowed_roots=allowed_roots, base_dir=base_dir)
    for i, spec in enumerate(cards, start=1):
        if isinstance(spec, str):
            spec = {"title": spec}
        if not isinstance(spec, dict):
            raise SwipeError(f"card {i} must be an object")
        card_title = str(spec.get("title") or "").strip()
        text = clean_block(spec.get("text") or spec.get("preview") or "", MAX_TEXT_CHARS)
        media_src = spec.get("image") or spec.get("video") or spec.get("audio") or spec.get("media")
        if not card_title and not text and not media_src:
            raise SwipeError(f"card {i} has no content: give it a title, text, or media")
        if not card_title:
            card_title = (text.strip().splitlines() or [f"Option {i}"])[0]
        card_title = clean_text(card_title, MAX_TITLE_CHARS) or f"Option {i}"
        card_id = f"{deck_id[:120]}-{i:02d}"
        card: dict[str, Any] = {"id": card_id, "deckId": deck_id, "title": card_title}

        kind = str(spec.get("kind") or "").strip().lower() or None
        if media_src:
            media, media_kind = place(media_src, f"{i:02d}")
            kind = media_kind
            if media_kind == "video":
                v: dict[str, Any] = {"src": media}
                poster = spec.get("poster")
                if poster:
                    v["poster"], _ = place(poster, f"{i:02d}-poster", "image")
                mime = None if media.startswith("data:") else mimetypes.guess_type(_url_path(media))[0]
                if mime:
                    v["mime"] = mime
                card["media"] = v
            else:
                card["media"] = media
        elif kind not in TEXT_KINDS:
            kind = "text"
        card["kind"] = kind
        kinds.add(kind)
        if text:
            card["preview"] = text
        for key, limit in (("caption", MAX_CAPTION_CHARS), ("tag", MAX_TAG_CHARS)):
            value = clean_text(spec.get(key), limit) if spec.get(key) else ""
            if value:
                card[key] = value
        if isinstance(spec.get("meta"), dict):
            card["meta"] = spec["meta"]
        out_cards.append(card)

    deck = {
        "id": deck_id,
        "name": clean_text(title, MAX_TITLE_CHARS),
        "source": source,
        "kind": kinds.pop() if len(kinds) == 1 else "mixed",
        "note": clean_block(note or "", MAX_DECK_NOTE_CHARS),
        "selectingFor": clean_text(selecting_for or "", MAX_SELECTING_CHARS),
        "returnTo": source,
        "createdAt": now_iso(),
        "rev": old_rev + 1,
    }
    path = deck_path(root, deck_id)
    atomic_write_json(path, {"decks": [deck], "cards": out_cards})
    return {"deck": deck, "cards": out_cards, "path": str(path)}


def load_deck(root: Path, deck_id: str) -> dict | None:
    data = read_json(deck_path(root, deck_id))
    if not isinstance(data, dict):
        return None
    deck = next((d for d in data.get("decks") or [] if d.get("id") == deck_id), None)
    if not deck:
        return None
    cards = [c for c in data.get("cards") or [] if c.get("deckId") == deck_id]
    return {"deck": deck, "cards": cards}


def discard_deck(root: Path, deck_id: str) -> None:
    """Remove a deck's file and media folder (used to undo a publish that failed halfway)."""
    check_id(deck_id, "deck id")
    shutil.rmtree(Path(root) / "decks" / deck_id, ignore_errors=True)
    try:
        deck_path(root, deck_id).unlink()
    except OSError:
        pass


def list_decks(root: Path, limit: int = 20) -> list[str]:
    d = Path(root) / "decks"
    rows = []
    try:
        for p in d.iterdir():
            if not p.name.endswith(".swipe.json"):
                continue
            try:
                rows.append((-p.stat().st_mtime, p.name))
            except OSError:  # deleted while we were scanning
                continue
    except OSError:
        return []
    rows.sort()
    return [name[: -len(".swipe.json")] for _, name in rows[:limit]]


# --------------------------------------------------------------------------- verdicts


def read_verdicts(root: Path, deck_id: str) -> dict:
    check_id(deck_id, "deck id")
    store = read_json(Path(root) / "data" / "verdicts" / f"{deck_id}.json", None)
    return store if isinstance(store, dict) else {"verdicts": []}


def store_results(root: Path, payload: Any) -> dict:
    """Persist a riah-swipe.results/1 payload (same contract as server/serve.mjs).

    The payload comes from a browser, so it is checked against the real deck: unknown
    card ids are rejected, at most one result per card is kept, and notes are cleaned."""
    if not isinstance(payload, dict) or payload.get("schema") != "riah-swipe.results/1":
        raise SwipeError("expected schema riah-swipe.results/1")
    deck_id = str(payload.get("batchId") or "")
    if not is_safe_id(deck_id):
        raise SwipeError("invalid batchId")
    results = payload.get("results")
    if not isinstance(results, list):
        raise SwipeError("results must be an array")
    root = ensure_root(root)
    loaded = load_deck(root, deck_id)
    if not loaded:
        raise SwipeError(f"no deck named {deck_id!r}")
    card_ids = {c.get("id") for c in loaded["cards"]}
    for r in results:
        if isinstance(r, dict) and isinstance(r.get("cardId"), str) and r["cardId"] not in card_ids:
            raise SwipeError(f"card {clean_text(r['cardId'], 60)!r} is not in deck {deck_id!r}")
    results = results[: len(card_ids)]
    vfile = root / "data" / "verdicts" / f"{deck_id}.json"
    with file_lock(root / "data" / "locks" / f"verdicts-{deck_id}.lock"):
        atomic_write_json(root / "data" / "results" / f"{deck_id}.results.json", payload)
        store = read_json(vfile, None)
        if not isinstance(store, dict):
            store = {"schema": "riah-swipe.verdicts/1", "batchId": deck_id, "verdicts": []}
        by_card: dict[str, dict] = {}
        for v in store.get("verdicts") or []:
            if isinstance(v, dict) and isinstance(v.get("cardId"), str):
                by_card[v["cardId"]] = v
        before = _signature(by_card)
        for r in results:
            if not isinstance(r, dict) or not isinstance(r.get("cardId"), str):
                continue
            if r.get("decision") not in DECISIONS:
                continue
            new = {
                "cardId": r["cardId"],
                "decision": r["decision"],
                "note": clean_text(r.get("note"), MAX_NOTE_CHARS),
                "decidedAt": clean_text(r.get("decidedAt"), 40) or now_iso(),
                "via": "board",
            }
            old = by_card.get(r["cardId"])
            # Newest decision wins, so a second device syncing older swipes (every board
            # re-sends on load) or a late, out-of-order post can't undo a newer verdict.
            if old is None or _when(new["decidedAt"]) >= _when(old.get("decidedAt")):
                by_card[r["cardId"]] = new
        try:
            version = int(store.get("version") or 0)
        except (TypeError, ValueError):
            version = 0
        if _signature(by_card) != before:
            version += 1
        store.update(
            {
                "deckName": clean_text(payload.get("deckName") or store.get("deckName"), MAX_TITLE_CHARS),
                "project": clean_text(payload.get("project"), MAX_TITLE_CHARS),
                "verdicts": list(by_card.values()),
                "version": version,
                "updatedAt": now_iso(),
            }
        )
        atomic_write_json(vfile, store)
    return {"ok": True, "batchId": deck_id, "decided": len(by_card), "version": version}


def set_verdict(root: Path, deck_id: str, card_id: str, decision: str | None, note: str = "",
                via: str = "chat", extra: dict | None = None) -> dict:
    """Record (or, with decision=None, remove) one card's verdict in the same file the board uses.

    Used by in-chat swiping: one tap is one call. Returns the new verdict version."""
    check_id(deck_id, "deck id")
    if decision is not None and decision not in DECISIONS:
        raise SwipeError(f"decision must be one of {', '.join(DECISIONS)}")
    root = ensure_root(root)
    loaded = load_deck(root, deck_id)
    if not loaded:
        raise SwipeError(f"no deck named {deck_id!r}")
    if card_id not in {c.get("id") for c in loaded["cards"]}:
        raise SwipeError(f"card {clean_text(card_id, 60)!r} is not in deck {deck_id!r}")
    vfile = root / "data" / "verdicts" / f"{deck_id}.json"
    with file_lock(root / "data" / "locks" / f"verdicts-{deck_id}.lock"):
        store = read_json(vfile, None)
        if not isinstance(store, dict):
            store = {"schema": "riah-swipe.verdicts/1", "batchId": deck_id, "verdicts": [],
                     "deckName": clean_text(loaded["deck"].get("name"), MAX_TITLE_CHARS)}
        by_card = {v["cardId"]: v for v in store.get("verdicts") or []
                   if isinstance(v, dict) and isinstance(v.get("cardId"), str)}
        before = _signature(by_card)
        if decision is None:
            by_card.pop(card_id, None)
        else:
            row = {"cardId": card_id, "decision": decision, "note": clean_text(note, MAX_NOTE_CHARS),
                   "decidedAt": now_iso(), "via": clean_text(via, 20) or "chat"}
            for k, v in (extra or {}).items():
                if k not in row:
                    row[k] = v
            by_card[card_id] = row
        version = verdict_version(store)
        if _signature(by_card) != before:
            version += 1
        store.update({"verdicts": list(by_card.values()), "version": version, "updatedAt": now_iso()})
        atomic_write_json(vfile, store)
    return {"ok": True, "batchId": deck_id, "decided": len(by_card), "version": version}


_EPOCH =datetime.min.replace(tzinfo=timezone.utc)


def _when(value: Any) -> datetime:
    """Parse an ISO time from the board; anything unreadable sorts oldest."""
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return _EPOCH
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _signature(by_card: dict) -> frozenset:
    """What the person decided, ignoring timestamps (so a re-sync of the same swipes is no change)."""
    return frozenset((k, v.get("decision"), v.get("note") or "") for k, v in by_card.items() if isinstance(v, dict))


def verdict_version(store: dict) -> int:
    """Goes up by one each time the set of decisions or notes changes."""
    try:
        return int(store.get("version") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


def summarize(root: Path, deck_id: str) -> dict:
    """Join a deck with its verdicts: tallies, per-card decisions, and redo hints."""
    loaded = load_deck(root, deck_id)
    if not loaded:
        raise SwipeError(f"no deck named {deck_id!r}")
    deck, cards = loaded["deck"], loaded["cards"]
    store = read_verdicts(root, deck_id)
    by_card = {v.get("cardId"): v for v in store.get("verdicts") or [] if isinstance(v, dict)}
    rows = {"keep": [], "revise": [], "discard": []}
    undecided = []
    for c in cards:
        v = by_card.get(c["id"])
        entry = {"card_id": c["id"], "title": clean_text(c.get("title", ""), MAX_TITLE_CHARS)}
        media = c.get("media")
        if isinstance(media, dict):
            media = media.get("src")
        if isinstance(media, str) and not media.startswith("data:"):
            entry["media"] = media
        if c.get("meta"):
            entry["meta"] = c["meta"]
        if v and v.get("decision") in rows:
            if v.get("note"):
                entry["note"] = clean_text(v["note"], MAX_NOTE_CHARS)
            rows[v["decision"]].append(entry)
        else:
            undecided.append(entry)
    total = len(cards)
    decided = total - len(undecided)
    out = {
        "deck_id": deck_id,
        "title": clean_text(deck.get("name", deck_id), MAX_TITLE_CHARS),
        "selecting_for": deck.get("selectingFor", ""),
        "cards": total,
        "decided": decided,
        "complete": total > 0 and decided == total,
        "tally": {k: len(v) for k, v in rows.items()},
        "keep": rows["keep"],
        "revise": rows["revise"],
        "discard": rows["discard"],
        "undecided": undecided,
        "updated_at": store.get("updatedAt"),
        "version": verdict_version(store),
    }
    if rows["revise"]:
        out["next_step"] = (
            "Regenerate each 'revise' card using its note, keep the 'keep' cards as the "
            "reference for what works, then publish the redo as a new deck."
        )
    return out


def _q(text: Any, limit: int) -> str:
    """Quoted, single-line, bounded: the form untrusted text takes inside the brief."""
    return json.dumps(clean_text(text, limit), ensure_ascii=False)


def brief_line(summary: dict, updated: bool = False) -> str:
    """One compact paragraph about a finished deck, for injecting into the next turn.

    `updated`: the deck was handed back before and the person has since changed verdicts.
    Everything the person typed (titles, notes) is quoted data, not instructions."""
    t = summary["tally"]
    what = "was swiped again and its verdicts changed; now" if updated else "finished:"
    parts = [
        f"Deck {_q(summary['title'], MAX_TITLE_CHARS)} (id {summary['deck_id']}) {what} "
        f"{t['keep']} keep, {t['revise']} revise, {t['discard']} discard."
    ]
    if summary["keep"]:
        parts.append("Kept: " + "; ".join(_q(e["title"], MAX_TITLE_CHARS) for e in summary["keep"][:12]) + ".")
    for e in summary["revise"][:12]:
        parts.append(f"Revise {_q(e['title'], MAX_TITLE_CHARS)}"
                     + (f", note {_q(e['note'], MAX_NOTE_CHARS)}" if e.get("note") else "") + ".")
    for e in summary["discard"][:12]:
        if e.get("note"):
            parts.append(f"Discarded {_q(e['title'], MAX_TITLE_CHARS)}, note {_q(e['note'], MAX_NOTE_CHARS)}.")
    parts.append("swipe_results has the full detail.")
    return " ".join(parts)
