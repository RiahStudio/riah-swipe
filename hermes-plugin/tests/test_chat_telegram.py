"""Telegram in-chat swiping (chat_telegram.py) against a fake bot, with real python-telegram-bot
types when that library is installed (skipped otherwise)."""
import asyncio
import contextlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402

plugin = H.load_plugin()
core = H.core()
cs = sys.modules[H.PKG + ".chat_swipe"]
ct = sys.modules.get(H.PKG + ".chat_telegram")
if ct is None:
    import importlib
    ct = importlib.import_module(H.PKG + ".chat_telegram")

try:
    import telegram  # noqa: F401
    HAVE_PTB = True
except Exception:
    HAVE_PTB = False

PNG = b"\x89PNG\r\n\x1a\n" + b"fake"
USER = 42
CHAT = 100


class Msg:
    _next = 1000

    def __init__(self, kind="text", chat_id=CHAT):
        Msg._next += 1
        self.message_id = Msg._next
        self.chat = types.SimpleNamespace(id=chat_id, is_forum=False)
        self.message_thread_id = None
        self.is_topic_message = False
        self.photo = [types.SimpleNamespace(file_id=f"ph-{self.message_id}")] if kind == "image" else []
        self.document = None
        self.video = self.audio = None


class FakeBot:
    def __init__(self, refuse_photo=False):
        self.calls = []
        self.refuse_photo = refuse_photo

    async def send_message(self, **kw):
        self.calls.append(("send_message", kw))
        return Msg("text", kw["chat_id"])

    async def send_photo(self, **kw):
        self.calls.append(("send_photo", kw))
        if self.refuse_photo:
            raise RuntimeError("Bad Request: PHOTO_INVALID_DIMENSIONS")
        return Msg("image", kw["chat_id"])

    async def send_document(self, **kw):
        self.calls.append(("send_document", kw))
        m = Msg("doc", kw["chat_id"])
        m.document = types.SimpleNamespace(file_id=f"doc-{m.message_id}")
        return m

    async def edit_message_media(self, **kw):
        self.calls.append(("edit_message_media", kw))
        m = Msg("image")
        m.message_id = kw["message_id"]
        return m

    async def edit_message_caption(self, **kw):
        self.calls.append(("edit_message_caption", kw))
        m = Msg("image")
        m.message_id = kw["message_id"]
        return m

    async def edit_message_text(self, **kw):
        self.calls.append(("edit_message_text", kw))
        m = Msg("text")
        m.message_id = kw["message_id"]
        return m

    async def delete_message(self, **kw):
        self.calls.append(("delete_message", kw))
        return True

    def names(self):
        return [c[0] for c in self.calls]

    def last(self, name=None):
        for n, kw in reversed(self.calls):
            if name is None or n == name:
                return kw
        return None


class FakeApp:
    def __init__(self, bot):
        self.bot = bot
        self.handlers = []

    def add_handler(self, h, group=0):
        self.handlers.append(h)


class Query:
    def __init__(self, data, message, user=USER):
        self.data = data
        self.message = message
        self.from_user = types.SimpleNamespace(id=user)
        self.answers = []

    async def answer(self, text=None, show_alert=False):
        self.answers.append((text, show_alert))


def event(text="", mtype="text", user=USER, chat=CHAT, media=None, reply_to=None, platform="telegram"):
    return types.SimpleNamespace(
        text=text, message_type=types.SimpleNamespace(value=mtype), user_id=str(user),
        media_urls=media or [], reply_to_message_id=reply_to,
        source=types.SimpleNamespace(platform=types.SimpleNamespace(value=platform), chat_id=str(chat),
                                     thread_id=None, user_id=str(user)))


async def until(cond, timeout=10.0):
    """Wait for a condition instead of a fixed sleep (the PC may be busy)."""
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.02)


