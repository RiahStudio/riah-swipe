"""Telegram in-chat swiping: one message flips through the deck; Keep / Cut / Redo / Undo buttons;
voice or text notes in between.

Wiring (all from __init__.register):
  ctx.register_telegram_handler(layer.factory)   our buttons, scoped to callback data "rs:..."
  ctx.register_hook("pre_gateway_dispatch", ...)  catches notes while a deck is being swiped

python-telegram-bot is imported only inside the factory and the send helpers, so the plugin
still loads where Telegram isn't installed.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import re
from pathlib import Path
from typing import Any, Callable

from . import chat_swipe as cs

logger = logging.getLogger(__name__)

PLATFORM = "telegram"
CALLBACK_RE = re.compile(r"^rs:([kcrus]):([0-9a-f]{8}):(\d{1,4})$")
TOAST = {"keep": "Kept", "discard": "Cut", "revise": "Redo: say what should change", "undo": "Undone",
         "send": "Done"}
LISTENING = "Listening to your voice note…"
NO_MEDIA = "(This card's file wouldn't load in the chat. It's on the board.)"
TRANSCRIBE_TIMEOUT = 90.0  # a voice note that takes longer is kept as a clip, without text
REDO_WAIT_FACTOR = 6  # after a Redo on the last card, wait this many times longer for the note
MAX_FINISH_WAIT = 300.0  # must stay under chat_swipe.FINISH_WINDOW_SECONDS
REFUSED = {"not_yours": "This deck belongs to someone else in this chat.",
           "stale": "Already counted.", "gone": "That deck isn't open here any more.",
           "nothing_to_undo": "Nothing to undo yet."}
CAPTION_MAX = 1024
SEND_TIMEOUT = 60.0  # PTB allows 60 s for media uploads


class TelegramSwipe:
    def __init__(self, root_fn: Callable[[], Path], on_done: Callable[[str], None],
                 setting: Callable[[str, Any], Any]):
        self.root_fn = root_fn
        self.on_done = on_done  # called (in a worker thread) with a deck id when the person taps Send
        self.setting = setting
        self.app = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._gen: dict[str, int] = {}  # bumped on every schedule/cancel, so a stale timer does nothing
        self._chat_locks: dict[str, asyncio.Lock] = {}
        self._drawn: dict[str, Any] = {}  # chat key -> card id the message shows now
        self._bad_media: set[tuple[str, str]] = set()  # (deck id, card id) whose file Telegram refused

    # ------------------------------------------------------------------ wiring

    def factory(self, native: Any, adapter: Any = None) -> None:
        """Hermes calls this at Telegram connect with the PTB Application."""
        from telegram.ext import CallbackQueryHandler

        native.add_handler(CallbackQueryHandler(self.on_callback, pattern=r"^rs:"))
        self.app = native
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = None
        if self.loop is not None:
            self.loop.call_soon(self._rearm)

    def _rearm(self) -> None:
        """After a gateway restart, decks that were waiting for a last note still get sent: the
        wait starts over for recent ones, and ones whose wait already ran out go now."""
        try:
            root = self.root_fn()
            for session in cs.finishing_sessions(root):
                if session.get("platform") == PLATFORM and session["key"] not in self._timers:
                    self._schedule_finish(session)
            loop = self.loop
            for session in cs.overdue_sessions(root):
                if session.get("platform") == PLATFORM and loop is not None:
                    loop.create_task(self._auto_finish(session["key"], session["token"]))
        except Exception:
            logger.info("riah-swipe: could not re-arm finished decks", exc_info=True)

    def ready(self) -> bool:
        return self.app is not None and getattr(self.app, "bot", None) is not None

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._chat_locks.get(key)
        if lock is None:
            lock = self._chat_locks[key] = asyncio.Lock()
        return lock

    def finish_delay(self) -> float:
        try:
            return max(3.0, min(MAX_FINISH_WAIT, float(self.setting("chat_finish_delay", 30))))
        except (TypeError, ValueError):
            return 30.0

    # ------------------------------------------------------------------ start (tool thread)

    def start_deck(self, deck_id: str, chat_id: Any, user_id: Any, thread_id: Any = "") -> dict:
        """Post the first card. Called from the tool's worker thread; waits for the send."""
        if not self.ready():
            return {"ok": False, "reason": "telegram buttons are not wired in this process"}
        loop = self.loop
        if loop is None or loop.is_closed():
            return {"ok": False, "reason": "the Telegram event loop isn't available"}
        coro = self._open_and_send(deck_id, chat_id, user_id, thread_id)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:  # called on the loop itself: can't block on it
            loop.create_task(coro)
            return {"ok": True, "pending": True}
        fut = asyncio.run_coroutine_threadsafe(coro, loop)
        try:
            return fut.result(timeout=SEND_TIMEOUT)
        except BaseException as e:  # timeout or send failure: don't leave a half-open deck behind
            fut.cancel()
            logger.warning("riah-swipe: could not post the deck to Telegram: %s", e)
            try:
                key = cs.chat_key(PLATFORM, chat_id, thread_id)
                current = cs.get(self.root_fn(), key)
                if current and current.get("deck_id") == deck_id:
                    stopped = cs.stop(self.root_fn(), key, current.get("token"))
                    if stopped and stopped.get("message_id"):
                        self.redraw_soon(stopped)
            except Exception:
                logger.info("riah-swipe: cleanup after a failed start failed", exc_info=True)
            if not isinstance(e, Exception):
                raise
            return {"ok": False, "reason": f"{type(e).__name__}: {e}"[:200]}

    async def _open_and_send(self, deck_id: str, chat_id: Any, user_id: Any, thread_id: Any,
                             queue: list | None = None) -> dict:
        root = self.root_fn()
        session = await asyncio.to_thread(cs.open_session, root, deck_id, PLATFORM, chat_id, user_id,
                                          thread_id, queue)
        if session.get("queued"):  # the person is mid-deck: this one waits its turn
            showing = session["session"]
            async with self._lock_for(showing["key"]):
                await self._render_quietly(showing)  # the card now says another deck is waiting
            return {"ok": True, "key": showing["key"], "queued": session["queued"]}
        async with self._lock_for(session["key"]):
            old = session.pop("replaced", None)
            if old and old.get("message_id"):  # a deck left open here: its card stops taking taps
                self._cancel_finish(old["key"])
                await self._render_quietly({**old, "status": "stopped"})
                self._drawn.pop(session["key"], None)
            try:
                await self._render(session, fresh=True)
            except BaseException:
                await asyncio.to_thread(cs.stop, root, session["key"], session["token"])
                raise
            if session.get("status") == "finishing":  # everything was already decided on the board
                self._schedule_finish(session)
        return {"ok": True, "key": session["key"]}

    async def _start_next(self, session: dict) -> None:
        """A deck was just sent: if others were waiting in this chat, the next one goes up."""
        try:
            root = self.root_fn()
            nxt = await asyncio.to_thread(cs.take_next, root, session["key"], session["token"])
            if not nxt:
                return
            line = [{"deck": nxt["deck"], "user": nxt["user"]}] + list(nxt["rest"])
            while line:
                head, line = line[0], line[1:]
                if not await asyncio.to_thread(cs.still_open, root, head["deck"]):
                    continue  # swiped on the board meanwhile, or gone
                await self._open_and_send(head["deck"], session["chat_id"],
                                          head.get("user") or session.get("user_id"),
                                          session.get("thread_id") or "", line)
                return
        except Exception:
            logger.warning("riah-swipe: could not start the next deck in line", exc_info=True)

    def redraw_soon(self, session: dict) -> None:
        """Redraw a chat's card from any thread (e.g. after /swipe stop); fire and forget."""
        loop = self.loop
        if not self.ready() or loop is None or loop.is_closed():
            return
        self._cancel_finish_threadsafe(session["key"])

        async def go():
            async with self._lock_for(session["key"]):
                try:
                    await self._render(session)
                except Exception:
                    logger.info("riah-swipe: redraw failed", exc_info=True)

        try:
            asyncio.run_coroutine_threadsafe(go(), loop)
        except RuntimeError:
            pass

    def _cancel_finish_threadsafe(self, key: str) -> None:
        loop = self.loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._cancel_finish, key)
            except RuntimeError:
                pass

    # ------------------------------------------------------------------ taps

    async def on_callback(self, update: Any, context: Any = None) -> None:
        q = getattr(update, "callback_query", None)
        if q is None:
            return
        try:
            sent = await self._on_tap(q)
        except Exception:
            logger.warning("riah-swipe: a button tap failed", exc_info=True)
            await _answer(q, "Something went wrong. Tap again.")  # never leave the button spinning
            return
        if sent:
            await self._start_next(sent)

    async def _on_tap(self, q: Any) -> dict | None:
        """Handle one button press. Returns the session when this tap sent the deck to Hermes."""
        m = CALLBACK_RE.match(str(getattr(q, "data", "") or ""))
        msg = getattr(q, "message", None)
        if not m or msg is None:
            await _answer(q, REFUSED["gone"])
            return None
        action, token, pos = m.group(1), m.group(2), int(m.group(3))
        chat_id = getattr(getattr(msg, "chat", None), "id", None) or getattr(msg, "chat_id", None)
        key = cs.chat_key(PLATFORM, chat_id, _thread_of(msg))
        user_id = getattr(getattr(q, "from_user", None), "id", None)
        root = self.root_fn()
        async with self._lock_for(key):
            out = await asyncio.to_thread(cs.tap, root, key, token, pos, action, user_id,
                                          getattr(msg, "message_id", None))
            if not out.get("ok"):
                await _answer(q, REFUSED.get(out.get("reason"), REFUSED["stale"]),
                              alert=out.get("reason") == "not_yours")
                current = out.get("session")
                if (out.get("reason") == "stale" and current and current.get("token") == token
                        and current.get("status") in ("active", "finishing")
                        and str(getattr(msg, "message_id", "")) == str(current.get("message_id"))
                        and pos != current.get("pos")):
                    await self._render_quietly(current)  # these buttons are behind: catch up
                return None
            await _answer(q, TOAST.get(out.get("decision"), ""))
            session = out["session"]
            if out.get("decision") == "send":
                self._cancel_finish(key)
            elif session.get("status") == "finishing":
                self._schedule_finish(session)  # before drawing, so a failed draw can't strand it
            else:
                self._cancel_finish(key)
            if out.get("decision") == "send":
                session = await self._done(session)  # first, so the card can say where the verdicts went
            await self._render_quietly(session)
            if out.get("decision") != "send" and session.get("status") == "finishing":
                self._schedule_finish(session)  # the wait starts once the card is on screen
            return session if out.get("decision") == "send" else None

    async def _render_quietly(self, session: dict) -> None:
        try:
            await self._render(session)
        except Exception:
            logger.warning("riah-swipe: could not redraw the card", exc_info=True)

    # ------------------------------------------------------------------ notes

    async def on_dispatch(self, event: Any = None, **_: Any) -> dict | None:
        """pre_gateway_dispatch: a voice or text message from the person swiping becomes a note."""
        try:
            source = getattr(event, "source", None)
            platform = getattr(getattr(source, "platform", None), "value", getattr(source, "platform", ""))
            if str(platform or "").lower() != PLATFORM:
                return None
            key = cs.chat_key(PLATFORM, getattr(source, "chat_id", ""), getattr(source, "thread_id", "") or "")
            root = self.root_fn()
            session = await asyncio.to_thread(cs.get, root, key)
            user_id = getattr(source, "user_id", None) or getattr(event, "user_id", None)
            if not cs.wants_note(session, user_id):
                return None
            text = str(getattr(event, "text", "") or "").strip()
            mtype = str(getattr(getattr(event, "message_type", None), "value", getattr(event, "message_type", "")))
            reply_to = str(getattr(event, "reply_to_message_id", None) or "")
            thread = str(getattr(source, "thread_id", "") or "")
            if (reply_to and reply_to != thread  # in a forum topic every message "replies" to the topic
                    and session.get("message_id") and reply_to != session["message_id"]):
                return None  # replying to something else: that's for Hermes
            audio = None
            if mtype in ("voice", "audio"):
                audio = next((u for u in getattr(event, "media_urls", None) or [] if u), None)
                if not audio:
                    return None
            elif mtype != "text" or not text or text.startswith("/"):
                return None
            if not audio:
                async with self._lock_for(key):
                    return await self._save_note(root, key, user_id, text, None, None, session["token"])
            # A voice note. Pin it to the card it was sent for, say we're listening, and turn it
            # into text outside the chat's lock so the buttons keep working meanwhile.
            async with self._lock_for(key):
                session = await asyncio.to_thread(cs.get, root, key)
                if not cs.wants_note(session, user_id):
                    return None
                target = cs.note_target(session)
                token = session["token"]
                fresh = await asyncio.to_thread(cs.set_notice, root, key, token, LISTENING, True)
                if fresh:
                    if fresh.get("status") == "finishing":
                        # don't send the deck while the note is on its way (but never strand it)
                        self._schedule_finish(fresh, TRANSCRIBE_TIMEOUT + self.finish_delay())
                    await self._render_quietly(fresh)
            try:
                note = await asyncio.wait_for(_transcribe(audio), TRANSCRIBE_TIMEOUT)
            except asyncio.TimeoutError:
                logger.info("riah-swipe: voice note took too long to transcribe; keeping the clip")
                note = None
            except Exception:
                logger.info("riah-swipe: voice note transcription failed", exc_info=True)
                note = None
            async with self._lock_for(key):
                return await self._save_note(root, key, user_id, note or "", audio, target, token)
        except Exception:
            logger.warning("riah-swipe: note capture failed", exc_info=True)
            return None

    async def _save_note(self, root: Path, key: str, user_id: Any, note: str, audio: Any,
                         target: str | None, token: str) -> dict | None:
        """Attach the note and redraw the card (the chat's lock is held). Returns the hook's
        answer: skip the message, or None to let Hermes have it after all."""
        out = await asyncio.to_thread(cs.add_note, root, key, user_id, note, audio, target)
        if not out.get("ok") and out.get("reason") == "no_card" and target:
            # that card was undone and the deck moved on: the note goes with what's up now
            out = await asyncio.to_thread(cs.add_note, root, key, user_id, note, audio, None)
        if not out.get("ok"):
            if not audio:
                return None
            # No words and no clip to keep, or the deck was sent while we listened.
            lost = out.get("reason") == "empty"
            fresh = await asyncio.to_thread(
                cs.set_notice, root, key, token,
                "Couldn't make out that voice note. Try again, or type it." if lost else "")
            if fresh and fresh.get("status") in ("active", "finishing"):
                await self._render_quietly(fresh)
                if fresh.get("status") == "finishing":
                    self._schedule_finish(fresh)
            if lost:
                return {"action": "skip", "reason": "riah-swipe: voice note not transcribed"}
            return None
        where = "this one" if out.get("held") else f"“{out['title']}”"
        if out.get("heard"):
            notice = f"Note added to {where}: “{cs.core.clean_text(note, 140)}”"
        else:
            notice = (f"Couldn't make out that voice note. The clip is saved with {where}; "
                      "type it too if you'd like Hermes to read it.")
        fresh = await asyncio.to_thread(cs.set_notice, root, key, out["session"]["token"], notice)
        if fresh:
            if fresh.get("status") == "finishing":
                self._schedule_finish(fresh)  # more time for another note
            await self._render_quietly(fresh)
            if fresh.get("status") == "finishing":
                self._schedule_finish(fresh)
        if audio and not out.get("heard"):
            return {"action": "skip", "reason": "riah-swipe: voice note kept as a clip (not transcribed)"}
        return {"action": "skip", "reason": "riah-swipe: note for the card being swiped"}

    # ------------------------------------------------------------------ finishing

    def _finish_wait(self, session: dict) -> float:
        """How long to wait for a last note. Longer when the last card was sent back with no
        note yet: saying what should change takes a moment."""
        delay = self.finish_delay()
        try:
            if cs.owes_note(self.root_fn(), session):
                delay = min(MAX_FINISH_WAIT, delay * REDO_WAIT_FACTOR)
        except Exception:
            logger.info("riah-swipe: could not check for a missing Redo note", exc_info=True)
        return delay

    def _schedule_finish(self, session: dict, delay: float | None = None) -> None:
        key = session["key"]
        self._cancel_finish(key)
        loop = self.loop or asyncio.get_event_loop()
        token = session["token"]
        gen = self._gen[key]
        self._timers[key] = loop.call_later(
            self._finish_wait(session) if delay is None else delay,
            lambda: loop.create_task(self._auto_finish(key, token, gen)))

    def _cancel_finish(self, key: str) -> None:
        self._gen[key] = self._gen.get(key, 0) + 1
        t = self._timers.pop(key, None)
        if t is not None:
            t.cancel()

    async def _auto_finish(self, key: str, token: str, gen: int | None = None) -> None:
        root = self.root_fn()
        async with self._lock_for(key):
            if gen is not None and self._gen.get(key) != gen:
                return  # a later note restarted the wait (or it was cancelled) while this one queued
            self._timers.pop(key, None)
            session = await asyncio.to_thread(cs.finish, root, key, token)
            if not session:
                return
            session = await self._done(session)
            await self._render_quietly(session)
        await self._start_next(session)  # outside the lock: the next deck takes it itself

    async def _done(self, session: dict) -> dict:
        """Hand the finished deck to Hermes. on_done returns True when Hermes was told straight
        away; otherwise the verdicts wait for the person's next message, and the card says so."""
        delivered = False
        try:
            delivered = bool(await asyncio.to_thread(self.on_done, session["deck_id"]))
        except Exception:
            logger.warning("riah-swipe: handing the finished deck to Hermes failed", exc_info=True)
        try:
            fresh = await asyncio.to_thread(cs.set_delivery, self.root_fn(), session["key"],
                                            session["token"], delivered)
        except Exception:
            logger.info("riah-swipe: could not record how the deck was delivered", exc_info=True)
            fresh = None
        return fresh or session

    # ------------------------------------------------------------------ drawing

    async def _render(self, session: dict, fresh: bool = False) -> None:
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup

        root = self.root_fn()
        v = await asyncio.to_thread(cs.view, root, session)
        markup = None
        if v["buttons"]:
            markup = InlineKeyboardMarkup([
                [InlineKeyboardButton(label, callback_data=f"rs:{a}:{session['token']}:{v['pos']}")
                 for label, a in row] for row in v["buttons"]])
        card = v["card"]
        kind, src = cs.media_of(root, card)
        caption = v["caption"]
        bad = (session.get("deck_id"), (card or {}).get("id"))
        no_file = kind is not None and bad in self._bad_media
        if no_file:  # Telegram wouldn't take this card's file: show it as words instead
            kind, src = None, None
        want = "media" if kind else "text"
        bot = self.app.bot
        chat_id = session["chat_id"]
        tid = str(session.get("thread_id") or "")
        thread = int(tid) if tid.isdigit() and tid != "1" else None  # "1" is the General topic
        msg_id = session.get("message_id")
        same_card = card is not None and card.get("id") == self._drawn.get(session["key"])
        if not fresh and msg_id and session.get("message_kind") == want:
            try:
                if want == "media" and not same_card:
                    file = await asyncio.to_thread(_file, src, session, card)
                    media = _input_media(kind, file, _trim(caption, CAPTION_MAX))
                    sent = await bot.edit_message_media(chat_id=chat_id, message_id=int(msg_id), media=media,
                                                        reply_markup=markup)
                elif want == "media":
                    sent = await bot.edit_message_caption(chat_id=chat_id, message_id=int(msg_id),
                                                          caption=_trim(caption, CAPTION_MAX), reply_markup=markup)
                else:
                    sent = await bot.edit_message_text(chat_id=chat_id, message_id=int(msg_id),
                                                       text=_words(card, caption, no_file), reply_markup=markup)
                await self._remember(session, sent, want, card, kind)
                return
            except Exception as e:
                if "not modified" in str(e).lower():
                    return
                logger.info("riah-swipe: edit failed, sending a fresh card (%s)", e)
        # A new message: first card, or the card changed between text and media.
        sent = None
        try:
            if want == "media":
                try:
                    file = await asyncio.to_thread(_file, src, session, card)
                    sent = await _send_media(bot, kind, chat_id, thread, file,
                                             _trim(caption, CAPTION_MAX), markup)
                except Exception as e:
                    if type(e).__name__ in ("TimedOut", "NetworkError", "RetryAfter", "TimeoutError"):
                        raise  # the connection, not the file
                    logger.info("riah-swipe: the card's file wouldn't send (%s); showing it as text", e)
                    self._bad_media.add(bad)
                    want, kind, no_file = "text", None, True
            if want == "text":
                sent = await bot.send_message(chat_id=chat_id, message_thread_id=thread,
                                              text=_words(card, caption, no_file), reply_markup=markup)
        finally:
            if sent is not None and msg_id and not fresh:
                try:
                    await bot.delete_message(chat_id=chat_id, message_id=int(msg_id))
                except Exception:
                    pass
        await self._remember(session, sent, want, card, kind)

    async def _remember(self, session: dict, sent: Any, want: str, card: dict | None, kind: str | None) -> None:
        if sent is None or sent is True:  # edit of an inline message returns True
            return
        file_id = None
        if card and kind:
            file_id = (card["id"], _file_id(sent, kind))
        root = self.root_fn()
        await asyncio.to_thread(cs.set_message, root, session["key"], session["token"],
                                getattr(sent, "message_id", session.get("message_id")), want, file_id)
        self._drawn[session["key"]] = card.get("id") if card else None


