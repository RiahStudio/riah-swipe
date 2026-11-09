"""Per-browser sign-in, /swipe unpair, the board CSP and the local-only /health proof.

Run from the repo root:
    python -m unittest discover -s hermes-plugin/tests -t hermes-plugin
"""
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402
from test_handlers import FakeCtx, HandlerBase, fake_hermes  # noqa: E402
from test_server import ServerBase, req  # noqa: E402

core = H.core()
srv = H.server_mod()
plugin = H.load_plugin()


class DevicesTests(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.root = Path(td.name)
        self.now = [1_000_000.0]
        self.dev = srv.Devices(self.root, clock=lambda: self.now[0])

    def test_only_a_hash_is_kept(self):
        token = self.dev.add()
        self.assertTrue(self.dev.check(token))
        raw = (self.root / "data" / "devices.json").read_text("utf-8")
        self.assertNotIn(token, raw)
        self.assertIn(hashlib.sha256(token.encode()).hexdigest(), raw)
        self.assertFalse(self.dev.check(""))
        self.assertFalse(self.dev.check(token + "x"))

    def test_tokens_expire(self):
        token = self.dev.add()
        self.now[0] += srv.COOKIE_MAX_AGE + 1
        self.assertFalse(self.dev.check(token))
        self.assertEqual(self.dev.count(), 0)

    def test_clear_reaches_other_processes(self):
        token = self.dev.add()
        other = srv.Devices(self.root, clock=lambda: self.now[0])
        self.assertTrue(other.check(token))
        self.assertEqual(self.dev.clear(), 1)
        self.assertFalse(other.check(token))  # re-read on change, no restart needed

    def test_list_is_capped(self):
        tokens = [self.dev.add() for _ in range(srv.MAX_DEVICES + 3)]
        self.assertEqual(self.dev.count(), srv.MAX_DEVICES)
        self.assertFalse(self.dev.check(tokens[0]))
        self.assertTrue(self.dev.check(tokens[-1]))


class SignInServerTests(ServerBase):
    def test_signed_out_page_and_api(self):
        st, h, body = req(self.port, "GET", "/")
        self.assertEqual(st, 401)
        self.assertIn("text/html", h["content-type"])
        self.assertIn(b"/swipe", body)
        st, h, body = req(self.port, "GET", "/decks/index.json")
        self.assertEqual(st, 401)
        self.assertIn("error", json.loads(body))

    def test_desktop_post_needs_sign_in(self):
        deck = core.build_deck(self.root, "D", ["a"], deck_id="dk")
        body = json.dumps(H.results_payload("dk", [deck["cards"][0]["id"]])).encode()
        origin = {"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"}
        st, _, _ = req(self.port, "POST", "/api/swipe-results", origin, body)
        self.assertEqual(st, 401)
        st, _, _ = self.req("POST", "/api/swipe-results", origin, body)
        self.assertEqual(st, 200)

    def test_reopened_link_when_signed_in_just_opens_the_board(self):
        link = self.bs.pair_url(local=True)
        path = link.split(f":{self.port}", 1)[1]
        st, h, _ = req(self.port, "GET", path)
        self.assertEqual(st, 302)
        cookie = {"Cookie": h["set-cookie"].split(";")[0]}
        st, h, _ = req(self.port, "GET", path, cookie)  # used link, but this browser is signed in
        self.assertEqual(st, 302)
        self.assertNotIn("set-cookie", h)
        st, _, _ = req(self.port, "GET", path)  # used link, signed-out browser
        self.assertEqual(st, 403)

    def test_unpair_signs_everyone_out(self):
        st, _, _ = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertEqual(self.bs.unpair(), 1)
        st, _, _ = self.req("GET", "/")
        self.assertEqual(st, 401)

    def test_cookie_name_differs_per_profile(self):
        other = self.tmp / "other"
        self.assertNotEqual(srv.cookie_name(self.root), srv.cookie_name(other))
        self.assertTrue(srv.cookie_name(self.root).startswith(srv.COOKIE + "_"))

    def test_health_proof_only_for_this_computer(self):
        handler = self.bs._httpd.RequestHandlerClass
        with mock.patch.object(handler, "_from_this_computer", lambda self: False):
            st, _, body = req(self.port, "GET", "/health?n=abc")
            self.assertEqual(st, 200)
            self.assertNotIn("hmac", json.loads(body))
        st, _, body = req(self.port, "GET", "/health?n=abc")
        self.assertEqual(json.loads(body)["hmac"], srv.hmac_hex(self.secret(), "abc"))


class CspTests(ServerBase):
    def test_board_csp_allows_only_its_own_scripts(self):
        _, h, _ = self.req("GET", "/")
        csp = h["content-security-policy"]
        self.assertNotIn("unsafe-inline", csp)
        self.assertIn("script-src 'self'", csp)
        page = (H.BOARD_DIR / "index.html").read_text("utf-8").replace("\r\n", "\n")
        bodies = re.findall(r"<script>(.*?)</script>", page, re.S)
        self.assertGreaterEqual(len(bodies), 1)
        for body in bodies:
            digest = base64.b64encode(hashlib.sha256(body.encode()).digest()).decode()
            self.assertIn(f"'sha256-{digest}'", csp)
        for path in ("/health", "/decks/index.json"):
            _, h, _ = self.req("GET", path)
            self.assertEqual(h["content-security-policy"], srv.CSP_DEFAULT, path)


class PluginSignInTests(HandlerBase):
    def test_board_link_signs_in_on_this_computer(self):
        info = plugin._board(pair=True)
        self.assertIn("/pair?c=", info["board_link"])
        self.assertTrue(info["board_link"].startswith(info["local_url"]))
        links = plugin._links(info)
        self.assertEqual(links["board_url"], info["board_link"])

    def test_no_phone_link_in_group_chats(self):
        self.ctx.config["lan"] = True
        with mock.patch.object(srv, "lan_ip", lambda: "192.0.2.5"):
            with fake_hermes(platform="telegram", messaging=True, key="k", chat_type="group"):
                info = plugin._board(pair=True)
                self.assertNotIn("pair_url", info)
                self.assertTrue(info["phone_withheld"])
                self.assertIn("direct message", plugin._links(info)["phone_hint"])
            plugin._shutdown()
            with fake_hermes(platform="telegram", messaging=True, key="k", chat_type="dm"):
                self.assertIn("/pair?c=", plugin._board(pair=True)["pair_url"])

    def test_swipe_unpair_command(self):
        plugin._board(pair=True)
        server = plugin._server_for(plugin._root())
        H.signin(server)
        H.signin(server)
        self.assertIn("signed out 2 browsers", plugin.cmd_swipe("unpair"))
        self.assertIn("signed out 0 browsers", plugin.cmd_swipe("unpair"))


if __name__ == "__main__":
    unittest.main()