@contextlib.contextmanager
def fake_transcriber(result):
    mod = types.ModuleType("tools.transcription_tools")
    mod.calls = []

    def transcribe_audio(path, model=None, source=None):
        mod.calls.append(path)
        if isinstance(result, Exception):
            raise result
        return result

    mod.transcribe_audio = transcribe_audio
    tl = types.ModuleType("tools")
    tl.transcription_tools = mod
    with mock.patch.dict(sys.modules, {"tools": tl, "tools.transcription_tools": mod}):
        yield mod


@unittest.skipUnless(HAVE_PTB, "python-telegram-bot not installed")
class LayerBase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)  # a redraw thread may still hold the lock file on Windows
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        self.root = core.ensure_root(self.tmp / "data")
        self.done = []
        self.layer = ct.TelegramSwipe(lambda: self.root, self.done.append, lambda k, d: d)
        self.layer.finish_delay = lambda: 0.05
        self.bot = FakeBot()
        self.app = FakeApp(self.bot)
        self.layer.factory(self.app, None)

    def deck(self, kinds="iii", deck_id="dk"):
        cards = []
        for i, k in enumerate(kinds, 1):
            if k == "i":
                img = self.tmp / f"s{i}.png"
                img.write_bytes(PNG)
                cards.append({"title": f"Shirt {i}", "image": str(img)})
            else:
                cards.append({"title": f"Line {i}", "text": f"text {i}"})
        core.build_deck(self.root, "Shirts", cards, deck_id=deck_id)
        return deck_id

    async def start(self, kinds="iii"):
        self.deck(kinds)
        out = await asyncio.to_thread(self.layer.start_deck, "dk", CHAT, USER, "")
        self.assertTrue(out["ok"], out)
        self.key = cs.chat_key("telegram", CHAT, "")
        return out

    def session(self):
        return cs.get(self.root, self.key)

    def current_message(self):
        s = self.session()
        m = Msg()
        m.message_id = int(s["message_id"])
        return m

    async def press(self, action, user=USER, message=None, pos=None):
        s = self.session()
        q = Query(f"rs:{action}:{s['token']}:{s['pos'] if pos is None else pos}",
                  message or self.current_message(), user)
        await self.layer.on_callback(types.SimpleNamespace(callback_query=q), None)
        return q

    def verdicts(self):
        return {v["cardId"]: v for v in core.read_verdicts(self.root, "dk").get("verdicts") or []}


class WiringTests(LayerBase):
    async def test_handler_is_scoped_to_rs_prefix(self):
        from telegram.ext import CallbackQueryHandler

        self.assertEqual(len(self.app.handlers), 1)
        h = self.app.handlers[0]
        self.assertIsInstance(h, CallbackQueryHandler)
        self.assertTrue(h.pattern.match("rs:k:abcd1234:0"))
        self.assertFalse(h.pattern.match("approve:123"))
        self.assertTrue(self.layer.ready())

    async def test_start_posts_the_first_card_with_buttons(self):
        await self.start()
        self.assertEqual(self.bot.names(), ["send_photo"])
        kw = self.bot.last()
        self.assertEqual(kw["chat_id"], str(CHAT))
        self.assertIn("Shirt 1", kw["caption"])
        self.assertIn("1 of 3", kw["caption"])
        rows = kw["reply_markup"].inline_keyboard
        self.assertEqual([b.text for b in rows[0]], ["✓ Keep", "✕ Cut", "↻ Redo"])
        for b in rows[0]:
            self.assertLessEqual(len(b.callback_data.encode()), 64)
            self.assertTrue(b.callback_data.startswith("rs:"))
        self.assertEqual(self.session()["message_kind"], "media")

    async def test_not_ready_before_connect(self):
        layer = ct.TelegramSwipe(lambda: self.root, lambda d: None, lambda k, d: d)
        self.assertFalse(layer.ready())
        self.deck()
        self.assertFalse(layer.start_deck("dk", CHAT, USER)["ok"])