def _thread_of(msg: Any) -> str:
    """The thread id the way Hermes' Telegram adapter reports it for this message."""
    raw = getattr(msg, "message_thread_id", None)
    if raw is None:
        return ""
    chat = getattr(msg, "chat", None)
    if getattr(msg, "is_topic_message", False) or getattr(chat, "is_forum", False) is True:
        return str(raw)
    return ""


def _units(text: str) -> int:
    """Length the way Telegram counts it (UTF-16 code units)."""
    return len(text.encode("utf-16-le")) // 2


def _trim(text: str, limit: int) -> str:
    if _units(text) <= limit:
        return text
    cut = text[: limit - 1]
    while cut and _units(cut) > limit - 1:
        cut = cut[:-1]
    return cut.rstrip() + "…"


def _text_body(card: dict | None, caption: str) -> str:
    body = cs.card_text(card)
    return _trim((body + "\n\n" + caption).strip() if body else caption or "…", 4096)


def _words(card: dict | None, caption: str, no_file: bool) -> str:
    """The text of a card's message. A media card whose file wouldn't load says so; its caption
    already carries the card's words."""
    if no_file:
        return _trim((caption + "\n\n" + NO_MEDIA).strip(), 4096)
    return _text_body(card, caption)


def _file(src: str | None, session: dict, card: dict | None) -> Any:
    """A Telegram file_id from an earlier send, an https URL, raw bytes for data:, or the open file."""
    fid = (session.get("file_ids") or {}).get((card or {}).get("id"))
    if fid:
        return fid
    if not src:
        return None
    if src.startswith("https://"):
        return src
    if src.startswith("data:"):
        return base64.b64decode(src.split(",", 1)[1])
    return Path(src).read_bytes()


