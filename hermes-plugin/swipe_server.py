"""The Riah Swipe board server, in Python stdlib. Same routes as server/serve.mjs, plus pairing.

    GET  /                      the board UI (vendored board/)
    GET  /decks/index.json      generated from <root>/decks/*.swipe.json, newest first
    GET  /decks/...             deck files and their media (byte ranges supported)
    POST /api/swipe-results     the board's verdict sink -> <root>/data/{results,verdicts}/
    GET  /api/verdicts/<deck>   verdicts stored for a deck
    GET  /health                liveness; from this computer, ?n=<nonce> adds an HMAC proof of the secret
    GET  /pair?c=<code>         trade a one-time sign-in code for this browser's own cookie
    POST /api/pair-code         mint a sign-in code; this computer + X-Swipe-Secret only

Every browser signs in once, desktop and phone alike: Hermes hands out a link with a
one-time code (10 minutes), and opening it gives that browser its own random token in
a cookie. Only a hash of each token is kept (data/devices.json), and `/swipe unpair`
signs every browser out. Local mode (default) binds 127.0.0.1 and only answers Host
headers that name this machine (DNS-rebinding guard). Phone mode (lan, or a
non-loopback `bind`) listens on the network over plain HTTP.

data/server.json holds a separate long-lived secret that never leaves this computer:
Hermes processes use it to prove a running board is theirs and to mint codes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html as htmllib
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import swipe_core as core

logger = logging.getLogger(__name__)

APP = "riah-swipe"
VERSION = "0.1.0"
COOKIE = "swipe_t"  # the cookie name is COOKIE + "_" + the first 8 of the root id (two profiles, two cookies)
COOKIE_MAX_AGE = 30 * 24 * 3600
MAX_DEVICES = 50
MAX_BODY = 16 * 1024 * 1024
DRAIN_MAX = 256 * 1024  # a refused request's body is read up to this size before the reply
MAX_CONNECTIONS = 32
REQUEST_TIMEOUT = 15
PAIR_TTL = 600  # seconds a pairing code stays valid
PAIR_MAX_LIVE = 32
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}  # client addresses that count as "this computer"
SECRET_HEADER = "X-Swipe-Secret"

CSP_DEFAULT = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
CSP_MEDIA = "sandbox; default-src 'none'; frame-ancestors 'none'"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",  # the board's own icons; decks never carry svg
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".md": "text/plain; charset=utf-8",
}

_DISCONNECTS = (ConnectionResetError, BrokenPipeError, ConnectionAbortedError, socket.timeout, TimeoutError)
_HOST_OK = re.compile(r"^[A-Za-z0-9._:\-\[\]]{1,253}$")


def root_id(root: Path) -> str:
    return hashlib.sha256(str(Path(root).resolve()).encode("utf-8")).hexdigest()[:16]


def lan_ip() -> str | None:
    """Best guess at this machine's LAN address. A UDP connect sends no packets."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # TEST-NET-1, never routed
            ip = s.getsockname()[0]
            return None if ip.startswith("127.") else ip
    except OSError:
        return None


def _is_loopback_name(addr: str) -> bool:
    if addr.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(addr).is_loopback
    except ValueError:
        return False


def _clean_bind(bind) -> str:
    bind = str(bind or "").strip()
    if not bind:
        return ""
    if bind.lower() != "localhost":
        try:
            ipaddress.ip_address(bind)
        except ValueError:
            raise RuntimeError(f"bind must be an IP address such as 127.0.0.1 or 0.0.0.0 (got {bind!r})")
    return bind


def _clean_host(host) -> str:
    host = str(host or "").strip()
    if not host:
        return ""
    if not _HOST_OK.match(host):
        raise RuntimeError(f"advertise_host must be a bare host name or address (got {host!r})")
    return host


def hmac_hex(secret: str, nonce: str) -> str:
    return hmac.new(secret.encode("utf-8"), nonce.encode("utf-8"), hashlib.sha256).hexdigest()


def cookie_name(root: Path) -> str:
    return f"{COOKIE}_{root_id(root)[:8]}"


