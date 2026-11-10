"""Regression tests from the Nov 8 self-review, plus Telegram push and the media folder list.

Each test was written to fail against the code before its fix.
"""
import base64
import contextlib
import http.client
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402
from test_handlers import FakeCtx, HandlerBase, fake_hermes  # noqa: E402

plugin = H.load_plugin()
core = H.core()
srv = H.server_mod()

PNG = b"\x89PNG\r\n\x1a\n" + b"fake"
MP3 = b"ID3\x03\x00\x00\x00" + b"\x00" * 16


def _http(port, method, path, headers=None, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        hdrs = {"Host": f"127.0.0.1:{port}", **(headers or {})}
        c.request(method, path, body=body, headers=hdrs)
        r = c.getresponse()
        return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read()
    finally:
        c.close()


def _payload(deck_id, rows):
    """rows: list of (card_suffix, decision, decidedAt)."""
    return {
        "schema": "riah-swipe.results/1",
        "batchId": deck_id,
        "deckName": "Deck",
        "sentAt": "2026-11-08T12:00:00.000Z",
        "results": [{"cardId": f"{deck_id}-{i:02d}", "decision": d, "note": "", "decidedAt": at}
                    for i, d, at in rows],
    }


class CoreBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        self.root = core.ensure_root(self.tmp / "root")

    def deck(self, n=2, **kw):
        return core.build_deck(self.root, "Deck", [{"title": f"c{i}"} for i in range(n)], **kw)["deck"]["id"]


# --------------------------------------------------------------------------- B1 surface


class SurfaceTests(HandlerBase):
    def test_cli_source_counts_as_interactive(self):
        # Real Hermes CLI/TUI set HERMES_SESSION_SOURCE; HERMES_SESSION_PLATFORM is gateway-only.
        with fake_hermes(platform="", source="cli"):
            self.assertEqual(plugin._surface(), "cli")
            self.assertTrue(plugin._interactive())

    def test_ctx_session_surface_wins(self):
        self.ctx.session_surface = lambda: "telegram"
        with fake_hermes(platform="", source=""):
            self.assertEqual(plugin._surface(), "telegram")

    def test_messaging_needs_no_private_helper(self):
        # Catalog rule 9: decided from ctx.session_surface() and session env, not
        # gateway.session_context.session_is_messaging_surface (the fake leaves it set to False).
        self.ctx.session_surface = lambda: "telegram"
        with fake_hermes(platform="", source="", messaging=False):
            self.assertTrue(plugin._is_messaging())
            self.assertFalse(plugin._interactive())
        for surface in ("cli", "tui", "acp", "cron"):
            self.ctx.session_surface = lambda s=surface: s
            with fake_hermes(platform="", source="", messaging=True):
                self.assertFalse(plugin._is_messaging(), surface)
        self.ctx.session_surface = lambda: "cli"
        with fake_hermes(platform="", source="acp", messaging=True):
            self.assertTrue(plugin._interactive())


# --------------------------------------------------------------------------- B2 verdict merging


class VerdictMergeTests(CoreBase):
    def test_older_decision_never_overwrites_newer(self):
        d = self.deck()
        core.store_results(self.root, _payload(d, [(1, "keep", "2026-11-08T12:00:05.000Z")]))
        # A second device boots later and syncs what it swiped earlier.
        core.store_results(self.root, _payload(d, [(1, "discard", "2026-11-08T11:00:00.000Z")]))
        s = core.summarize(self.root, d)
        self.assertEqual(s["tally"]["keep"], 1)
        self.assertEqual(s["tally"]["discard"], 0)

    def test_version_moves_only_when_verdicts_change(self):
        d = self.deck()
        p = _payload(d, [(1, "keep", "2026-11-08T12:00:00.000Z"), (2, "keep", "2026-11-08T12:00:01.000Z")])
        core.store_results(self.root, p)
        v1 = core.summarize(self.root, d)["version"]
        core.store_results(self.root, p)  # boot re-sync of the same verdicts
        self.assertEqual(core.summarize(self.root, d)["version"], v1)
        core.store_results(self.root, _payload(d, [(2, "revise", "2026-11-08T12:01:00.000Z")]))
        self.assertGreater(core.summarize(self.root, d)["version"], v1)


class RedeliveryTests(HandlerBase):
    def test_changed_verdicts_are_handed_back_again(self):
        out = self.publish(session="s1")
        d = out["deck_id"]
        self.finish(d)
        first = plugin.on_pre_llm_call(session_id="s1")
        self.assertIn("finished", first["context"])
        self.assertIsNone(plugin.on_pre_llm_call(session_id="s1"))
        # Same verdicts re-synced: nothing new.
        self.finish(d)
        self.assertIsNone(plugin.on_pre_llm_call(session_id="s1"))
        # The person changes their mind on card 2.
        core.store_results(plugin._root(), _payload(d, [(2, "discard", "2099-01-01T00:00:00.000Z")]))
        again = plugin.on_pre_llm_call(session_id="s1")
        self.assertIsNotNone(again)
        self.assertIn("changed", again["context"])
        self.assertIn("1 discard", again["context"])


# --------------------------------------------------------------------------- B3 Range


class RangeTests(CoreBase):
    def test_bad_range_end_serves_the_whole_file(self):
        server = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(server.stop)
        port = server.ensure(port=H.free_port())["port"]
        auth = H.signin(server)
        status, hdrs, body = _http(port, "GET", "/index.html", auth)
        full = len(body)
        status, hdrs, body = _http(port, "GET", "/index.html", {**auth, "Range": "bytes=5-x"})
        self.assertEqual(status, 200)
        self.assertEqual(int(hdrs["content-length"]), full)
        self.assertEqual(len(body), full)


# --------------------------------------------------------------------------- B4 emoji


class TextCleanTests(unittest.TestCase):
    def test_emoji_joiners_survive(self):
        family = "\U0001F468‍\U0001F469‍\U0001F467"
        self.assertEqual(core.clean_text(family, 50), family)
        self.assertEqual(core.clean_text("ab‌cd", 50), "ab‌cd")  # ZWNJ (Persian, Hindi)

    def test_bidi_overrides_still_stripped(self):
        self.assertEqual(core.clean_text("a‮b​c", 50), "abc")


# --------------------------------------------------------------------------- B5 inline media cap


class InlineCapTests(CoreBase):
    def test_many_data_uris_hit_a_deck_cap(self):
        blob = "data:image/png;base64," + base64.b64encode(PNG + b"\x00" * (2_900_000)).decode()
        cards = [{"title": f"c{i}", "image": blob} for i in range(8)]  # ~31 MB inline
        with self.assertRaises(core.SwipeError):
            core.build_deck(self.root, "Big", cards)


# --------------------------------------------------------------------------- B6 settings types


class SettingTypeTests(HandlerBase):
    def _ensure_kwargs(self, config):
        self.ctx.config = config
        with mock.patch.object(srv.BoardServer, "ensure", return_value={"local_url": "x"}) as ens:
            plugin._board()
        return ens.call_args.kwargs

    def test_string_false_is_false(self):
        self.assertFalse(self._ensure_kwargs({"lan": "false"})["lan"])
        self.assertFalse(self._ensure_kwargs({"lan": "no"})["lan"])
        self.assertTrue(self._ensure_kwargs({"lan": "true"})["lan"])

    def test_bad_port_falls_back(self):
        self.assertEqual(self._ensure_kwargs({"port": "abc"})["port"], 8137)
        self.assertEqual(self._ensure_kwargs({"port": 99999})["port"], 8137)
        self.assertEqual(self._ensure_kwargs({"port": "8200"})["port"], 8200)

    def test_bad_number_args_do_not_error(self):
        out = json.loads(plugin.handle_status({"limit": "lots"}))
        self.assertTrue(out["ok"], out)
        d = self.publish()["deck_id"]
        with fake_hermes(platform="cli", interrupted=True):
            out = json.loads(plugin.handle_wait({"deck_id": d, "timeout_seconds": "soon"}))
        self.assertTrue(out["ok"], out)


class HighPortTests(CoreBase):
    def test_port_near_top_of_range_does_not_crash(self):
        server = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(server.stop)
        def fake_server(addr, handler):
            if addr[1] > 65535:  # what socket.bind does with a port past the top
                raise OverflowError("bind(): port must be 0-65535.")
            raise OSError("busy")

        with mock.patch.object(srv, "_Server", side_effect=fake_server):
            with self.assertRaises(RuntimeError):  # a clean error, not OverflowError
                server.ensure(port=65530)


# --------------------------------------------------------------------------- B7 card content


class CardContentTests(CoreBase):
    def test_poster_must_be_an_image(self):
        vid = self.tmp / "v.mp4"
        vid.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 16)
        snd = self.tmp / "s.mp3"
        snd.write_bytes(MP3)
        with self.assertRaises(core.SwipeError):
            core.build_deck(self.root, "D", [{"title": "a", "video": str(vid), "poster": str(snd)}])

    def test_empty_card_rejected(self):
        with self.assertRaises(core.SwipeError):
            core.build_deck(self.root, "D", [{"title": "ok"}, {}])

    def test_long_fields_are_capped(self):
        d = core.build_deck(self.root, "D", [{"title": "a", "text": "x" * 50_000,
                                              "caption": "c\n" * 500, "tag": "t" * 500}])
        card = d["cards"][0]
        self.assertLessEqual(len(card["preview"]), core.MAX_TEXT_CHARS)
        self.assertLessEqual(len(card["caption"]), 200)
        self.assertNotIn("\n", card["caption"])
        self.assertLessEqual(len(card["tag"]), 40)

    def test_https_url_with_fragment(self):
        d = core.build_deck(self.root, "D", [{"title": "a", "image": "https://example.com/p.png#v2"}])
        self.assertEqual(d["cards"][0]["kind"], "image")


