"""In-chat swiping engine (chat_swipe.py): taps, undo, notes, finishing. Stdlib only."""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402

H.load_plugin()
core = H.core()
cs = sys.modules[H.PKG + ".chat_swipe"]

USER = "42"


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        self.root = core.ensure_root(self.tmp / "data")

    def deck(self, n=3, deck_id="dk"):
        core.build_deck(self.root, "Shirts", [{"title": f"Shirt {i}", "text": f"t{i}"} for i in range(1, n + 1)],
                        deck_id=deck_id)
        return deck_id

    def open(self, n=3, deck_id="dk"):
        self.deck(n, deck_id)
        s = cs.open_session(self.root, deck_id, "telegram", "100", USER)
        cs.set_message(self.root, s["key"], s["token"], 555, "text")
        return cs.get(self.root, s["key"])

    def tap(self, s, action, pos=None, user=USER, message_id=555):
        cur = cs.get(self.root, s["key"])
        return cs.tap(self.root, s["key"], s["token"], cur["pos"] if pos is None else pos, action, user, message_id)

    def verdicts(self, deck_id="dk"):
        return {v["cardId"]: v for v in core.read_verdicts(self.root, deck_id).get("verdicts") or []}


class TapTests(Base):
    def test_keep_cut_redo_write_the_board_verdict_file(self):
        s = self.open()
        self.assertEqual(self.tap(s, "k")["decision"], "keep")
        self.assertEqual(self.tap(s, "c")["decision"], "discard")
        out = self.tap(s, "r")
        self.assertTrue(out["finished"])
        v = self.verdicts()
        self.assertEqual({k: x["decision"] for k, x in v.items()},
                         {"dk-01": "keep", "dk-02": "discard", "dk-03": "revise"})
        self.assertTrue(all(x["via"] == "chat" for x in v.values()))
        self.assertEqual(cs.get(self.root, s["key"])["status"], "finishing")
        self.assertTrue(core.summarize(self.root, "dk")["complete"])

    def test_double_tap_on_the_same_card_counts_once(self):
        s = self.open()
        first = self.tap(s, "k", pos=0)
        second = self.tap(s, "c", pos=0)
        self.assertTrue(first["ok"])
        self.assertEqual(second["reason"], "stale")
        self.assertEqual(self.verdicts()["dk-01"]["decision"], "keep")
        self.assertNotIn("dk-02", self.verdicts())

    def test_old_message_is_stale(self):
        s = self.open()
        self.assertEqual(self.tap(s, "k", message_id=111)["reason"], "stale")
        self.assertEqual(self.verdicts(), {})

    def test_someone_else_cannot_swipe_your_deck(self):
        s = self.open()
        out = self.tap(s, "k", user="999")
        self.assertEqual(out["reason"], "not_yours")
        self.assertEqual(self.verdicts(), {})

    def test_old_token_is_gone_after_a_new_deck_opens_in_the_chat(self):
        s = self.open()
        cs.stop(self.root, s["key"])  # a deck still being swiped would make the next one wait in line
        self.deck(2, "dk2")
        cs.open_session(self.root, "dk2", "telegram", "100", USER)
        self.assertEqual(cs.tap(self.root, s["key"], s["token"], 0, "k", USER)["reason"], "gone")

    def test_undo_across_cards(self):
        s = self.open()
        self.tap(s, "k")
        self.tap(s, "c")
        out = self.tap(s, "u")
        self.assertEqual(out["card"], "dk-02")
        self.assertEqual(out["session"]["pos"], 1)
        self.assertNotIn("dk-02", self.verdicts())
        out = self.tap(s, "u")
        self.assertEqual(out["session"]["pos"], 0)
        self.assertEqual(self.verdicts(), {})
        self.assertEqual(self.tap(s, "u")["reason"], "nothing_to_undo")

    def test_undo_from_finishing_reopens_the_last_card(self):
        s = self.open(n=1)
        self.assertTrue(self.tap(s, "k")["finished"])
        out = self.tap(s, "u")
        self.assertEqual(out["session"]["status"], "active")
        self.assertEqual(out["session"]["pos"], 0)

    def test_send_only_when_finishing(self):
        s = self.open(n=2)
        self.assertEqual(self.tap(s, "s")["reason"], "stale")
        self.tap(s, "k")
        self.tap(s, "k")
        out = self.tap(s, "s")
        self.assertEqual(out["decision"], "send")
        self.assertEqual(out["session"]["status"], "sent")
        self.assertEqual(self.tap(s, "u")["reason"], "stale")  # sent is final

    def test_cards_decided_on_the_board_are_skipped(self):
        s = self.open(n=3)
        core.set_verdict(self.root, "dk", "dk-02", "keep", "from the board", via="board")
        self.tap(s, "c")
        self.assertEqual(cs.get(self.root, s["key"])["pos"], 2)
        self.assertEqual(self.verdicts()["dk-02"]["note"], "from the board")

    def test_open_skips_cards_already_decided(self):
        self.deck(2)
        core.set_verdict(self.root, "dk", "dk-01", "keep")
        core.set_verdict(self.root, "dk", "dk-02", "keep")
        s = cs.open_session(self.root, "dk", "telegram", "100", USER)
        self.assertEqual(s["status"], "finishing")

    def test_thirty_card_deck(self):
        s = self.open(n=30)
        for i in range(30):
            out = self.tap(s, "kcr"[i % 3])
            self.assertTrue(out["ok"], out)
        self.assertTrue(out["finished"])
        self.assertEqual(len(self.verdicts()), 30)

    def test_unknown_action_is_refused(self):
        s = self.open()
        self.assertFalse(self.tap(s, "x")["ok"])


