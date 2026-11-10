"""The day-to-day habits the plugin is built around: several decks in a row, redo rounds that
show the person's own note, spoken notes that are never lost, and a card that still shows up
when its file won't load."""
import asyncio
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402
import test_chat_telegram as T  # noqa: E402
import test_handlers as TH  # noqa: E402

plugin = H.load_plugin()
core = H.core()
cs = sys.modules[H.PKG + ".chat_swipe"]
ct = T.ct

USER = "42"


def ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        self.root = core.ensure_root(self.tmp / "data")

    def deck(self, n=3, deck_id="dk", **kw):
        return core.build_deck(self.root, "Shirts", [{"title": f"Shirt {i}", "text": f"t{i}"}
                                                    for i in range(1, n + 1)], deck_id=deck_id, **kw)

    def open(self, n=3, deck_id="dk"):
        self.deck(n, deck_id)
        s = cs.open_session(self.root, deck_id, "telegram", "100", USER)
        cs.set_message(self.root, s["key"], s["token"], 555, "text")
        return cs.get(self.root, s["key"])

    def tap(self, s, action):
        cur = cs.get(self.root, s["key"])
        return cs.tap(self.root, s["key"], s["token"], cur["pos"], action, USER, 555)

    def verdicts(self, deck_id="dk"):
        return {v["cardId"]: v for v in core.read_verdicts(self.root, deck_id).get("verdicts") or []}


class RedoRoundTests(Base):
    def test_a_redo_deck_is_the_next_round_and_shows_what_was_said(self):
        self.deck(2)
        core.set_verdict(self.root, "dk", "dk-02", "revise", "make the hat red")
        built = core.build_deck(self.root, "Shirts", [{"title": "Hat again", "text": "x", "replaces": "2"},
                                                     {"title": "Bonus", "text": "y"}],
                                deck_id="dk-r2", redo_of="dk")
        deck, cards = built["deck"], built["cards"]
        self.assertEqual((deck["redoOf"], deck["round"]), ("dk", 2))
        self.assertTrue(deck["name"].endswith("round 2"), deck["name"])
        self.assertEqual(cards[0]["meta"]["replaces"], "dk-02")
        self.assertEqual(cards[0]["meta"]["fixNote"], "make the hat red")
        self.assertEqual(cards[0]["caption"], "You said: “make the hat red”")
        self.assertEqual(cards[0]["tag"], "round 2")
        self.assertNotIn("replaces", cards[1]["meta"])  # a new idea in the same round
        self.assertEqual(cards[1]["meta"]["round"], 2)
        s = core.summarize(self.root, "dk-r2")
        self.assertEqual((s["redo_of"], s["round"]), ("dk", 2))

    def test_rounds_keep_counting_and_replaces_takes_a_card_id(self):
        self.deck(1)
        core.build_deck(self.root, "Shirts", [{"title": "a", "text": "x"}], deck_id="r2", redo_of="dk")
        built = core.build_deck(self.root, "Shirts", [{"title": "b", "text": "x", "replaces": "r2-01"}],
                                deck_id="r3", redo_of="r2")
        self.assertEqual(built["deck"]["round"], 3)
        self.assertEqual(built["cards"][0]["meta"]["replaces"], "r2-01")

    def test_an_unknown_earlier_deck_still_publishes(self):
        built = self.deck(1, redo_of="nope")
        self.assertIn("redo_of_ignored", built)
        self.assertNotIn("redoOf", built["deck"])

    def test_a_card_that_replaces_nothing_real_gets_no_note(self):
        self.deck(1)
        built = core.build_deck(self.root, "Shirts", [{"title": "a", "text": "x", "replaces": "9"}],
                                deck_id="r2", redo_of="dk")
        self.assertNotIn("replaces", built["cards"][0]["meta"])