# --------------------------------------------------------------------------- B8 deck id race


class DeckIdTests(CoreBase):
    def test_auto_id_skips_a_folder_another_publish_is_filling(self):
        with mock.patch.object(core.time, "strftime", return_value="20261108-120000"):
            busy = "deck-20261108-120000"
            (self.root / "decks" / busy).mkdir()  # mid-copy: folder exists, deck file not yet
            d = self.deck()
        self.assertNotEqual(d, busy)


# --------------------------------------------------------------------------- B9 small ones


class PairHeadTests(CoreBase):
    def test_head_does_not_use_up_the_code(self):
        server = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(server.stop)
        port = server.ensure(port=H.free_port(), lan=True, bind="127.0.0.1")["port"]
        code = server.mint_pair_code()
        _http(port, "HEAD", f"/pair?c={code}")
        status, hdrs, _ = _http(port, "GET", f"/pair?c={code}")
        self.assertEqual(status, 302)


class DeckLockTests(CoreBase):
    def test_bogus_batch_ids_make_no_locks(self):
        server = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(server.stop)
        port = server.ensure(port=H.free_port())["port"]
        auth = H.signin(server)
        for i in range(20):
            body = json.dumps({"schema": "riah-swipe.results/1", "batchId": f"nope-{i}", "results": []})
            status, _, _ = _http(port, "POST", "/api/swipe-results", {**auth, "content-type": "application/json"},
                                 body.encode())
            self.assertEqual(status, 400)
        self.assertEqual(len(server._httpd.RequestHandlerClass.locks), 0)