class TapFlowTests(LayerBase):
    async def test_three_shirts_keep_redo_cut_then_send(self):
        await self.start()
        first_id = self.session()["message_id"]
        q = await self.press("k")
        self.assertEqual(q.answers[0][0], "Kept")
        self.assertEqual(self.bot.last()["media"].caption.splitlines()[0], "Kept “Shirt 1”. A voice note adds why.")
        self.assertEqual(self.bot.names()[-1], "edit_message_media")
        self.assertEqual(self.session()["message_id"], first_id)  # same message flips
        q = await self.press("r")
        self.assertIn("Redo", q.answers[0][0])
        await self.press("c")
        self.assertEqual(self.session()["status"], "finishing")
        kw = self.bot.last()
        self.assertIn("All 3 swiped", kw["caption"])
        self.assertEqual([b.text for b in kw["reply_markup"].inline_keyboard[0]], ["↶ Undo", "Send ➜"])
        await self.press("s")
        self.assertEqual(self.done, ["dk"])
        self.assertIn("Sent to Hermes", self.bot.last()["caption"])
        self.assertIsNone(self.bot.last()["reply_markup"])
        await asyncio.sleep(0.15)
        self.assertEqual(self.done, ["dk"])  # the timer was cancelled: sent once
        self.assertEqual({k: v["decision"] for k, v in self.verdicts().items()},
                         {"dk-01": "keep", "dk-02": "revise", "dk-03": "discard"})

    async def test_finish_sends_itself_after_the_grace_period(self):
        await self.start("i")
        await self.press("k")
        self.assertEqual(self.done, [])
        await until(lambda: self.done)
        self.assertEqual(self.done, ["dk"])
        self.assertEqual(self.session()["status"], "sent")

    async def test_undo_cancels_the_auto_send(self):
        await self.start("i")
        await self.press("k")
        await self.press("u")
        await asyncio.sleep(0.2)
        self.assertEqual(self.done, [])
        self.assertEqual(self.session()["status"], "active")

    async def test_double_tap_is_answered_quietly(self):
        await self.start()
        msg = self.current_message()
        s = self.session()
        await self.press("k", message=msg, pos=0)
        q = await self.press("c", message=msg, pos=0)
        self.assertEqual(q.answers[0], ("Already counted.", False))
        self.assertEqual(len(self.verdicts()), 1)

    async def test_old_message_tap_is_stale(self):
        await self.start()
        old = Msg()
        q = await self.press("k", message=old)
        self.assertEqual(q.answers[0][0], "Already counted.")
        self.assertEqual(self.verdicts(), {})

    async def test_someone_else_gets_an_alert(self):
        await self.start()
        q = await self.press("k", user=7)
        self.assertEqual(q.answers[0], ("This deck belongs to someone else in this chat.", True))
        self.assertEqual(self.verdicts(), {})

    async def test_junk_callback_data(self):
        q = Query("rs:k:nothex!:0", Msg())
        await self.layer.on_callback(types.SimpleNamespace(callback_query=q), None)
        self.assertEqual(q.answers[0][0], "That deck isn't open here any more.")

    async def test_text_to_media_switch_sends_new_and_deletes_old(self):
        await self.start("ti")
        self.assertEqual(self.bot.names(), ["send_message"])
        first = self.session()["message_id"]
        await self.press("k")
        self.assertEqual(self.bot.names()[1:], ["send_photo", "delete_message"])
        self.assertEqual(str(self.bot.last("delete_message")["message_id"]), first)
        self.assertNotEqual(self.session()["message_id"], first)
        self.assertEqual(self.session()["message_kind"], "media")
        await self.press("k")  # finishing: caption-only edit of the same picture
        self.assertEqual(self.bot.names()[-1], "edit_message_caption")

    async def test_undo_back_to_an_earlier_image_reuses_its_file_id(self):
        await self.start("ii")
        await self.press("k")
        await self.press("u")
        kw = self.bot.last("edit_message_media")
        self.assertTrue(str(kw["media"].media).startswith("ph-"))

    async def test_photo_refused_falls_back_to_document(self):
        self.bot.refuse_photo = True
        await self.start("i")
        self.assertEqual(self.bot.names(), ["send_photo", "send_document"])
        self.assertIn("Shirt 1", self.bot.last()["caption"])

    async def test_long_captions_are_trimmed(self):
        self.deck("i")
        long_title = "x" * 2000
        d = core.read_json(core.deck_path(self.root, "dk"), {}) if hasattr(core, "deck_path") else None
        if d is None:
            self.skipTest("no deck_path helper")
        d["cards"][0]["title"] = long_title
        core.atomic_write_json(core.deck_path(self.root, "dk"), d)
        await asyncio.to_thread(self.layer.start_deck, "dk", CHAT, USER, "")
        self.assertLessEqual(len(self.bot.last()["caption"]), 1024)