class SummaryTests(Base):
    def test_notes_come_back_in_swipe_order_with_how_to_read_them(self):
        self.deck(3)
        core.set_verdict(self.root, "dk", "dk-02", "discard", "none of these feel like summer")
        core.set_verdict(self.root, "dk", "dk-01", "revise", "bigger text")
        core.set_verdict(self.root, "dk", "dk-03", "keep")
        s = core.summarize(self.root, "dk")
        self.assertEqual([n["card_id"] for n in s["notes"]], ["dk-02", "dk-01"])
        self.assertIn("whole batch", s["about_notes"])
        self.assertIn("redo_of", s["next_step"])
        self.assertEqual([e["number"] for e in s["revise"]], [1])
        line = core.brief_line(s)
        self.assertIn('Discarded "Shirt 2", note "none of these feel like summer".', line)
        self.assertIn('Revise "Shirt 1", note "bigger text".', line)
        self.assertIn('redo_of "dk"', line)
        self.assertNotIn('Kept "Shirt 3", note', line)

    def test_nothing_kept_points_to_a_fresh_batch(self):
        self.deck(2)
        for c in ("dk-01", "dk-02"):
            core.set_verdict(self.root, "dk", c, "discard")
        s = core.summarize(self.root, "dk")
        self.assertIn("Nothing was kept", s["next_step"])
        self.assertIn('redo_of "dk"', core.brief_line(s))

    def test_a_clean_keep_deck_asks_for_nothing_more(self):
        self.deck(2)
        for c in ("dk-01", "dk-02"):
            core.set_verdict(self.root, "dk", c, "keep")
        s = core.summarize(self.root, "dk")
        self.assertNotIn("next_step", s)
        self.assertNotIn("notes", s)
        self.assertNotIn("redo_of", core.brief_line(s))

    def test_a_long_spoken_note_is_kept_whole(self):
        self.deck(1)
        said = "word " * 300  # about 1,500 characters: a long voice note
        core.set_verdict(self.root, "dk", "dk-01", "revise", said)
        note = core.summarize(self.root, "dk")["revise"][0]["note"]
        self.assertGreater(len(note), 1400)
        self.assertLess(len(core.brief_line(core.summarize(self.root, "dk"))), 900)  # the brief stays brief


class SafetyTests(Base):
    def test_undo_in_the_chat_is_not_brought_back_by_an_older_board_copy(self):
        self.deck(2)
        core.store_results(self.root, H.results_payload("dk", ["dk-01", "dk-02"]))  # decided long ago
        core.set_verdict(self.root, "dk", "dk-01", None)  # Undo
        core.store_results(self.root, H.results_payload("dk", ["dk-01", "dk-02"]))  # the board re-sends
        self.assertEqual(sorted(self.verdicts()), ["dk-02"])
        fresh = H.results_payload("dk", ["dk-01"], ["discard"])
        fresh["results"][0]["decidedAt"] = (datetime.now(timezone.utc) + timedelta(seconds=5)).isoformat()
        core.store_results(self.root, fresh)  # a real new swipe still counts
        self.assertEqual(self.verdicts()["dk-01"]["decision"], "discard")

    def test_a_locked_file_is_never_overwritten_with_an_empty_one(self):
        path = self.tmp / "x.json"
        path.write_text(json.dumps({"a": 1}), encoding="utf-8")
        with mock.patch("builtins.open", side_effect=PermissionError("locked")), \
                mock.patch("time.sleep"):
            self.assertEqual(core.read_json(path, {"empty": True}), {"empty": True})
            with self.assertRaises(core.SwipeError):
                core.read_json(path, {}, strict=True)
        self.assertEqual(core.read_json(self.tmp / "missing.json", {}, strict=True), {})


