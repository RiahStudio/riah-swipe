"""Tests for swipe_server (loopback sockets only).

Run from the repo root:
    python -m unittest discover -s hermes-plugin/tests -t hermes-plugin
"""
import contextlib
import http.client
import http.server
import io
import json
import os
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402

core = H.core()
srv = H.server_mod()

MP4 = b"\x00\x00\x00\x18ftypmp42" + bytes(range(100))
PNG = b"\x89PNG\r\n\x1a\n" + b"fake"


def req(port, method, path, headers=None, body=None, host=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        c.putrequest(method, path, skip_host=True)
        c.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
        for k, v in (headers or {}).items():
            c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders(body)
        r = c.getresponse()
        data = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data
    finally:
        c.close()


class ServerBase(unittest.TestCase):
    lan = False

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = Path(self._td.name)
        self.root = self.tmp / "root"
        if self.lan:  # make test clients look like phones, and give the phone a fixed address
            for p in (mock.patch.object(srv, "LOOPBACK", set()),
                      mock.patch.object(srv, "lan_ip", lambda: "192.0.2.5")):
                p.start()
                self.addCleanup(p.stop)
        self.bs = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(self.bs.stop)
        self.info = self.bs.ensure(port=H.free_port(), lan=self.lan)
        self.port = self.info["port"]
        self.root = self.bs.root

    def secret(self):
        return json.loads((self.root / "data" / "server.json").read_text("utf-8"))["secret"]

    def auth(self):
        if not hasattr(self, "_auth"):
            self._auth = H.signin(self.bs)
        return self._auth

    def req(self, method, path, headers=None, body=None, host=None):
        """A request from a browser that already signed in."""
        return req(self.port, method, path, {**self.auth(), **(headers or {})}, body, host)


class LocalServerTests(ServerBase):
    def make_deck(self):
        v = self.tmp / "clip.mp4"
        v.write_bytes(MP4)
        return core.build_deck(self.root, "Vids", [{"title": "v", "video": str(v)}, {"title": "t", "text": "x"}],
                               deck_id="dk")

    def test_health(self):
        st, _, body = self.req("GET", "/health")
        d = json.loads(body)
        self.assertEqual(st, 200)
        self.assertEqual(d["app"], "riah-swipe")
        self.assertFalse(d["lan"])
        self.assertNotIn("token", d)
        self.assertNotIn("hmac", d)

    def test_health_hmac_proof(self):
        st, _, body = self.req("GET", "/health?n=abc123")
        self.assertEqual(json.loads(body)["hmac"], srv.hmac_hex(self.secret(), "abc123"))

    def test_index_html(self):
        st, h, body = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn("text/html", h["content-type"])
        self.assertEqual(body, (H.BOARD_DIR / "index.html").read_bytes())

    def test_security_headers_everywhere(self):
        for path in ("/", "/health", "/decks/index.json", "/nope"):
            _, h, _ = self.req("GET", path)
            self.assertEqual(h["x-content-type-options"], "nosniff", path)
            self.assertEqual(h["x-frame-options"], "DENY", path)
            self.assertEqual(h["referrer-policy"], "no-referrer", path)
            want = srv.board_csp(H.BOARD_DIR) if path == "/" else srv.CSP_DEFAULT
            self.assertEqual(h["content-security-policy"], want, path)

    def test_media_is_sandboxed(self):
        self.make_deck()
        st, h, _ = self.req("GET", "/decks/dk/01.mp4")
        self.assertEqual(st, 200)
        self.assertEqual(h["content-security-policy"], "sandbox; default-src 'none'; frame-ancestors 'none'")
        self.assertEqual(h["x-content-type-options"], "nosniff")
        _, h, _ = self.req("GET", "/")
        self.assertEqual(h["content-security-policy"], srv.board_csp(H.BOARD_DIR))

    def test_deck_index_and_file(self):
        self.make_deck()
        st, _, body = self.req("GET", "/decks/index.json")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body), {"batches": ["dk.swipe.json"]})
        st, _, body = self.req("GET", "/decks/dk.swipe.json")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)["decks"][0]["id"], "dk")

    def test_range_206(self):
        self.make_deck()
        n = len(MP4)
        st, h, body = self.req("GET", "/decks/dk/01.mp4", {"Range": "bytes=10-19"})
        self.assertEqual(st, 206)
        self.assertEqual(body, MP4[10:20])
        self.assertEqual(h["content-range"], f"bytes 10-19/{n}")
        st, _, body = self.req("GET", "/decks/dk/01.mp4", {"Range": "bytes=-5"})
        self.assertEqual((st, body), (206, MP4[-5:]))
        st, _, _ = self.req("GET", "/decks/dk/01.mp4", {"Range": "bytes=500-600"})
        self.assertEqual(st, 416)
        st, _, body = self.req("GET", "/decks/dk/01.mp4")
        self.assertEqual((st, len(body)), (200, n))

    def test_traversal_blocked(self):
        secret = (H.PLUGIN_DIR / "plugin.yaml").read_bytes()
        for p in ("/../plugin.yaml", "/%2e%2e/plugin.yaml", "/decks/../../plugin.yaml",
                  "/decks/%2e%2e/%2e%2e/plugin.yaml", "/..%2fplugin.yaml", "/decks/..%5c..%5cplugin.yaml"):
            st, _, body = self.req("GET", p)
            self.assertIn(st, (400, 403, 404), p)
            self.assertNotEqual(body, secret, p)

    def test_server_json_not_served(self):
        for p in ("/data/server.json", "/decks/../data/server.json", "/decks/%2e%2e/data/server.json"):
            st, _, body = self.req("GET", p)
            self.assertNotIn(self.secret().encode(), body, p)

    def test_wrong_host_421(self):
        st, _, _ = self.req("GET", "/", host="evil.example.com")
        self.assertEqual(st, 421)
        st, _, _ = self.req("GET", "/health", host="evil.example.com:80")
        self.assertEqual(st, 421)
        st, _, _ = self.req("GET", "/", host=f"localhost:{self.port}")
        self.assertEqual(st, 200)

    def test_post_results_same_origin(self):
        deck = core.build_deck(self.root, "D", ["a", "b"], deck_id="dk")
        ids = [c["id"] for c in deck["cards"]]
        body = json.dumps(H.results_payload("dk", ids, ["keep", "revise"])).encode()
        st, _, out = self.req("POST", "/api/swipe-results",
                         {"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"}, body)
        self.assertEqual(st, 200, out)
        self.assertEqual(json.loads(out)["decided"], 2)
        st, _, out = self.req("GET", "/api/verdicts/dk")
        self.assertEqual(st, 200)
        self.assertEqual(len(json.loads(out)["verdicts"]), 2)
        self.assertTrue(core.summarize(self.root, "dk")["complete"])

    def test_post_unknown_card_rejected(self):
        core.build_deck(self.root, "D", ["a"], deck_id="dk")
        body = json.dumps(H.results_payload("dk", ["dk-01", "forged"])).encode()
        st, _, _ = self.req("POST", "/api/swipe-results", {"Origin": f"http://127.0.0.1:{self.port}"}, body)
        self.assertEqual(st, 400)

    def test_verdicts_reserved_name_rejected(self):
        st, _, _ = self.req("GET", "/api/verdicts/CON")
        self.assertEqual(st, 400)

    def test_post_foreign_origin_rejected(self):
        body = json.dumps(H.results_payload("dk", ["dk-01"])).encode()
        st, _, _ = self.req("POST", "/api/swipe-results",
                       {"Origin": "http://evil.example.com", "Content-Type": "application/json"}, body)
        self.assertEqual(st, 403)
        self.assertFalse((self.root / "data" / "verdicts" / "dk.json").exists())

    def test_post_bad_payloads(self):
        o = {"Origin": f"http://127.0.0.1:{self.port}"}
        st, _, _ = self.req("POST", "/api/swipe-results", o, b"not json")
        self.assertEqual(st, 400)
        st, _, _ = self.req("POST", "/api/swipe-results", o, b'{"schema":"x"}')
        self.assertEqual(st, 400)
        st, _, _ = self.req("POST", "/other", o, b"{}")
        self.assertEqual(st, 404)

    def test_content_length_validated(self):
        o = {"Origin": f"http://127.0.0.1:{self.port}"}
        for bad in ("abc", "-5", "1e3", "12 34"):
            st, _, _ = self.req("POST", "/api/swipe-results", {**o, "Content-Length": bad})
            self.assertEqual(st, 400, bad)
        st, _, _ = self.req("POST", "/api/swipe-results", {**o, "Content-Length": str(srv.MAX_BODY + 1)})
        self.assertEqual(st, 413)

    def test_methods(self):
        st, _, _ = self.req("PUT", "/", body=b"")
        self.assertEqual(st, 405)

    def test_request_timeout_set(self):
        self.assertEqual(srv.REQUEST_TIMEOUT, 15)
        handler = srv._make_handler(self.root, H.BOARD_DIR, "s" * 43, False, srv.PairCodes())
        self.assertEqual(handler.timeout, 15)

    def test_ensure_reuse_verified(self):
        second = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(second.stop)
        info2 = second.ensure(port=H.free_port())
        self.assertEqual(info2["port"], self.port)
        self.assertIsNone(second._httpd)
        self.assertEqual(self.bs.ensure(port=1)["port"], self.port)

    def test_info_never_contains_secret(self):
        blob = json.dumps(self.info)
        self.assertNotIn(self.secret(), blob)
        self.assertNotIn("token", self.info)


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = Path(self._td.name) / "root"

    def new(self):
        bs = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(bs.stop)
        return bs

    def test_secret_and_port_survive_restart(self):
        a = self.new()
        info = a.ensure(port=H.free_port())
        saved = json.loads((a.root / "data" / "server.json").read_text("utf-8"))
        self.assertGreaterEqual(len(saved["secret"]), 32)
        if os.name != "nt":
            self.assertEqual(os.stat(a.root / "data" / "server.json").st_mode & 0o777, 0o600)
        a.stop()
        b = self.new()
        info2 = b.ensure(port=H.free_port())
        saved2 = json.loads((b.root / "data" / "server.json").read_text("utf-8"))
        self.assertEqual(saved2["secret"], saved["secret"])
        self.assertEqual(info2["port"], info["port"])  # same port, so old links still work

    def test_unverified_server_is_not_reused(self):
        a = self.new()
        a.ensure(port=H.free_port())
        saved = json.loads((a.root / "data" / "server.json").read_text("utf-8"))
        a.stop()
        rid = srv.root_id(a.root)

        class Liar(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # claims to be the board but cannot sign the challenge
                body = json.dumps({"ok": True, "app": "riah-swipe", "rootId": rid, "lan": False,
                                   "hmac": "0" * 64}).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        fake = http.server.ThreadingHTTPServer(("127.0.0.1", saved["port"]), Liar)
        threading.Thread(target=fake.serve_forever, daemon=True).start()
        self.addCleanup(fake.server_close)
        self.addCleanup(fake.shutdown)
        b = self.new()
        info = b.ensure(port=H.free_port())
        self.assertIsNotNone(b._httpd)  # started its own
        self.assertNotEqual(info["port"], saved["port"])

    def test_bad_bind_and_advertise_host_refused(self):
        with self.assertRaises(RuntimeError):
            self.new().ensure(port=H.free_port(), bind="not-an-ip")
        with self.assertRaises(RuntimeError):
            self.new().ensure(port=H.free_port(), lan=True, advertise_host="bad host/../x")

    def test_clean_bind(self):
        self.assertEqual(srv._clean_bind(""), "")
        self.assertEqual(srv._clean_bind(" 100.64.0.5 "), "100.64.0.5")
        self.assertEqual(srv._clean_bind("::1"), "::1")


class ConnectionLimitTests(unittest.TestCase):
    def test_over_cap_dropped(self):
        with tempfile.TemporaryDirectory() as td, mock.patch.object(srv, "MAX_CONNECTIONS", 2):
            bs = srv.BoardServer(Path(td) / "r", H.BOARD_DIR)
            try:
                port = bs.ensure(port=H.free_port())["port"]
                held = []
                for _ in range(2):  # idle connections keep their slots
                    s = socket.create_connection(("127.0.0.1", port), timeout=3)
                    held.append(s)
                import time
                time.sleep(0.3)
                extra = socket.create_connection(("127.0.0.1", port), timeout=3)
                extra.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                try:
                    data = extra.recv(100)
                except (ConnectionError, socket.timeout):
                    data = b""
                self.assertEqual(data, b"")
                extra.close()
                for s in held:
                    s.close()
                time.sleep(0.3)
                st, _, _ = req(port, "GET", "/health")  # slots come back
                self.assertEqual(st, 200)
            finally:
                bs.stop()

    def test_disconnect_errors_are_silent(self):
        with tempfile.TemporaryDirectory() as td:
            bs = srv.BoardServer(Path(td) / "r", H.BOARD_DIR)
            try:
                bs.ensure(port=H.free_port())
                err = io.StringIO()
                with contextlib.redirect_stderr(err):
                    try:
                        raise ConnectionResetError("gone")
                    except ConnectionResetError:
                        bs._httpd.handle_error(None, ("127.0.0.1", 1))
                self.assertEqual(err.getvalue(), "")
            finally:
                bs.stop()

    def test_servers_start_with_exclusive_bind_flag_if_available(self):
        with tempfile.TemporaryDirectory() as td:
            bs = srv.BoardServer(Path(td) / "r", H.BOARD_DIR)
            try:
                bs.ensure(port=H.free_port())
                if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    val = bs._httpd.socket.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE)
                    self.assertTrue(val)
            finally:
                bs.stop()


