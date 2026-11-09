"""Shared test helpers: load the hyphen-named plugin folder as the package `hermes_plugin`.

Stdlib only. Never touches ~/.hermes (tests set SWIPE_ROOT to a temp dir).
"""
import importlib.util
import os
import socket
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
BOARD_DIR = PLUGIN_DIR / "board"
PKG = "hermes_plugin"


def load_plugin():
    """Import hermes-plugin/ as package `hermes_plugin` (once) and return it."""
    if PKG in sys.modules:
        return sys.modules[PKG]
    spec = importlib.util.spec_from_file_location(
        PKG, str(PLUGIN_DIR / "__init__.py"), submodule_search_locations=[str(PLUGIN_DIR)]
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    return mod


def core():
    load_plugin()
    return sys.modules[PKG + ".swipe_core"]


def server_mod():
    load_plugin()
    return sys.modules[PKG + ".swipe_server"]


def signin(bs):
    """Sign a test browser in the way a person does: open a one-time link. Returns the
    Cookie header to send with later requests."""
    import http.client
    port = bs.info["port"]
    link = bs.pair_url(local=True)
    assert link, "no sign-in link"
    path = link.split(f":{port}", 1)[1]
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        c.request("GET", path, headers={"Host": f"127.0.0.1:{port}"})
        r = c.getresponse()
        r.read()
        assert r.status == 302, r.status
        return {"Cookie": r.getheader("set-cookie").split(";")[0]}
    finally:
        c.close()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def results_payload(deck_id, card_ids, decisions=None, name="Deck"):
    decisions = decisions or ["keep"] * len(card_ids)
    return {
        "schema": "riah-swipe.results/1",
        "batchId": deck_id,
        "deckName": name,
        "partial": False,
        "decidedCount": len(card_ids),
        "cardCount": len(card_ids),
        "results": [
            {"cardId": c, "decision": d, "note": "n-" + c, "decidedAt": "2026-01-01T00:00:00.000Z"}
            for c, d in zip(card_ids, decisions)
        ],
    }