class QueueTests(Base):
    def test_a_second_deck_waits_in_line(self):
        s = self.open()
        self.deck(2, "dk2")
        out = cs.open_session(self.root, "dk2", "telegram", "100", USER)
        self.assertEqual(out["queued"], 1)
        self.assertEqual(out["session"]["deck_id"], "dk")
        self.deck(2, "dk3")
        self.assertEqual(cs.open_session(self.root, "dk3", "telegram", "100", USER)["queued"], 2)
        self.assertEqual(cs.open_session(self.root, "dk2", "telegram", "100", USER)["queued"], 1)  # not twice
        cur = cs.get(self.root, s["key"])
        self.assertEqual([e["deck"] for e in cur["queue"]], ["dk2", "dk3"])
        self.assertEqual(cur["token"], s["token"])  # the buttons on screen still work
        self.assertIn("2 more decks after this", cs.view(self.root, cur)["caption"])

    def test_the_next_deck_is_handed_out_once_after_send(self):
        s = self.open(n=1)
        self.deck(1, "dk2")
        self.deck(1, "dk3")
        cs.open_session(self.root, "dk2", "telegram", "100", USER)
        cs.open_session(self.root, "dk3", "telegram", "100", USER)
        self.assertIsNone(cs.take_next(self.root, s["key"], s["token"]))  # still swiping
        self.tap(s, "k")
        self.tap(s, "s")
        nxt = cs.take_next(self.root, s["key"], s["token"])
        self.assertEqual((nxt["deck"], [e["deck"] for e in nxt["rest"]]), ("dk2", ["dk3"]))
        self.assertIsNone(cs.take_next(self.root, s["key"], s["token"]))
        opened = cs.open_session(self.root, "dk2", "telegram", "100", USER, queue=nxt["rest"])
        self.assertNotIn("queued", opened)
        self.assertEqual([e["deck"] for e in opened["queue"]], ["dk3"])

    def test_a_deck_left_open_gives_way(self):
        s = self.open()
        self.deck(1, "dk2")
        cs.open_session(self.root, "dk2", "telegram", "100", USER)

        def age(chats):
            chats[s["key"]]["tapped"] = chats[s["key"]]["touched"] = ago(minutes=cs.NOTE_WINDOW_MINUTES + 1)
        cs._update(self.root, age)
        self.deck(1, "dk3")
        out = cs.open_session(self.root, "dk3", "telegram", "100", USER)
        self.assertNotIn("queued", out)
        self.assertEqual(out["replaced"]["deck_id"], "dk")
        self.assertEqual([e["deck"] for e in out["queue"]], ["dk2"])  # the line carries over

    def test_stop_drops_the_line_and_says_so(self):
        s = self.open()
        self.deck(1, "dk2")
        cs.open_session(self.root, "dk2", "telegram", "100", USER)
        stopped = cs.stop(self.root, s["key"])
        self.assertEqual((stopped["dropped"], stopped["queue"]), (1, []))
        self.assertIn("1 more deck that was next in line", cs.view(self.root, stopped)["caption"])
        self.assertIsNone(cs.take_next(self.root, s["key"], s["token"]))

    def test_still_open(self):
        self.open(n=2)
        self.assertTrue(cs.still_open(self.root, "dk"))
        core.set_verdict(self.root, "dk", "dk-01", "keep")
        core.set_verdict(self.root, "dk", "dk-02", "keep")
        self.assertFalse(cs.still_open(self.root, "dk"))
        self.assertFalse(cs.still_open(self.root, "nope"))