class NoteTests(Base):
    def test_note_after_keep_lands_on_that_card(self):
        s = self.open()
        self.tap(s, "k")
        out = cs.add_note(self.root, s["key"], USER, "love the colours")
        self.assertTrue(out["ok"])
        self.assertFalse(out["held"])
        self.assertEqual(out["title"], "Shirt 1")
        v = self.verdicts()["dk-01"]
        self.assertEqual((v["decision"], v["note"]), ("keep", "love the colours"))

    def test_note_after_cut_and_two_notes_join(self):
        s = self.open()
        self.tap(s, "c")
        cs.add_note(self.root, s["key"], USER, "too busy")
        cs.add_note(self.root, s["key"], USER, "font is hard to read")
        self.assertEqual(self.verdicts()["dk-01"]["note"], "too busy / font is hard to read")

    def test_note_after_redo(self):
        s = self.open()
        self.tap(s, "r")
        cs.add_note(self.root, s["key"], USER, "bigger mullet")
        v = self.verdicts()["dk-01"]
        self.assertEqual((v["decision"], v["note"]), ("revise", "bigger mullet"))

    def test_note_before_first_tap_is_held_for_the_card_on_screen(self):
        s = self.open()
        out = cs.add_note(self.root, s["key"], USER, "this one is close")
        self.assertTrue(out["held"])
        self.assertEqual(self.verdicts(), {})
        self.tap(s, "k")
        self.assertEqual(self.verdicts()["dk-01"]["note"], "this one is close")
        self.assertEqual(cs.get(self.root, s["key"])["held"], "")

    def test_undo_restores_the_note_and_new_note_goes_to_the_card_on_screen(self):
        s = self.open()
        self.tap(s, "c")
        cs.add_note(self.root, s["key"], USER, "too busy")
        self.tap(s, "u")
        cur = cs.get(self.root, s["key"])
        self.assertEqual(cur["held"], "too busy")
        out = cs.add_note(self.root, s["key"], USER, "actually fine")
        self.assertTrue(out["held"])
        self.tap(s, "k")
        v = self.verdicts()["dk-01"]
        self.assertEqual((v["decision"], v["note"]), ("keep", "too busy / actually fine"))

    def test_note_from_someone_else_is_ignored(self):
        s = self.open()
        self.tap(s, "k")
        self.assertFalse(cs.add_note(self.root, s["key"], "999", "nope")["ok"])
        self.assertFalse(cs.wants_note(cs.get(self.root, s["key"]), "999"))
        self.assertEqual(self.verdicts()["dk-01"]["note"], "")

    def test_note_window_closes(self):
        s = self.open()
        cur = cs.get(self.root, s["key"])
        self.assertTrue(cs.wants_note(cur, USER))
        cur["tapped"] = (datetime.now(timezone.utc) - timedelta(minutes=31)).isoformat()
        cur["touched"] = datetime.now(timezone.utc).isoformat()  # a recent note doesn't keep it open
        self.assertFalse(cs.wants_note(cur, USER))

    def test_no_known_swiper_takes_no_notes_or_taps(self):
        s = cs.open_session(self.root, self.deck(), "telegram", "100", "")
        self.assertFalse(cs.wants_note(cs.get(self.root, s["key"]), "123"))
        out = cs.tap(self.root, s["key"], s["token"], 0, "k", "123")
        self.assertEqual(out["reason"], "not_yours")

    def test_general_topic_key_matches(self):
        self.assertEqual(cs.chat_key("telegram", "-100", "1"), cs.chat_key("telegram", "-100", ""))
        self.assertNotEqual(cs.chat_key("telegram", "-100", "7"), cs.chat_key("telegram", "-100", ""))

    def test_finishing_expires(self):
        s = self.open(n=1)
        self.tap(s, "k")
        self.assertIn("dk", cs.finishing_decks(self.root))

        def age(chats):
            chats[s["key"]]["touched"] = (datetime.now(timezone.utc) - timedelta(minutes=7)).isoformat()
        cs._update(self.root, age)
        self.assertNotIn("dk", cs.finishing_decks(self.root))
        self.assertFalse(cs.wants_note(cs.get(self.root, s["key"]), USER))

    def test_no_notes_after_sent_or_stopped(self):
        s = self.open(n=1)
        self.tap(s, "k")
        self.assertTrue(cs.wants_note(cs.get(self.root, s["key"]), USER))  # grace window
        cs.finish(self.root, s["key"], s["token"])
        self.assertFalse(cs.wants_note(cs.get(self.root, s["key"]), USER))
        s2 = self.open(n=2, deck_id="dk2")
        cs.stop(self.root, s2["key"])
        self.assertFalse(cs.wants_note(cs.get(self.root, s2["key"]), USER))

    def test_voice_clip_is_kept_with_the_verdict(self):
        s = self.open()
        self.tap(s, "r")
        clip = self.tmp / "voice.ogg"
        clip.write_bytes(b"OggS fake")
        cs.add_note(self.root, s["key"], USER, "bigger mullet", str(clip))
        v = self.verdicts()["dk-01"]
        self.assertEqual(len(v["audio"]), 1)
        self.assertTrue((self.root / v["audio"][0]).is_file())
        self.assertTrue(v["audio"][0].startswith("data/chat-notes/dk/"))

    def test_odd_audio_files_are_not_copied(self):
        s = self.open()
        self.tap(s, "r")
        bad = self.tmp / "evil.exe"
        bad.write_bytes(b"MZ")
        cs.add_note(self.root, s["key"], USER, "x", str(bad))
        self.assertNotIn("audio", self.verdicts()["dk-01"])

    def test_held_voice_clip_follows_the_tap(self):
        s = self.open()
        clip = self.tmp / "v.ogg"
        clip.write_bytes(b"OggS")
        cs.add_note(self.root, s["key"], USER, "nice", str(clip))
        self.tap(s, "k")
        self.assertEqual(len(self.verdicts()["dk-01"]["audio"]), 1)


