"""The repo root carries a plugin.yaml and a small __init__.py so that installing the plain repo
(`hermes plugins install RiahStudio/riah-swipe`) loads the real plugin from hermes-plugin/.

Skipped in installed copies, where the repo root isn't there.
"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent.parent
REPO = PLUGIN_DIR.parent
SHIM = REPO / "__init__.py"
NAME = "hermes_plugins.riah_swipe_root_shim_test"


@unittest.skipUnless(SHIM.is_file() and (REPO / "plugin.yaml").is_file(), "not in the source repo")
class RootShimTests(unittest.TestCase):
    def test_root_manifest_matches_the_plugin_manifest(self):
        self.assertEqual((REPO / "plugin.yaml").read_bytes(), (PLUGIN_DIR / "plugin.yaml").read_bytes(),
                         "copy hermes-plugin/plugin.yaml to the repo root")

    def test_root_loads_like_hermes_loads_it(self):
        # Mirrors hermes_cli/plugins_loader.py _load_directory_module.
        parent = "hermes_plugins"
        added_parent = parent not in sys.modules
        if added_parent:
            ns = types.ModuleType(parent)
            ns.__path__ = []
            sys.modules[parent] = ns
        try:
            spec = importlib.util.spec_from_file_location(NAME, SHIM, submodule_search_locations=[str(REPO)])
            mod = importlib.util.module_from_spec(spec)
            mod.__package__ = NAME
            mod.__path__ = [str(REPO)]
            sys.modules[NAME] = mod
            spec.loader.exec_module(mod)

            self.assertTrue(callable(getattr(mod, "register", None)))
            self.assertEqual(Path(mod.BOARD_DIR), PLUGIN_DIR / "board")
            self.assertTrue((Path(mod.BOARD_DIR) / "index.html").is_file())
            sub = sys.modules[NAME + ".chat_swipe"]
            self.assertEqual(Path(sub.__file__).resolve().parent, PLUGIN_DIR)
        finally:
            for k in [k for k in sys.modules if k == NAME or k.startswith(NAME + ".")]:
                del sys.modules[k]
            if added_parent:
                sys.modules.pop(parent, None)


if __name__ == "__main__":
    unittest.main()