_INLINE_SCRIPT = re.compile(r"<script>(.*?)</script>", re.S | re.I)
_INLINE_HANDLER = re.compile(r'\son[a-z]+\s*=\s*"([^"]*)"', re.I)


def _csp_hash(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")  # what the browser hashes after parsing
    return "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode("ascii") + "'"


def board_csp(board: Path) -> str:
    """script-src 'self' plus the hashes of the board page's own inline scripts, so nothing
    else can run on the page even if a deck field ever slipped past the escaping."""
    try:
        page = (Path(board) / "index.html").read_text("utf-8")
    except OSError:
        return CSP_DEFAULT
    srcs = ["'self'"] + [_csp_hash(body) for body in _INLINE_SCRIPT.findall(page)]
    handlers = [_csp_hash(htmllib.unescape(v)) for v in _INLINE_HANDLER.findall(page)]
    if handlers:
        srcs += ["'unsafe-hashes'"] + handlers
    return f"script-src {' '.join(dict.fromkeys(srcs))}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"


class Devices:
    """Signed-in browsers. Each gets its own random token; only its SHA-256 is kept, in
    data/devices.json, so a copy of the data folder signs nobody in. Tokens expire after
    COOKIE_MAX_AGE, and clear() signs everyone out. Re-read when the file changes, so a
    sign-out from another Hermes process takes effect at once."""

    def __init__(self, root: Path, clock=time.time):
        self.path = Path(root) / "data" / "devices.json"
        self.lock_path = Path(root) / "data" / "devices.lock"
        self._clock = clock
        self._seen = None
        self._rows: list[dict] = []
        self._guard = threading.Lock()

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _load(self) -> list[dict]:
        data = core.read_json(self.path, None)
        rows = data.get("devices") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        return [r for r in rows if isinstance(r, dict) and isinstance(r.get("h"), str)]

    def _live(self, rows: list[dict]) -> list[dict]:
        cutoff = self._clock() - COOKIE_MAX_AGE
        return [r for r in rows if isinstance(r.get("at"), (int, float)) and r["at"] > cutoff]

    def _current(self) -> list[dict]:
        try:
            st = self.path.stat()
            sig = (st.st_mtime_ns, st.st_size, st.st_ino)
        except OSError:
            sig = None
        with self._guard:
            if sig != self._seen:
                self._rows = self._load() if sig else []
                self._seen = sig
            return self._rows

    def check(self, token: str) -> bool:
        if not token:
            return False
        h = self._hash(token).encode("ascii")
        ok = False
        for r in self._live(self._current()):  # compare against all, no early exit
            if hmac.compare_digest(r["h"].encode("ascii", "replace"), h):
                ok = True
        return ok

    def _write(self, rows: list[dict]) -> None:
        core.atomic_write_json(self.path, {"devices": rows})
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def add(self) -> str:
        token = secrets.token_urlsafe(32)
        with core.file_lock(self.lock_path):
            rows = self._live(self._load())
            rows.append({"h": self._hash(token), "at": self._clock()})
            self._write(rows[-MAX_DEVICES:])
        return token

    def count(self) -> int:
        return len(self._live(self._current()))

    def clear(self) -> int:
        """Sign every browser out. Returns how many were signed in."""
        with core.file_lock(self.lock_path):
            n = len(self._live(self._load()))
            self._write([])
        return n


class PairCodes:
    """One-time pairing codes: valid PAIR_TTL seconds, single use."""

    def __init__(self, ttl: float = PAIR_TTL, clock=time.monotonic):
        self.ttl = ttl
        self._clock = clock
        self._codes: dict[str, float] = {}
        self._lock = threading.Lock()

    def _prune(self) -> None:
        now = self._clock()
        for c in [c for c, exp in self._codes.items() if exp <= now]:
            del self._codes[c]

    def mint(self) -> str:
        code = secrets.token_urlsafe(9)
        with self._lock:
            self._prune()
            self._codes[code] = self._clock() + self.ttl
            while len(self._codes) > PAIR_MAX_LIVE:
                del self._codes[min(self._codes, key=self._codes.get)]
        return code

    def redeem(self, candidate: str) -> bool:
        cand = str(candidate or "").encode("utf-8")
        with self._lock:
            self._prune()
            match = None
            for c in self._codes:  # compare against all, no early exit
                if hmac.compare_digest(c.encode("utf-8"), cand):
                    match = c
            if match is None:
                return False
            del self._codes[match]
            return True


def _make_handler(root: Path, board: Path, secret: str, lan: bool, codes: PairCodes, on_results=None):
    rid = root_id(root)
    cookie = cookie_name(root)
    devices = Devices(root)
    csp_board = board_csp(board)
    decks_dir = (root / "decks").resolve()
    board_dir = board.resolve()
    deck_locks: dict[str, threading.Lock] = {}
    deck_locks_guard = threading.Lock()

    def deck_lock(deck_id: str) -> threading.Lock:
        with deck_locks_guard:
            return deck_locks.setdefault(deck_id, threading.Lock())

    class Handler(BaseHTTPRequestHandler):
        server_version = f"{APP}/{VERSION}"
        protocol_version = "HTTP/1.1"
        timeout = REQUEST_TIMEOUT
        _csp = CSP_DEFAULT
        _body_read = True
        locks = deck_locks  # exposed for tests

        def log_message(self, fmt, *args):  # keep the agent's terminal quiet
            return

        def end_headers(self) -> None:
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", self._csp)
            super().end_headers()

        # ---------------------------------------------------------- helpers

        def _drain(self) -> None:
            """Read a small unread request body before answering.

            Closing a socket that still holds unread data resets the connection on Windows,
            so the browser would see a network error instead of our status code (a 401
            that tells the person to sign in again, for one)."""
            if self._body_read or self.headers.get("transfer-encoding"):
                return
            cl = (self.headers.get("content-length") or "0").strip()
            if not re.fullmatch(r"[0-9]{1,12}", cl) or int(cl) > DRAIN_MAX:
                return
            try:
                if int(cl):
                    self.rfile.read(int(cl))
                self._body_read = True
            except OSError:
                pass

        def _json(self, code: int, obj, headers: dict | None = None) -> None:
            self._drain()
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            if not self._body_read:  # unread request body would poison the next request
                self.send_header("connection", "close")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _host_name(self) -> str:
            host = (self.headers.get("host") or "").strip().lower()
            if host.startswith("["):
                return host.split("]", 1)[0] + "]"
            return host.rsplit(":", 1)[0] if ":" in host else host

        def _host_ok(self) -> bool:
            if lan:  # phone mode: the cookie is the gate, any Host is fine
                return True
            return self._host_name() in LOCAL_HOSTS

        def _peer(self) -> str:
            return str(self.client_address[0])

        def _from_this_computer(self) -> bool:
            """The connection comes from this machine (loopback, or the address we listen on)."""
            if self._peer() in LOOPBACK:
                return True
            try:
                return self._peer() == str(self.request.getsockname()[0])
            except OSError:
                return False

        def _authed(self) -> bool:
            """A browser that signed in with a one-time link. No exceptions for loopback:
            a proxy or port forward on this computer would make anyone look local."""
            for part in (self.headers.get("cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == cookie and v and devices.check(v):
                    return True
            return False

        def _signed_out(self) -> None:
            msg = "This browser isn't signed in to Riah Swipe. Type /swipe in Hermes for a fresh link."
            if self.command in ("GET", "HEAD") and not self.path.startswith(("/api/", "/decks/")):
                body = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                        f"<title>Riah Swipe</title><p style='font:16px system-ui;margin:2em'>{msg}</p>").encode("utf-8")
                self.send_response(401)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
                return
            self._json(401, {"error": msg})

        def _read_body(self) -> bytes | None:
            """The request body, or None after sending an error."""
            if self.headers.get("transfer-encoding"):
                self._json(400, {"error": "chunked uploads are not supported"})
                return None
            cl = self.headers.get("content-length")
            n = 0
            if cl is not None:
                if not re.fullmatch(r"[0-9]{1,12}", cl.strip()):
                    self._json(400, {"error": "bad Content-Length"})
                    return None
                n = int(cl.strip())
                if n > MAX_BODY:
                    self._json(413, {"error": "payload too large"})
                    return None
            raw = self.rfile.read(n) if n else b""
            self._body_read = True
            return raw

        def _serve_file(self, base: Path, rel: str) -> None:
            if base == decks_dir:
                self._csp = CSP_MEDIA
            try:
                rel = urllib.parse.unquote(rel, errors="strict")
            except UnicodeDecodeError:
                return self._json(400, {"error": "bad path"})
            if "\x00" in rel:
                return self._json(400, {"error": "bad path"})
            target = (base / ("." + "/" + rel.lstrip("/"))).resolve()
            if target != base and base not in target.parents:
                return self._json(403, {"error": "forbidden"})
            if target.is_dir():
                target = target / "index.html"
            if base == board_dir and target.name == "index.html":
                self._csp = csp_board
            try:
                st = target.stat()
            except OSError:
                return self._json(404, {"error": "not found"})
            if not target.is_file():
                return self._json(404, {"error": "not found"})
            ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
            size = st.st_size
            rng = self.headers.get("range") or ""
            start, end, partial = 0, size - 1, False
            if rng.startswith("bytes=") and "," not in rng:
                a, _, b = rng[6:].partition("-")
                try:  # parse into temporaries: a bad header falls back to the whole file
                    if a:
                        s = int(a)
                        e = min(int(b), size - 1) if b else size - 1
                    elif b:
                        s, e = max(0, size - int(b)), size - 1
                    else:
                        raise ValueError
                    start, end, partial = s, e, True
                except ValueError:
                    start, end, partial = 0, size - 1, False
                if partial and (start > end or start >= size):
                    self.send_response(416)
                    self.send_header("content-range", f"bytes */{size}")
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
            length = end - start + 1 if size else 0
            self.send_response(206 if partial else 200)
            self.send_header("content-type", ctype)
            self.send_header("accept-ranges", "bytes")
            self.send_header("content-length", str(length))
            if ctype.startswith("text/html") or target.name == "service-worker.js":
                self.send_header("cache-control", "no-cache")
            if partial:
                self.send_header("content-range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if self.command == "HEAD" or not length:
                return
            with open(target, "rb") as fh:
                fh.seek(start)
                left = length
                while left > 0:
                    chunk = fh.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)

        def _deck_index(self) -> dict:
            rows = []
            try:
                for p in decks_dir.iterdir():
                    if p.name.endswith(".swipe.json"):
                        try:
                            rows.append((-p.stat().st_mtime, p.name))
                        except OSError:  # deleted mid-scan
                            continue
            except OSError:
                pass
            rows.sort()
            return {"batches": [name for _, name in rows]}

        # ---------------------------------------------------------- pairing

        def _pair(self, query: dict) -> None:
            if self.command not in ("GET", "HEAD"):
                return self._json(405, {"error": "method not allowed"})
            if self.command == "HEAD":
                # Link previewers and prefetchers send HEAD; it must not use up the code.
                self.send_response(200)
                self.send_header("content-length", "0")
                self.send_header("cache-control", "no-store")
                self.end_headers()
                return
            code = (query.get("c") or [""])[0]
            fresh = bool(code) and codes.redeem(code)
            if not fresh and not self._authed():
                return self._json(403, {"error": "that sign-in link expired or was already used; "
                                                 "type /swipe in Hermes for a new one"})
            self.send_response(302)
            self.send_header("location", "/")
            if fresh:
                # Lax, not Strict: the link is usually opened from a chat app, and Strict would
                # drop the cookie on the redirect that follows. Writes are still same-origin only.
                self.send_header("set-cookie", f"{cookie}={devices.add()}; Path=/; HttpOnly; SameSite=Lax; "
                                               f"Max-Age={COOKIE_MAX_AGE}")
            self.send_header("content-length", "0")
            self.send_header("cache-control", "no-store")
            self.end_headers()

        def _pair_code(self) -> None:
            raw = self._read_body()
            if raw is None:
                return
            if not self._from_this_computer():
                return self._json(403, {"error": "pairing codes are minted from this computer only"})
            given = self.headers.get(SECRET_HEADER) or ""
            if not given or not hmac.compare_digest(given.encode("utf-8"), secret.encode("utf-8")):
                return self._json(403, {"error": "bad secret"})
            return self._json(200, {"code": codes.mint(), "ttl": codes.ttl})

        # ---------------------------------------------------------- routing

        def _route(self) -> None:
            self._csp = CSP_DEFAULT
            self._body_read = self.command != "POST"
            url = urllib.parse.urlsplit(self.path)
            path = url.path or "/"
            query = urllib.parse.parse_qs(url.query)

            if not self._host_ok():
                return self._json(421, {"error": "unexpected Host header"})
            if path == "/health":
                out = {"ok": True, "app": APP, "version": VERSION, "rootId": rid, "lan": lan}
                nonce = (query.get("n") or [""])[0]
                if nonce and self._from_this_computer():  # only Hermes on this machine needs the proof
                    out["hmac"] = hmac_hex(secret, nonce[:200])
                return self._json(200, out)
            if path == "/pair":
                return self._pair(query)
            if path == "/api/pair-code" and self.command == "POST":
                return self._pair_code()
            if not self._authed():
                return self._signed_out()

            if self.command == "POST":
                origin = self.headers.get("origin")
                if origin:
                    o = urllib.parse.urlsplit(origin)
                    if (o.netloc or "").lower() != (self.headers.get("host") or "").lower():
                        return self._json(403, {"error": "cross-origin write blocked"})
                if path != "/api/swipe-results":
                    return self._json(404, {"error": "not found"})
                raw = self._read_body()
                if raw is None:
                    return
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                except (UnicodeDecodeError, ValueError):
                    return self._json(400, {"error": "invalid JSON"})
                deck = payload.get("batchId") if isinstance(payload, dict) else None
                # Only real decks get a lock, so junk ids can't grow the lock table.
                if not core.is_safe_id(deck) or not core.deck_path(root, deck).is_file():
                    return self._json(400, {"error": "unknown or invalid batchId"})
                try:
                    with deck_lock(deck):
                        out = core.store_results(root, payload)
                except core.SwipeError as e:
                    return self._json(400, {"error": str(e)})
                self._json(200, out)
                if on_results is not None:
                    try:  # after the reply, so the phone never waits on Hermes
                        on_results(deck)
                    except Exception:
                        logger.debug("riah-swipe: on_results hook failed", exc_info=True)
                return

            if self.command not in ("GET", "HEAD"):
                return self._json(405, {"error": "method not allowed"})
            if path.startswith("/api/verdicts/"):
                deck = urllib.parse.unquote(path[len("/api/verdicts/"):])
                if not core.is_safe_id(deck):
                    return self._json(400, {"error": "invalid deck id"})
                store = core.read_json(root / "data" / "verdicts" / f"{deck}.json")
                if not isinstance(store, dict):
                    return self._json(404, {"error": "no verdicts for that deck"})
                return self._json(200, store)
            if path == "/decks/index.json":
                return self._json(200, self._deck_index())
            if path.startswith("/decks/"):
                return self._serve_file(decks_dir, path[len("/decks/"):])
            return self._serve_file(board_dir, "index.html" if path == "/" else path[1:])

        def _safe(self) -> None:
            try:
                self._route()
            except _DISCONNECTS:
                self.close_connection = True
            except Exception:  # never take the server down over one request
                try:
                    self._json(500, {"error": "internal error"})
                except Exception:
                    pass

        do_GET = do_HEAD = do_POST = _safe

        def do_PUT(self):
            self._body_read = False
            self._json(405, {"error": "method not allowed"})

        do_DELETE = do_PATCH = do_PUT

    return Handler


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, *a, **kw):
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(*a, **kw)

    def server_bind(self) -> None:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: nobody else may share this port
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        socketserver.TCPServer.server_bind(self)  # skips HTTPServer's slow getfqdn()
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

    def process_request(self, request, client_address) -> None:
        if not self._slots.acquire(blocking=False):  # over the cap: drop the connection
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, _DISCONNECTS):
            return
        logger.debug("riah-swipe: request error from %s", client_address, exc_info=True)