class NoteTests(Base):
    def test_first_card_says_notes_work_on_any_card(self):
        s = self.open()
        self.assertIn("Say or type a note on any card", cs.view(self.root, s)["caption"])
        self.tap(s, "k")
        self.assertNotIn("Say or type a note", cs.view(self.root, cs.get(self.root, s["key"]))["caption"])

    def test_a_late_note_goes_to_the_card_it_was_said_for(self):
        s = self.open()
        self.tap(s, "r")
        cur = cs.get(self.root, s["key"])
        target = cs.note_target(cur)  # a voice note starts here...
        self.assertEqual(target, "dk-01")
        self.assertTrue(cs.owes_note(self.root, cur))
        self.tap(s, "k")  # ...and the person swipes on while it's turned into text
        out = cs.add_note(self.root, s["key"], USER, "more contrast", None, target)
        self.assertEqual((out["card"], out["held"], out["heard"]), ("dk-01", False, True))
        v = self.verdicts()
        self.assertEqual(v["dk-01"]["note"], "more contrast")
        self.assertEqual(v["dk-02"]["note"], "")
        self.assertFalse(cs.owes_note(self.root, cs.get(self.root, s["key"])))

    def test_a_voice_note_with_no_words_keeps_the_clip(self):
        s = self.open()
        self.tap(s, "r")
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        out = cs.add_note(self.root, s["key"], USER, "", str(clip))
        self.assertTrue(out["ok"])
        self.assertFalse(out["heard"])
        v = self.verdicts()["dk-01"]
        self.assertEqual(v["note"], cs.UNHEARD)
        self.assertEqual(len(v["audio"]), 1)
        self.assertEqual(core.summarize(self.root, "dk")["revise"][0]["voice_clips"], v["audio"])

    def test_no_words_and_no_clip_is_not_a_note(self):
        s = self.open()
        self.tap(s, "k")
        out = cs.add_note(self.root, s["key"], USER, "", str(self.tmp / "gone.ogg"))
        self.assertEqual((out["ok"], out["reason"]), (False, "empty"))

    def test_last_card_redo_asks_what_should_change(self):
        s = self.open(n=1)
        self.tap(s, "r")
        cur = cs.get(self.root, s["key"])
        self.assertIn("Redo “Shirt 1”: say what should change, or tap Send.", cs.view(self.root, cur)["caption"])
        cs.add_note(self.root, s["key"], USER, "warmer")
        self.assertIn("Send a voice note to add", cs.view(self.root, cs.get(self.root, s["key"]))["caption"])

    def test_overdue_decks_are_found_for_a_day(self):
        s = self.open(n=1)
        self.tap(s, "k")
        self.assertEqual(cs.overdue_sessions(self.root), [])

        def age(minutes):
            def fn(chats):
                chats[s["key"]]["touched"] = ago(minutes=minutes)
            cs._update(self.root, fn)
        age(10)
        self.assertEqual([x["deck_id"] for x in cs.overdue_sessions(self.root)], ["dk"])
        age(cs.STALE_FINISH_HOURS * 60 + 5)
        self.assertEqual(cs.overdue_sessions(self.root), [])


class HandlerTests(TH.HandlerBase):
    def test_publish_passes_the_round_through(self):
        first = self.publish()
        self.finish(first["deck_id"], decisions=["keep", "revise"], note="tighter")
        out = json.loads(plugin.handle_publish(
            {"title": "Taglines", "redo_of": first["deck_id"],
             "cards": [{"title": "again", "text": "t", "replaces": "2"}]}, session_id="s1"))
        self.assertTrue(out["ok"], out)
        self.assertEqual((out["redo_of"], out["round"]), (first["deck_id"], 2))
        card = core.load_deck(plugin._root(), out["deck_id"])["cards"][0]
        self.assertEqual(card["meta"]["fixNote"], "tighter")

    def test_publish_says_when_the_earlier_deck_is_unknown(self):
        out = json.loads(plugin.handle_publish(
            {"title": "T", "redo_of": "never-was", "cards": [{"title": "a", "text": "t"}]}, session_id="s1"))
        self.assertTrue(out["ok"], out)
        self.assertIn("redo_of_ignored", out)
        self.assertNotIn("redo_of", out)