def _input_media(kind: str, file: Any, caption: str):
    from telegram import InputMediaAudio, InputMediaPhoto, InputMediaVideo

    cls = {"image": InputMediaPhoto, "video": InputMediaVideo, "audio": InputMediaAudio}[kind]
    return cls(media=file, caption=caption)


async def _send_media(bot: Any, kind: str, chat_id: Any, thread: Any, file: Any, caption: str, markup: Any):
    arg = {"image": "photo", "video": "video", "audio": "audio"}[kind]
    send = getattr(bot, "send_" + arg)
    try:
        return await send(chat_id=chat_id, message_thread_id=thread, caption=caption, reply_markup=markup,
                          **{arg: file})
    except Exception as e:
        if kind != "image":
            raise
        logger.info("riah-swipe: send_photo refused (%s); sending as a file", e)
        return await bot.send_document(chat_id=chat_id, message_thread_id=thread, caption=caption,
                                       reply_markup=markup, document=file)


def _file_id(sent: Any, kind: str) -> str | None:
    try:
        if kind == "image":
            photos = getattr(sent, "photo", None) or []
            if photos:
                return photos[-1].file_id
            doc = getattr(sent, "document", None)
            return getattr(doc, "file_id", None)
        obj = getattr(sent, {"video": "video", "audio": "audio"}[kind], None)
        return getattr(obj, "file_id", None)
    except Exception:
        return None


async def _answer(q: Any, text: str = "", alert: bool = False) -> None:
    try:
        await q.answer(text=text or None, show_alert=alert)
    except Exception:
        pass


async def _transcribe(path: str) -> str | None:
    """Hermes' own speech-to-text (whatever provider the person configured)."""
    try:
        from tools.transcription_tools import transcribe_audio
    except Exception:
        return None
    try:
        result = await asyncio.to_thread(transcribe_audio, path, None, "gateway")
    except Exception:
        logger.info("riah-swipe: transcription raised", exc_info=True)
        return None
    if isinstance(result, dict) and result.get("success") and str(result.get("transcript") or "").strip():
        return str(result["transcript"]).strip()
    return None