class PublishWordingTests(HandlerBase):
    def test_lan_on_but_no_pair_link(self):
        with fake_hermes(platform="telegram", messaging=True, key="k"):
            with mock.patch.object(plugin, "_board", return_value={"lan": True, "local_url": "http://127.0.0.1:1/"}):
                out = self.publish()
        self.assertNotIn("turn on the lan setting", out["tell_the_person"])
        self.assertIn("pairing link", out["tell_the_person"])


# --------------------------------------------------------------------------- (a) Telegram push


class PushCtx(FakeCtx):
    def __init__(self, config=None, accept=True):
        super().__init__(config)
        self.injected = []
        self.accept = accept

    def inject_message(self, content, role="user", *, session_key=None, origin=None):
        self.injected.append({"content": content, "session_key": session_key, "origin": origin})
        return self.accept


class PushTests(HandlerBase):
    KEY = "agent:main:telegram:dm:42"

    def setUp(self):
        super().setUp()
        self.ctx = PushCtx(config={"port": H.free_port()})
        plugin.register(self.ctx)

    def _publish_from_telegram(self):
        with fake_hermes(platform="telegram", messaging=True, key=self.KEY):
            return self.publish(session="tg1")["deck_id"]

    def _post(self, deck_id, decisions):
        server = plugin._server_for(plugin._root())
        port = server.info["port"]
        ids = [f"{deck_id}-{i:02d}" for i in range(1, len(decisions) + 1)]
        body = json.dumps(H.results_payload(deck_id, ids, decisions)).encode()
        status, _, _ = _http(port, "POST", "/api/swipe-results",
                             {**H.signin(server), "content-type": "application/json"}, body)
        self.assertEqual(status, 200)

    def _wait_injected(self, n=1):
        end = time.time() + 3
        while time.time() < end and len(self.ctx.injected) < n:
            time.sleep(0.05)
        return self.ctx.injected

    def test_finished_deck_is_pushed_to_the_chat_once(self):
        d = self._publish_from_telegram()
        self._post(d, ["keep", "revise"])
        got = self._wait_injected()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["session_key"], self.KEY)
        self.assertIn(plugin.BRIEF_HEADER, got[0]["content"])
        self.assertIn("1 keep, 1 revise", got[0]["content"])
        self.assertTrue(self.ledger()[d]["delivered"])
        self._post(d, ["keep", "revise"])  # boot re-sync: no second push
        time.sleep(0.3)
        self.assertEqual(len(self.ctx.injected), 1)
        with fake_hermes(platform="telegram", messaging=True, key=self.KEY):
            self.assertIsNone(plugin.on_pre_llm_call(session_id="tg1"))

    def test_partial_deck_is_not_pushed(self):
        d = self._publish_from_telegram()
        port = plugin._server_for(plugin._root()).info["port"]
        body = json.dumps(H.results_payload(d, [f"{d}-01"], ["keep"])).encode()
        _http(port, "POST", "/api/swipe-results", {"content-type": "application/json"}, body)
        time.sleep(0.3)
        self.assertEqual(self.ctx.injected, [])

    def test_refused_push_falls_back_to_next_message(self):
        self.ctx.accept = False  # allow_gateway_injection is off
        d = self._publish_from_telegram()
        self._post(d, ["keep", "keep"])
        self.assertEqual(len(self._wait_injected()), 1)
        end = time.time() + 3  # the rollback is written just after inject_message returns
        while time.time() < end and self.ledger()[d]["delivered"]:
            time.sleep(0.05)
        self.assertFalse(self.ledger()[d]["delivered"])
        with fake_hermes(platform="telegram", messaging=True, key=self.KEY):
            out = plugin.on_pre_llm_call(session_id="tg1")
        self.assertIsNotNone(out)

    def test_cli_decks_are_never_pushed(self):
        with fake_hermes(platform="", source="cli", key="cli-key"):
            d = self.publish(session="c1")["deck_id"]
        self._post(d, ["keep", "keep"])
        time.sleep(0.3)
        self.assertEqual(self.ctx.injected, [])

    def test_deck_from_another_process_is_not_pushed(self):
        d = self._publish_from_telegram()
        plugin._ledger_update(lambda decks: decks[d].update(pid=-1))
        self._post(d, ["keep", "keep"])
        time.sleep(0.3)
        self.assertEqual(self.ctx.injected, [])