class TelegramDailyTests(T.LayerBase):
    async def open_two(self, kinds="t"):
        self.deck(kinds)
        self.deck(kinds, "dk2")
        first = await asyncio.to_thread(self.layer.start_deck, "dk", T.CHAT, T.USER, "")
        self.key = cs.chat_key("telegram", T.CHAT, "")
        second = await asyncio.to_thread(self.layer.start_deck, "dk2", T.CHAT, T.USER, "")
        return first, second

    async def test_second_deck_shows_up_after_send(self):
        self.layer.finish_delay = lambda: 5.0
        first, second = await self.open_two()
        self.assertTrue(first["ok"] and second["ok"])
        self.assertEqual(second["queued"], 1)
        self.assertEqual(self.session()["deck_id"], "dk")
        self.assertIn("1 more deck after this", self.bot.last()["text"])
        await self.press("k")
        await self.press("s")
        s = self.session()
        self.assertEqual((s["deck_id"], s["status"], s["queue"]), ("dk2", "active", []))
        self.assertEqual(self.done, ["dk"])
        self.assertEqual(self.bot.names()[-1], "send_message")  # its own message, with fresh buttons
        self.assertIn("1 of 1", self.bot.last()["text"])

    async def test_second_deck_shows_up_after_the_wait_runs_out(self):
        await self.open_two()
        await self.press("k")
        await T.until(lambda: (self.session() or {}).get("deck_id") == "dk2")
        self.assertEqual(self.done, ["dk"])

    async def test_a_deck_swiped_on_the_board_meanwhile_is_skipped(self):
        self.layer.finish_delay = lambda: 5.0
        await self.open_two()
        core.set_verdict(self.root, "dk2", "dk2-01", "keep")  # done on the board while it waited
        await self.press("k")
        await self.press("s")
        self.assertEqual((self.session()["deck_id"], self.session()["status"]), ("dk", "sent"))

    async def test_redo_on_the_last_card_waits_longer_for_the_note(self):
        self.layer.finish_delay = lambda: 5.0
        await self.start("t")
        await self.press("r")
        self.assertEqual(self.layer._finish_wait(self.session()), 5.0 * ct.REDO_WAIT_FACTOR)
        await self.layer.on_dispatch(T.event("more punch"))
        self.assertEqual(self.layer._finish_wait(self.session()), 5.0)
        self.layer.finish_delay = lambda: 200.0
        self.assertLessEqual(ct.MAX_FINISH_WAIT, cs.FINISH_WINDOW_SECONDS)

    async def test_voice_note_lands_on_its_card_even_if_swiping_goes_on(self):
        await self.start("ttt")
        await self.press("r")  # the note is for card 1
        gate = threading.Event()
        mod = types.ModuleType("tools.transcription_tools")

        def transcribe_audio(path, model=None, source=None):
            gate.wait(10)
            return {"success": True, "transcript": "make it louder"}

        mod.transcribe_audio = transcribe_audio
        tl = types.ModuleType("tools")
        tl.transcription_tools = mod
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        with mock.patch.dict(sys.modules, {"tools": tl, "tools.transcription_tools": mod}):
            task = asyncio.ensure_future(self.layer.on_dispatch(T.event(mtype="voice", media=[str(clip)])))
            await T.until(lambda: ct.LISTENING in (self.bot.last().get("text") or ""))
            self.assertEqual(self.session().get("notice"), ct.LISTENING)
            await self.press("k")  # the buttons still work while it listens
            gate.set()
            out = await task
        self.assertEqual(out["action"], "skip")
        v = self.verdicts()
        self.assertEqual(v["dk-01"]["note"], "make it louder")
        self.assertEqual(v["dk-02"]["note"], "")
        self.assertIn("Note added to “Line 1”", self.session()["notice"])

    async def test_a_voice_note_that_is_only_noise_asks_again(self):
        await self.start("t")
        await self.press("k")
        with T.fake_transcriber({"success": False}):
            out = await self.layer.on_dispatch(T.event(mtype="voice", media=[str(self.tmp / "gone.ogg")]))
        self.assertEqual(out["action"], "skip")  # no clip to keep either: say so, don't pass it on
        self.assertIn("Try again, or type it", self.session()["notice"])
        self.assertEqual(self.verdicts()["dk-01"]["note"], "")

    async def test_a_card_whose_file_will_not_load_is_shown_as_words(self):
        async def boom(**kw):
            raise RuntimeError("Bad Request: wrong file identifier/HTTP URL specified")
        self.bot.send_photo = boom
        self.bot.send_document = boom
        self.bot.edit_message_media = boom
        await self.start("it")
        kw = self.bot.last()
        self.assertEqual(self.bot.names(), ["send_message"])
        self.assertIn("Shirt 1", kw["text"])
        self.assertIn(ct.NO_MEDIA, kw["text"])
        self.assertEqual(len(kw["reply_markup"].inline_keyboard[0]), 3)  # still swipeable
        self.assertEqual(self.session()["message_kind"], "text")
        await self.press("k")
        self.assertEqual(self.verdicts()["dk-01"]["decision"], "keep")
        self.assertIn("Line 2", self.bot.last()["text"])
        await self.press("u")  # back on the broken card: no second try at the file
        self.assertIn(ct.NO_MEDIA, self.bot.last()["text"])

    async def test_a_dropped_connection_is_not_blamed_on_the_file(self):
        class TimedOut(Exception):
            pass

        async def boom(**kw):
            raise TimedOut("Timed out")
        self.bot.send_photo = boom
        self.bot.send_document = boom
        self.deck("i")
        out = await asyncio.to_thread(self.layer.start_deck, "dk", T.CHAT, T.USER, "")
        self.assertFalse(out["ok"])
        self.assertEqual(self.layer._bad_media, set())

    async def test_a_tap_that_blows_up_still_answers(self):
        await self.start("t")
        with mock.patch.object(cs, "tap", side_effect=RuntimeError("disk full")):
            q = await self.press("k")
        self.assertEqual(q.answers, [("Something went wrong. Tap again.", False)])
        q = await self.press("k")
        self.assertEqual(q.answers[0][0], "Kept")

    async def test_a_deck_whose_wait_ran_out_during_a_restart_is_still_sent(self):
        self.layer.finish_delay = lambda: 5.0
        await self.start("t")
        await self.press("k")
        self.layer._cancel_finish(self.key)  # the gateway went down mid-wait

        def age(chats):
            chats[self.key]["touched"] = ago(minutes=20)
        cs._update(self.root, age)
        self.layer._rearm()
        await T.until(lambda: self.session()["status"] == "sent")
        self.assertEqual(self.done, ["dk"])

    def said(self):
        return [str(kw.get("text") or kw.get("caption") or "") for _n, kw in self.bot.calls]

    async def test_a_remade_card_shows_what_you_said_in_the_chat(self):
        self.deck("t")
        core.set_verdict(self.root, "dk", "dk-01", "revise", "make the hat red")
        core.build_deck(self.root, "Shirts", [{"title": "Hat again", "text": "x", "replaces": "1"}],
                        deck_id="dk-r2", redo_of="dk")
        out = await asyncio.to_thread(self.layer.start_deck, "dk-r2", T.CHAT, T.USER, "")
        self.assertTrue(out["ok"], out)
        text = self.bot.last()["text"]
        self.assertIn("You said: “make the hat red”", text)
        self.assertIn("round 2", text)

    async def test_the_middle_deck_done_on_the_board_is_passed_over(self):
        self.layer.finish_delay = lambda: 5.0
        await self.open_two()
        self.deck("t", "dk3")
        third = await asyncio.to_thread(self.layer.start_deck, "dk3", T.CHAT, T.USER, "")
        self.assertEqual(third["queued"], 2)
        core.set_verdict(self.root, "dk2", "dk2-01", "keep")
        await self.press("k")
        await self.press("s")
        s = self.session()
        self.assertEqual((s["deck_id"], s["status"], s["queue"]), ("dk3", "active", []))

    async def test_finishing_on_the_board_brings_up_the_deck_that_was_waiting(self):
        self.layer.finish_delay = lambda: 5.0
        await self.open_two("tt")
        await self.press("k")
        await self.layer.on_dispatch(T.event("love this one"))  # lands on the card just kept
        await self.layer.on_dispatch(T.event("and this"))
        core.set_verdict(self.root, "dk", "dk-02", "discard")  # the last card, swiped on the board
        self.layer.board_finished("dk", True)
        await T.until(lambda: (self.session() or {}).get("deck_id") == "dk2")
        self.assertEqual(self.session()["status"], "active")
        self.assertEqual(self.done, [])  # the board already told Hermes; the chat doesn't say it twice
        self.assertTrue(any("Finished on the board." in t and "Sent to Hermes" in t for t in self.said()),
                        self.said()[-4:])
        self.assertEqual(self.verdicts()["dk-02"]["decision"], "discard")

    async def test_the_board_changing_one_card_does_not_end_the_chat_deck(self):
        await self.open_two("tt")
        core.set_verdict(self.root, "dk", "dk-02", "keep")  # one card on the board, one still open
        self.layer.board_finished("dk", False)
        await asyncio.sleep(0.2)
        s = self.session()
        self.assertEqual((s["deck_id"], s["status"], len(s["queue"])), ("dk", "active", 1))

    async def test_a_full_line_leaves_the_deck_on_the_board(self):
        with mock.patch.object(cs, "MAX_QUEUE", 1):
            first, second = await self.open_two()
            self.assertEqual(second["queued"], 1)
            self.deck("t", "dk3")
            third = await asyncio.to_thread(self.layer.start_deck, "dk3", T.CHAT, T.USER, "")
        self.assertFalse(third["ok"])
        self.assertIn("waiting", third["reason"])
        s = self.session()
        self.assertEqual((s["deck_id"], [e["deck"] for e in s["queue"]]), ("dk", ["dk2"]))
        self.assertTrue(cs.still_open(self.root, "dk3"))  # still there to swipe on the board