class NoteFlowTests(LayerBase):
    async def test_text_note_after_keep(self):
        await self.start()
        await self.press("k")
        out = await self.layer.on_dispatch(event=event("love the colours"), gateway=None, session_store=None)
        self.assertEqual(out["action"], "skip")
        self.assertEqual(self.verdicts()["dk-01"]["note"], "love the colours")
        self.assertIn("Note added to “Shirt 1”", self.bot.last()["caption"])

    async def test_voice_note_after_redo_is_transcribed_and_kept(self):
        await self.start()
        await self.press("r")
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        with fake_transcriber({"success": True, "transcript": "bigger mullet"}) as t:
            out = await self.layer.on_dispatch(event(mtype="voice", media=[str(clip)]))
        self.assertEqual(out["action"], "skip")
        self.assertEqual(t.calls, [str(clip)])
        v = self.verdicts()["dk-01"]
        self.assertEqual((v["decision"], v["note"]), ("revise", "bigger mullet"))
        self.assertEqual(len(v["audio"]), 1)

    async def test_voice_note_that_fails_to_transcribe(self):
        await self.start()
        await self.press("r")
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        with fake_transcriber({"success": False, "error": "no provider"}):
            out = await self.layer.on_dispatch(event(mtype="voice", media=[str(clip)]))
        self.assertEqual(out["action"], "skip")
        self.assertIn("Couldn't make out that voice note", self.bot.last()["media"].caption
                      if "media" in self.bot.last() else self.bot.last()["caption"])
        self.assertEqual(self.verdicts()["dk-01"]["note"], "")

    async def test_transcriber_missing(self):
        await self.start()
        await self.press("k")
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        with mock.patch.dict(sys.modules, {"tools": None, "tools.transcription_tools": None}):
            out = await self.layer.on_dispatch(event(mtype="voice", media=[str(clip)]))
        self.assertEqual(out["action"], "skip")

    async def test_note_before_first_tap_is_held(self):
        await self.start()
        await self.layer.on_dispatch(event("this one is close"))
        self.assertIn("Note for this one", self.bot.last()["caption"])
        await self.press("k")
        self.assertEqual(self.verdicts()["dk-01"]["note"], "this one is close")

    async def test_commands_and_other_people_pass_through(self):
        await self.start()
        await self.press("k")
        self.assertIsNone(await self.layer.on_dispatch(event("/swipe stop")))
        self.assertIsNone(await self.layer.on_dispatch(event("hi", user=7)))
        self.assertIsNone(await self.layer.on_dispatch(event("hi", chat=999)))
        self.assertIsNone(await self.layer.on_dispatch(event("hi", platform="discord")))
        self.assertIsNone(await self.layer.on_dispatch(event(mtype="photo", media=["x.jpg"])))
        self.assertIsNone(await self.layer.on_dispatch(event("re", reply_to="1")))
        self.assertEqual(self.verdicts()["dk-01"]["note"], "")

    async def test_reply_to_the_card_counts_as_a_note(self):
        await self.start()
        await self.press("k")
        out = await self.layer.on_dispatch(event("yes this", reply_to=self.session()["message_id"]))
        self.assertEqual(out["action"], "skip")

    async def test_note_during_grace_restarts_the_timer(self):
        self.layer.finish_delay = lambda: 1.5
        await self.start("i")
        await self.press("k")
        await asyncio.sleep(1.0)
        await self.layer.on_dispatch(event("great"))  # restarts the 1.5 s timer
        await asyncio.sleep(1.0)  # 2 s after the tap: the first timer would have fired
        self.assertEqual(self.done, [])  # pushed back
        await until(lambda: self.done)
        self.assertEqual(self.done, ["dk"])
        self.assertEqual(self.verdicts()["dk-01"]["note"], "great")

    async def test_nothing_after_sent(self):
        await self.start("i")
        await self.press("k")
        await self.press("s")
        self.assertIsNone(await self.layer.on_dispatch(event("late note")))

    async def test_redraw_after_stop(self):
        await self.start()
        stopped = await asyncio.to_thread(cs.stop, self.root, self.key)
        self.layer.redraw_soon(stopped)
        await until(lambda: "Stopped." in (self.bot.last() or {}).get("caption", ""))
        kw = self.bot.last()
        self.assertIn("Stopped.", kw["caption"])
        self.assertIsNone(kw["reply_markup"])