class _Server6(_Server):
    address_family = socket.AF_INET6


def probe(port: int, secret: str | None = None, host: str = "127.0.0.1", timeout: float = 0.6) -> dict | None:
    """Ask a port whether it's a Riah Swipe board. With `secret`, the answer carries
    `verified` (True only if the server proved it knows the secret)."""
    nonce = secrets.token_hex(8)
    url_host = f"[{host}]" if ":" in host else host
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://{url_host}:{port}/health?n={nonce}", timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or data.get("app") != APP:
        return None
    if secret is not None:
        proof = data.get("hmac")
        data["verified"] = isinstance(proof, str) and hmac.compare_digest(
            proof.encode("utf-8"), hmac_hex(secret, nonce).encode("utf-8"))
    return data


class BoardServer:
    """One board server per data root; reuses one that another Hermes process already runs."""

    def __init__(self, root: Path, board: Path, on_results=None):
        self.root = core.ensure_root(root)
        self.board = Path(board)
        self.on_results = on_results  # called with a deck id after verdicts are stored
        self._lock = threading.Lock()
        self._httpd: _Server | None = None
        self._thread: threading.Thread | None = None
        self._codes: PairCodes | None = None
        self._secret: str = ""
        self._state: dict | None = None
        self.info: dict | None = None

    @property
    def info_path(self) -> Path:
        return self.root / "data" / "server.json"

    @property
    def lock_path(self) -> Path:
        return self.root / "data" / "server.lock"

    # ------------------------------------------------------------ health

    def _verified(self, port: int, lan_mode: bool, host: str = "127.0.0.1") -> bool:
        h = probe(int(port), self._secret, host=host)
        return bool(h and h.get("verified") and h.get("rootId") == root_id(self.root)
                    and bool(h.get("lan")) == bool(lan_mode))

    @staticmethod
    def _probe_host(host: str) -> str:
        return "127.0.0.1" if host in ("0.0.0.0", "", "localhost") else ("::1" if host == "::" else host)

    # ------------------------------------------------------------ start / reuse

    def ensure(self, port: int = 8137, lan: bool = False, bind: str = "", advertise_host: str = "") -> dict:
        bind = _clean_bind(bind)
        adv = _clean_host(advertise_host)
        # Listening on a non-loopback address always means phone mode (cookie required).
        lan_mode = bool(lan) or (bind != "" and not _is_loopback_name(bind))
        want = (lan_mode, bind)
        with self._lock:
            with core.file_lock(self.lock_path):
                saved = core.read_json(self.info_path, None)
                saved = saved if isinstance(saved, dict) else {}
                secret = saved.get("secret")
                fresh_secret = not (isinstance(secret, str) and len(secret) >= 32)
                if fresh_secret:
                    secret = secrets.token_urlsafe(32)
                self._secret = secret
                st = self._state
                if (st and self._httpd and self._thread and self._thread.is_alive()
                        and (st["lan"], st["bind"]) == want
                        and self._verified(st["port"], lan_mode, self._probe_host(st["host"]))):
                    pass  # our own server is fine
                elif (not fresh_secret and saved.get("port") and (bool(saved.get("lan")), saved.get("bind", "")) == want
                      and self._verified(saved["port"], lan_mode, self._probe_host(str(saved.get("host", ""))))):
                    self.stop()
                    st = {k: saved.get(k) for k in ("port", "lan", "bind", "host", "pid", "started_at")}
                    st["lan"] = bool(st["lan"])
                    st["bind"] = st["bind"] or ""
                    st["host"] = st["host"] or "127.0.0.1"
                else:
                    self.stop()
                    st = self._start(port, lan_mode, bind, saved)
                    saved_out = {"app": APP, "secret": secret, **st}
                    core.atomic_write_json(self.info_path, saved_out)
                    try:
                        os.chmod(self.info_path, 0o600)
                    except OSError:
                        pass
                self._state = st
                self.info = self._public(st, adv)
                return self.info

    def _start(self, port: int, lan_mode: bool, bind: str, saved: dict) -> dict:
        host = bind or ("0.0.0.0" if lan_mode else "127.0.0.1")
        order: list[int] = []
        if isinstance(saved.get("port"), int):  # prefer last time's port so old links keep working
            order.append(saved["port"])
        order += [p for p in range(int(port), int(port) + 20) if p not in order]
        order = [p for p in order if 0 < p <= 65535]
        cls = _Server6 if ":" in host else _Server
        self._codes = PairCodes()
        handler = _make_handler(self.root, self.board, self._secret, lan_mode, self._codes, self.on_results)
        last_err: Exception | None = None
        httpd = None
        for p in order:
            try:
                httpd = cls((host, p), handler)
                break
            except (OSError, OverflowError) as e:
                last_err = e
        if httpd is None:
            raise RuntimeError(f"could not open a port near {port}: {last_err}")
        self._httpd = httpd
        self._thread = threading.Thread(target=httpd.serve_forever, name="riah-swipe-board", daemon=True)
        self._thread.start()
        return {"pid": os.getpid(), "port": httpd.server_address[1], "lan": lan_mode, "bind": bind,
                "host": host, "started_at": core.now_iso()}

    def _public(self, st: dict, advertise_host: str) -> dict:
        """What callers may see. Never includes the secret."""
        port, host = st["port"], st["host"]
        local = None
        if host in ("0.0.0.0", "127.0.0.1", "localhost"):
            local = f"http://127.0.0.1:{port}/"
        elif host in ("::", "::1"):
            local = f"http://[::1]:{port}/"
        info = {"app": APP, "pid": st.get("pid"), "port": port, "lan": bool(st["lan"]), "bind": st["bind"],
                "local_url": local, "started_at": st.get("started_at"), "phone_url": None}
        if st["lan"]:
            wildcard = host in ("0.0.0.0", "::", "")
            ph = advertise_host or (None if wildcard or _is_loopback_name(host) else host) or lan_ip()
            if ph and ":" in ph and not ph.startswith("["):
                ph = f"[{ph}]"
            info["phone_host"] = ph
        return info

    # ------------------------------------------------------------ pairing

    def mint_pair_code(self) -> str | None:
        """A fresh one-time code, from our own server or (when another process owns the
        board) by asking it over loopback with the shared secret."""
        if self._httpd and self._codes:
            return self._codes.mint()
        info, st = self.info, self._state
        if not info or not st:
            return None
        host = self._probe_host(st["host"])
        url_host = f"[{host}]" if ":" in host else host
        try:
            req = urllib.request.Request(f"http://{url_host}:{st['port']}/api/pair-code", data=b"", method="POST",
                                         headers={SECRET_HEADER: self._secret})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=2) as r:
                code = json.loads(r.read().decode("utf-8")).get("code")
            return code if isinstance(code, str) and code else None
        except Exception:
            logger.debug("riah-swipe: pair-code request failed", exc_info=True)
            return None

    def pair_url(self, local: bool = False) -> str | None:
        """A one-time sign-in link: it gives the browser that opens it its own cookie and
        lands on the board. local=True is for a browser on this computer; otherwise it's the
        phone link (phone mode only)."""
        info = self.info
        if not info:
            return None
        if local:
            base = info.get("local_url")
        elif info.get("lan") and info.get("phone_host"):
            base = f"http://{info['phone_host']}:{info['port']}/"
        else:
            base = None
        if not base:
            return None
        code = self.mint_pair_code()
        if not code:
            return None
        return f"{base}pair?c={code}"

    def unpair(self) -> int:
        """Sign every browser out (desktop and phone). Returns how many were signed in."""
        return Devices(self.root).clear()

    def stop(self) -> None:
        if self._httpd:
            try:
                self._httpd.shutdown()
                self._httpd.server_close()
            except Exception:
                pass
        self._httpd = None
        self._thread = None
        self._codes = None
        self._state = None


def wait_until_ready(port: int, seconds: float = 3.0) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if probe(port, timeout=0.3):
            return True
        time.sleep(0.05)
    return False
