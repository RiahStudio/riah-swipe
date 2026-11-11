"""Big card images are shrunk before they go up to Telegram (chat_telegram._smaller)."""
import builtins
import io
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _helpers as H  # noqa: E402

H.load_plugin()
ct = sys.modules.get(H.PKG + ".chat_telegram")
if ct is None:
    import importlib
    ct = importlib.import_module(H.PKG + ".chat_telegram")

try:
    from PIL import Image
    HAVE_PIL = True
except Exception:
    HAVE_PIL = False


def noisy_png(side=2000, alpha=False) -> bytes:
    rnd = random.Random(7)
    mode = "RGBA" if alpha else "RGB"
    im = Image.frombytes(mode, (side, side), rnd.randbytes(side * side * len(mode)))
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


@unittest.skipUnless(HAVE_PIL, "Pillow not installed")
class Shrink(unittest.TestCase):
    def test_a_big_png_goes_up_as_a_small_jpeg(self):
        data = noisy_png()
        self.assertGreater(len(data), ct.SHRINK_OVER)
        small = ct._smaller(data)
        self.assertLess(len(small), len(data))
        with Image.open(io.BytesIO(small)) as im:
            self.assertEqual(im.format, "JPEG")
            self.assertLessEqual(max(im.size), ct.SHRINK_SIDE)

    def test_a_see_through_png_is_flattened(self):
        small = ct._smaller(noisy_png(1200, alpha=True))
        with Image.open(io.BytesIO(small)) as im:
            self.assertEqual((im.format, im.mode), ("JPEG", "RGB"))

    def test_a_small_image_is_left_alone(self):
        data = b"\x89PNG\r\n\x1a\n" + b"x" * 1000
        self.assertIs(ct._smaller(data), data)

    def test_bytes_that_are_not_an_image_go_as_they_are(self):
        data = b"\x89PNG\r\n\x1a\n" + os.urandom(ct.SHRINK_OVER + 10)
        self.assertIs(ct._smaller(data), data)

    def test_only_images_are_shrunk(self):
        data = noisy_png()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.png"
            p.write_bytes(data)
            self.assertEqual(ct._file(str(p), {}, {"id": "c1"}, "video"), data)
            self.assertLess(len(ct._file(str(p), {}, {"id": "c1"}, "image")), len(data))

    def test_a_sent_card_reuses_its_file_id(self):
        self.assertEqual(ct._file("/nope.png", {"file_ids": {"c1": "F"}}, {"id": "c1"}, "image"), "F")


class NoPillow(unittest.TestCase):
    def test_without_pillow_the_original_bytes_go(self):
        data = b"\x89PNG\r\n\x1a\n" + b"x" * (ct.SHRINK_OVER + 10)
        real = builtins.__import__

        def fake(name, *a, **k):
            if name == "PIL" or name.startswith("PIL."):
                raise ImportError(name)
            return real(name, *a, **k)

        with mock.patch.object(builtins, "__import__", fake):
            self.assertIs(ct._smaller(data), data)


if __name__ == "__main__":
    unittest.main()
