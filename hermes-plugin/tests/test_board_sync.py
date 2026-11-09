"""The vendored hermes-plugin/board must match ../board byte-for-byte.

Run from the repo root:
    python -m unittest discover -s hermes-plugin/tests -t hermes-plugin
Skipped when ../board is absent (installed copies). Fix drift with scripts/sync-hermes-board.mjs.
"""
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENDORED = HERE.parent / "board"
UPSTREAM = HERE.parent.parent / "board"


def files(base):
    return {p.relative_to(base).as_posix(): p for p in base.rglob("*") if p.is_file()}


class BoardSyncTests(unittest.TestCase):
    @unittest.skipUnless(UPSTREAM.is_dir(), "../board not present (installed copy)")
    def test_vendored_board_matches_upstream(self):
        up, ven = files(UPSTREAM), files(VENDORED)
        self.assertEqual(sorted(set(up) - set(ven)), [], "missing from hermes-plugin/board")
        self.assertEqual(sorted(set(ven) - set(up)), [], "extra in hermes-plugin/board")
        diff = [k for k in up if up[k].read_bytes() != ven[k].read_bytes()]
        self.assertEqual(diff, [], "content differs; run scripts/sync-hermes-board.mjs")


if __name__ == "__main__":
    unittest.main()