class PairCodeTests(unittest.TestCase):
    def test_single_use_and_expiry(self):
        now = {"t": 1000.0}
        codes = srv.PairCodes(ttl=600, clock=lambda: now["t"])
        c = codes.mint()
        self.assertGreaterEqual(len(c), 12)
        self.assertTrue(codes.redeem(c))
        self.assertFalse(codes.redeem(c))  # single use
        c2 = codes.mint()
        now["t"] += 601
        self.assertFalse(codes.redeem(c2))  # expired
        self.assertFalse(codes.redeem(""))
        self.assertFalse(codes.redeem("guess"))


class LanServerTests(ServerBase):
    lan = True

    def cookie(self):
        return self.auth()

    def test_requires_cookie_not_query_token(self):
        self.assertTrue(self.info["lan"])
        st, _, _ = req(self.port, "GET", "/")
        self.assertEqual(st, 401)
        st, _, _ = req(self.port, "GET", f"/?t={self.secret()}")
        self.assertEqual(st, 401)  # the old ?t= token is gone
        st, _, body = req(self.port, "GET", "/health")
        self.assertTrue(json.loads(body)["lan"])
        self.assertNotIn(self.secret().encode(), body)

    def test_pairing_flow(self):
        link = self.bs.pair_url()
        self.assertTrue(link.startswith(f"http://192.0.2.5:{self.port}/pair?c="), link)
        self.assertNotIn(self.secret(), link)
        path = "/pair?c=" + link.split("c=")[1]
        st, h, _ = req(self.port, "GET", path)
        self.assertEqual(st, 302)
        self.assertEqual(h["location"], "/")
        cookie = h["set-cookie"]
        for part in ("HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000", f"{srv.cookie_name(self.root)}="):
            self.assertIn(part, cookie)
        self.assertNotIn(self.secret(), cookie)  # each browser gets its own token, never the secret
        st, _, body = req(self.port, "GET", "/", {"Cookie": cookie.split(";")[0]})
        self.assertEqual(st, 200)
        self.assertEqual(body, (H.BOARD_DIR / "index.html").read_bytes())
        st, _, _ = req(self.port, "GET", path)  # second use
        self.assertEqual(st, 403)
        st, _, _ = req(self.port, "GET", "/", {"Cookie": f"{srv.cookie_name(self.root)}=bad"})
        self.assertEqual(st, 401)

    def test_pair_wrong_code(self):
        for p in ("/pair", "/pair?c=", "/pair?c=nope"):
            st, _, _ = req(self.port, "GET", p)
            self.assertEqual(st, 403, p)

    def test_any_host_with_cookie_ok(self):
        st, _, _ = req(self.port, "GET", "/", self.cookie(), host="mybox.tailnet.ts.net:8137")
        self.assertEqual(st, 200)

    def test_post_needs_auth(self):
        st, _, _ = req(self.port, "POST", "/api/swipe-results", body=b"{}")
        self.assertEqual(st, 401)
        deck = core.build_deck(self.root, "D", ["a"], deck_id="dk")
        body = json.dumps(H.results_payload("dk", [deck["cards"][0]["id"]])).encode()
        st, _, _ = req(self.port, "POST", "/api/swipe-results", self.cookie(), body)
        self.assertEqual(st, 200)

    def test_loopback_browser_needs_the_cookie_too(self):
        # A proxy or port forward on this computer would make anyone look local.
        with mock.patch.object(srv, "LOOPBACK", {"127.0.0.1"}):
            st, _, _ = req(self.port, "GET", "/")
            self.assertEqual(st, 401)
            st, _, _ = req(self.port, "GET", "/", self.cookie())
            self.assertEqual(st, 200)

    def test_second_process_mints_code_over_loopback(self):
        second = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(second.stop)
        info2 = second.ensure(port=H.free_port(), lan=True)
        self.assertEqual(info2["port"], self.port)
        self.assertIsNone(second._httpd)
        link = second.pair_url()
        self.assertIsNotNone(link)
        st, h, _ = req(self.port, "GET", "/pair?c=" + link.split("c=")[1])
        self.assertEqual(st, 302)

    def test_pair_code_endpoint_needs_secret(self):
        st, _, _ = req(self.port, "POST", "/api/pair-code", body=b"")
        self.assertEqual(st, 403)
        st, _, _ = req(self.port, "POST", "/api/pair-code", {srv.SECRET_HEADER: "wrong"}, b"")
        self.assertEqual(st, 403)
        st, _, body = req(self.port, "POST", "/api/pair-code", {srv.SECRET_HEADER: self.secret()}, b"")
        self.assertEqual(st, 200)
        self.assertTrue(json.loads(body)["code"])

    def test_advertise_host_used_for_phone_link(self):
        bs = srv.BoardServer(self.root, H.BOARD_DIR)
        self.addCleanup(bs.stop)
        info = bs.ensure(port=H.free_port(), lan=True, advertise_host="mybox.tailnet.ts.net")
        self.assertEqual(info["phone_host"], "mybox.tailnet.ts.net")
        self.assertTrue(bs.pair_url().startswith(f"http://mybox.tailnet.ts.net:{info['port']}/pair?c="))

    def test_lan_off_has_no_pair_link(self):
        local = srv.BoardServer(self.tmp / "other", H.BOARD_DIR)
        self.addCleanup(local.stop)
        info = local.ensure(port=H.free_port(), lan=False)
        self.assertIsNone(local.pair_url())
        self.assertTrue(local.pair_url(local=True).startswith(f"http://127.0.0.1:{info['port']}/pair?c="))


if __name__ == "__main__":
    unittest.main()