# --------------------------------------------------------------------------- plugin wiring


class TgCtx:
    def __init__(self, config=None):
        self.config = config or {}
        self.tools, self.hooks, self.commands, self.cli, self.unload = [], [], [], [], []
        self.factories, self.injected = [], []

    def register_tool(self, **kw):
        self.tools.append(kw)

    def register_hook(self, name, fn):
        self.hooks.append((name, fn))

    def register_command(self, name, fn, description=""):
        self.commands.append((name, fn, description))

    def register_cli_command(self, **kw):
        self.cli.append(kw)

    def register_telegram_handler(self, factory):
        self.factories.append(factory)

    def on_unload(self, fn):
        self.unload.append(fn)

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.injected.append((content, session_key))
        return True


@contextlib.contextmanager
def telegram_turn(chat=CHAT, user=USER, key="agent:main:telegram:dm:100"):
    env = {"HERMES_SESSION_PLATFORM": "telegram", "HERMES_SESSION_KEY": key,
           "HERMES_SESSION_CHAT_ID": str(chat), "HERMES_SESSION_USER_ID": str(user)}
    sc = types.ModuleType("gateway.session_context")
    sc.get_session_env = lambda name, default="": env.get(name, default)
    sc.session_is_messaging_surface = lambda: True
    gw = types.ModuleType("gateway")
    gw.session_context = sc
    with mock.patch.dict(sys.modules, {"gateway": gw, "gateway.session_context": sc}):
        yield