class BoardFinishTests(Base):
    def test_a_note_typed_before_the_board_swipe_is_kept(self):
        s = self.open(n=1)
        self.assertTrue(cs.add_note(self.root, s["key"], USER, "too busy")["held"])
        self.assertEqual(cs.close_finished(self.root, "dk"), [])  # nothing decided yet
        core.set_verdict(self.root, "dk", "dk-01", "revise", "")
        closed = cs.close_finished(self.root, "dk")
        self.assertEqual([(c["status"], c["held"]) for c in closed], [("sent", "")])
        self.assertEqual(self.verdicts()["dk-01"]["note"], "too busy")
        self.assertEqual(cs.close_finished(self.root, "dk"), [])  # once

    def test_a_deck_waiting_for_its_last_note_is_left_alone(self):
        s = self.open(n=1)
        self.tap(s, "k")
        self.assertEqual(cs.close_finished(self.root, "dk"), [])
        self.assertEqual(cs.get(self.root, s["key"])["status"], "finishing")

    def test_the_line_never_grows_past_its_limit(self):
        s = self.open()
        with mock.patch.object(cs, "MAX_QUEUE", 2):
            for i in (2, 3):
                self.deck(1, f"dk{i}")
                self.assertEqual(cs.open_session(self.root, f"dk{i}", "telegram", "100", USER)["queued"], i - 1)
            self.deck(1, "dk4")
            self.assertEqual(cs.open_session(self.root, "dk4", "telegram", "100", USER)["queued"], 0)
        self.assertEqual([e["deck"] for e in cs.get(self.root, s["key"])["queue"]], ["dk2", "dk3"])