# --------------------------------------------------------------------------- (b) media folders


class MediaRootsCoreTests(CoreBase):
    def setUp(self):
        super().setUp()
        self.allowed = self.tmp / "allowed"
        self.allowed.mkdir()
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        (self.allowed / "a.png").write_bytes(PNG)
        (self.outside / "b.png").write_bytes(PNG)

    def build(self, path):
        return core.build_deck(self.root, "D", [{"title": "x", "image": str(path)}], allowed_roots=[self.allowed])

    def test_inside_is_copied(self):
        self.assertEqual(self.build(self.allowed / "a.png")["cards"][0]["kind"], "image")

    def test_outside_is_refused_with_a_hint(self):
        with self.assertRaises(core.SwipeError) as e:
            self.build(self.outside / "b.png")
        self.assertIn("media_dirs", str(e.exception))

    def test_dotdot_escape_is_refused(self):
        with self.assertRaises(core.SwipeError):
            self.build(self.allowed / ".." / "outside" / "b.png")

    def test_missing_outside_file_says_outside_not_missing(self):
        with self.assertRaises(core.SwipeError) as e:
            self.build(self.outside / "nope.png")
        self.assertIn("media_dirs", str(e.exception))


class MediaRootsPluginTests(HandlerBase):
    def test_setting_adds_folders(self):
        a, b = self.tmp / "m1", self.tmp / "m2"
        self.ctx.config["media_dirs"] = f"{a}{os.pathsep}{b}"
        roots = [str(p) for p in plugin._media_roots()]
        self.assertIn(str(a.resolve()), roots)
        self.assertIn(str(b.resolve()), roots)
        self.ctx.config["media_dirs"] = [str(a)]
        self.assertIn(str(a.resolve()), [str(p) for p in plugin._media_roots()])

    def test_real_temp_folder_is_a_root_when_hermes_moves_tmpdir(self):
        # Hermes points TMPDIR/TMP/TEMP at its own scratch folder in every process.
        scratch = (self.tmp / "scratch").resolve()
        scratch.mkdir()
        old = tempfile.tempdir
        tempfile.tempdir = str(scratch)
        self.addCleanup(lambda: setattr(tempfile, "tempdir", old))
        roots = plugin._media_roots()
        self.assertIn(scratch, roots)
        if os.name == "nt":
            real = Path(os.environ["LOCALAPPDATA"]) / "Temp"
        else:
            real = Path("/tmp")
        self.assertIn(real.resolve(), roots)

    def test_refusal_names_a_folder_that_works(self):
        far = Path(tempfile.mkdtemp(dir=str(Path.home())))
        self.addCleanup(lambda: __import__("shutil").rmtree(far, ignore_errors=True))
        (far / "x.png").write_bytes(PNG)
        work = (self.tmp / "work2").resolve()
        work.mkdir()
        self.ctx.session_cwd = lambda: str(work)
        out = json.loads(plugin.handle_publish({"title": "T", "cards": [{"title": "a", "image": str(far / "x.png")}]}))
        self.assertFalse(out["ok"])
        self.assertIn(str(work), out["error"])

    def test_home_folder_is_not_a_default_root(self):
        home = Path.home().resolve()
        self.ctx.session_cwd = lambda: str(home)
        self.assertNotIn(home, plugin._media_roots())

    def test_session_cwd_is_a_root(self):
        work = (self.tmp / "work").resolve()
        work.mkdir()
        self.ctx.session_cwd = lambda: str(work)
        self.assertIn(work, plugin._media_roots())

    def test_publish_refuses_a_file_outside(self):
        far = Path(tempfile.mkdtemp(dir=str(Path.home())))  # not temp, not cwd
        self.addCleanup(lambda: __import__("shutil").rmtree(far, ignore_errors=True))
        (far / "x.png").write_bytes(PNG)
        self.ctx.session_cwd = lambda: str(self.tmp)
        out = json.loads(plugin.handle_publish({"title": "T", "cards": [{"title": "a", "image": str(far / "x.png")}]}))
        self.assertFalse(out["ok"])
        self.assertIn("media_dirs", out["error"])


if __name__ == "__main__":
    unittest.main()