@unittest.skipUnless(HAVE_PTB, "python-telegram-bot not installed")
class PluginWiringTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)  # a redraw thread may still hold the lock file on Windows
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        env = mock.patch.dict(os.environ, {"SWIPE_ROOT": str(self.tmp / "data")})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("HERMES_PLATFORM", None)
        self.ctx = TgCtx(config={"port": H.free_port()})
        plugin.register(self.ctx)
        self.addCleanup(self._reset)
        self.bot = FakeBot()
        self.app = FakeApp(self.bot)

    def _reset(self):
        plugin._shutdown()
        plugin._ctx = None
        plugin._chat = None

    def publish(self, n=2):
        img = self.tmp / "a.png"
        img.write_bytes(PNG)
        with telegram_turn(), mock.patch.object(plugin, "_media_roots", lambda: None):
            return json.loads(plugin.handle_publish(
                {"title": "Shirts", "cards": [{"title": f"Shirt {i}", "image": str(img)} for i in range(n)]},
                session_id="s1"))

    async def test_register_wires_buttons_and_note_hook(self):
        self.assertEqual(len(self.ctx.factories), 1)
        self.assertIn("pre_gateway_dispatch", [h[0] for h in self.ctx.hooks])
        self.assertIsNotNone(plugin._chat)

    async def test_publish_on_telegram_posts_in_chat_and_pushes_when_sent(self):
        self.ctx.factories[0](self.app, None)
        out = await asyncio.to_thread(self.publish)
        self.assertTrue(out["ok"], out)
        self.assertTrue(out.get("in_chat"))
        self.assertIn("right here in the chat", out["tell_the_person"])
        self.assertEqual(self.bot.names(), ["send_photo"])
        layer = plugin._chat
        layer.finish_delay = lambda: 0.05
        key = cs.chat_key("telegram", CHAT, "")
        root = plugin._root()
        for _ in range(2):
            s = cs.get(root, key)
            m = Msg()
            m.message_id = int(s["message_id"])
            q = Query(f"rs:k:{s['token']}:{s['pos']}", m)
            await layer.on_callback(types.SimpleNamespace(callback_query=q), None)
        with telegram_turn():
            await until(lambda: self.ctx.injected)
        self.assertEqual(len(self.ctx.injected), 1)
        content, skey = self.ctx.injected[0]
        self.assertTrue(content.startswith(plugin.BRIEF_HEADER))
        self.assertEqual(skey, "agent:main:telegram:dm:100")

    async def test_publish_falls_back_to_board_when_not_connected(self):
        out = await asyncio.to_thread(self.publish)
        self.assertTrue(out["ok"], out)
        self.assertFalse(out.get("in_chat"))
        self.assertIn("chat_swipe_unavailable", out)

    async def test_chat_swipe_setting_off(self):
        self.ctx.config["chat_swipe"] = False
        self.ctx.factories[0](self.app, None)
        out = await asyncio.to_thread(self.publish)
        self.assertFalse(out.get("in_chat"))
        self.assertEqual(self.bot.names(), [])

    async def test_swipe_stop(self):
        self.ctx.factories[0](self.app, None)
        await asyncio.to_thread(self.publish)
        with telegram_turn():
            msg = await asyncio.to_thread(plugin.cmd_swipe, "stop")
            again = await asyncio.to_thread(plugin.cmd_swipe, "stop")
        self.assertIn("Stopped swiping here", msg)
        self.assertIn("no deck being swiped", again)
        await until(lambda: "Stopped." in (self.bot.last() or {}).get("caption", ""))
        self.assertIn("Stopped.", self.bot.last()["caption"])

    async def test_pre_llm_call_waits_during_grace(self):
        self.ctx.factories[0](self.app, None)
        await asyncio.to_thread(self.publish, 1)
        layer = plugin._chat
        layer.finish_delay = lambda: 30
        key = cs.chat_key("telegram", CHAT, "")
        s = cs.get(plugin._root(), key)
        m = Msg()
        m.message_id = int(s["message_id"])
        await layer.on_callback(types.SimpleNamespace(
            callback_query=Query(f"rs:k:{s['token']}:0", m)), None)
        with telegram_turn():
            self.assertIsNone(plugin.on_pre_llm_call(session_id="s1"))
        layer._cancel_finish(key)