class QueueHandlerTests(TH.HandlerBase):
    def one_card(self, chat):
        with mock.patch.object(plugin, "_start_in_chat", return_value=chat):
            return json.loads(plugin.handle_publish(
                {"title": "T", "cards": [{"title": "a", "text": "t"}]}, session_id="s1"))

    def test_publish_says_when_the_deck_is_waiting_its_turn(self):
        out = self.one_card({"ok": True, "key": "k", "queued": 2})
        self.assertTrue(out["ok"], out)
        self.assertEqual((out["in_chat"], out["queued"]), (True, 2))
        self.assertIn("next in line", out["tell_the_person"])
        self.assertIn("Don't resend", out["agent_note"])

    def test_publish_gives_the_board_link_when_the_line_is_full(self):
        out = self.one_card({"ok": False, "reason": "too many decks are already waiting in this chat"})
        self.assertTrue(out["ok"], out)
        self.assertNotIn("in_chat", out)
        self.assertIn("waiting", out["chat_swipe_unavailable"])
        self.assertIn("ready to swipe: http", out["tell_the_person"])

    def test_the_board_tells_the_chat_when_verdicts_arrive(self):
        seen = []
        fake = types.SimpleNamespace(board_finished=lambda d, delivered=False: seen.append((d, delivered)))
        with mock.patch.object(plugin, "_chat", fake):
            self.assertFalse(plugin._board_results("nope", plugin._root()))
        self.assertEqual(seen, [("nope", False)])


if __name__ == "__main__":
    unittest.main()