class FinishAndViewTests(Base):
    def test_finish_runs_once(self):
        s = self.open(n=1)
        self.tap(s, "k")
        self.assertIsNotNone(cs.finish(self.root, s["key"], s["token"]))
        self.assertIsNone(cs.finish(self.root, s["key"], s["token"]))

    def test_finishing_decks(self):
        s = self.open(n=1)
        self.assertEqual(cs.finishing_decks(self.root), set())
        self.tap(s, "k")
        self.assertEqual(cs.finishing_decks(self.root), {"dk"})
        cs.finish(self.root, s["key"], s["token"])
        self.assertEqual(cs.finishing_decks(self.root), set())

    def test_view_buttons_and_lines(self):
        s = self.open(n=2)
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertEqual([a for _, a in v["buttons"][0]], ["k", "c", "r"])
        self.assertEqual(len(v["buttons"]), 1)  # no Undo before the first tap
        self.assertIn("1 of 2", v["caption"])
        self.tap(s, "r")
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertIn("Redo “Shirt 1”: what should change?", v["caption"])
        self.assertEqual(v["buttons"][1], [("↶ Undo", "u")])
        cs.add_note(self.root, s["key"], USER, "bigger")
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertIn("Redo “Shirt 1”. A voice note adds why.", v["caption"])
        self.tap(s, "k")
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertIn("All 2 swiped: 1 keep, 1 redo, 0 cut.", v["caption"])
        self.assertEqual([a for _, a in v["buttons"][0]], ["u", "s"])
        cs.finish(self.root, s["key"], s["token"])
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertIn("Sent to Hermes", v["caption"])
        self.assertEqual(v["buttons"], [])

    def test_held_note_shows_on_the_card(self):
        s = self.open()
        cs.add_note(self.root, s["key"], USER, "close one")
        v = cs.view(self.root, cs.get(self.root, s["key"]))
        self.assertIn("Note for this one: “close one”", v["caption"])

    def test_media_of_stays_inside_decks(self):
        self.assertEqual(cs.media_of(self.root, {"kind": "image", "media": "../../etc/passwd"}), (None, None))
        self.assertEqual(cs.media_of(self.root, {"kind": "image", "media": "https://x.test/a.png"}),
                         ("image", "https://x.test/a.png"))
        self.assertEqual(cs.media_of(self.root, {"kind": "text", "media": "decks/x.png"}), (None, None))

    def test_session_cap(self):
        self.deck(1)
        for i in range(cs.MAX_SESSIONS + 5):
            cs.open_session(self.root, "dk", "telegram", str(i), USER)
        self.assertEqual(len(cs._load(self.root)["chats"]), cs.MAX_SESSIONS)


if __name__ == "__main__":
    unittest.main()
