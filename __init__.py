"""Lets `hermes plugins install RiahStudio/riah-swipe` work as well as the `/hermes-plugin` form.

Installing the plain repo puts this whole folder where Hermes looks for a plugin, so this file
loads the real plugin from hermes-plugin/ in its place. Nothing else lives here.
"""
from pathlib import Path as _Path

_REAL = _Path(__file__).resolve().parent / "hermes-plugin"
__path__.insert(0, str(_REAL))  # noqa: F821 - set by the importer; lets `from . import x` find hermes-plugin/x.py
__file__ = str(_REAL / "__init__.py")
exec(compile((_REAL / "__init__.py").read_text(encoding="utf-8"), __file__, "exec"))