class ReviewFixTests(LayerBase):
    async def start_in(self, thread, kinds="i"):
        self.deck(kinds)
        out = await asyncio.to_thread(self.layer.start_deck, "dk", CHAT, USER, thread)
        self.assertTrue(out["ok"], out)
        self.key = cs.chat_key("telegram", CHAT, thread)
        return out

    async def test_forum_general_topic_buttons_work(self):
        await self.start_in("1", "ii")
        self.assertIsNone(self.bot.last("send_photo")["message_thread_id"])
        m = self.current_message()
        m.chat.is_forum = True  # General-topic messages carry no thread id
        await self.press("k", message=m)
        self.assertEqual(self.verdicts()["dk-01"]["decision"], "keep")

    async def test_forum_topic_note_is_caught(self):
        await self.start_in("7", "ii")
        self.assertEqual(self.bot.last("send_photo")["message_thread_id"], 7)
        m = self.current_message()
        m.message_thread_id, m.is_topic_message = 7, True
        await self.press("k", message=m)
        e = event("love the colours", reply_to=7)
        e.source.thread_id = "7"
        self.assertEqual((await self.layer.on_dispatch(event=e))["action"], "skip")
        self.assertEqual(self.verdicts()["dk-01"]["note"], "love the colours")

    async def test_tap_on_buttons_that_fell_behind_redraws(self):
        await self.start("iii")
        await self.press("k")
        before = len(self.bot.calls)
        q = await self.press("k", pos=0)  # same message, old position
        self.assertEqual(q.answers[0][0], ct.REFUSED["stale"])
        self.assertGreater(len(self.bot.calls), before)

    async def test_failed_start_leaves_nothing_listening(self):
        async def boom(**kw):
            raise RuntimeError("Bad Request: chat not found")
        self.bot.send_photo = boom
        self.bot.send_document = boom
        self.deck("i")
        out = await asyncio.to_thread(self.layer.start_deck, "dk", CHAT, USER, "")
        self.assertFalse(out["ok"])
        self.key = cs.chat_key("telegram", CHAT, "")
        self.assertEqual(self.session()["status"], "stopped")
        self.assertIsNone(await self.layer.on_dispatch(event=event("hello Hermes")))

    async def test_failed_draw_after_last_tap_still_sends(self):
        await self.start("i")

        async def boom(**kw):
            raise RuntimeError("Too Many Requests: retry after 5")
        self.bot.edit_message_caption = self.bot.edit_message_media = boom
        self.bot.send_photo = self.bot.send_document = boom
        await self.press("k")
        await until(lambda: self.done)
        self.assertEqual(self.done, ["dk"])

    async def test_restart_rearms_a_deck_waiting_for_its_last_note(self):
        await self.start("i")
        await self.press("k")
        self.layer._cancel_finish(self.key)  # the old process is gone
        fresh = ct.TelegramSwipe(lambda: self.root, self.done.append, lambda k, d: d)
        fresh.finish_delay = lambda: 0.05
        fresh.factory(FakeApp(FakeBot()), None)
        await until(lambda: self.done)
        self.assertEqual(self.done, ["dk"])
        self.assertEqual(self.session()["status"], "sent")

    async def test_late_timer_does_nothing_after_a_restart_of_the_wait(self):
        await self.start("i")
        await self.press("k")
        s = self.session()
        stale_gen = self.layer._gen[self.key]
        self.layer._schedule_finish(s)  # a note restarted the wait
        await self.layer._auto_finish(self.key, s["token"], stale_gen)
        self.assertEqual(self.done, [])
        self.layer._cancel_finish(self.key)

    def test_trim_counts_like_telegram(self):
        text = "😀" * 600  # 1200 UTF-16 units
        out = ct._trim(text, 1024)
        self.assertLessEqual(ct._units(out), 1024)


class OldHermesTests(unittest.TestCase):
    def test_no_telegram_hook_means_no_chat_layer(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.dict(os.environ, {"SWIPE_ROOT": td}):
            ctx = TgCtx()
            del TgCtx.register_telegram_handler
            try:
                plugin.register(ctx)
                self.assertIsNone(plugin._chat)
                self.assertNotIn("pre_gateway_dispatch", [h[0] for h in ctx.hooks])
            finally:
                TgCtx.register_telegram_handler = lambda self, f: self.factories.append(f)
                plugin._shutdown()
                plugin._ctx = None
                plugin._chat = None


if __name__ == "__main__":
    unittest.main()
