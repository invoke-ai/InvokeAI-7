"""The package walker must descend into subpackages, and must not hide a broken one.

A walker that silently finds nothing is green forever, so these run it against a synthetic tree
whose expected result is written out by hand — independent of any real package's layout.
"""

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from invokeai.backend.util.module_discovery import discover_modules


@pytest.fixture
def tree(tmp_path: Path) -> Iterator[Path]:
    """A miniature package: one flat module, one in a subpackage, plus things that must be skipped."""
    root = tmp_path / "synthetic_pkg"
    (root / "sub").mkdir(parents=True)
    (root / "__pycache__").mkdir()
    (root / "__init__.py").write_text("", encoding="utf-8")
    (root / "flat.py").write_text("", encoding="utf-8")
    (root / "_private.py").write_text("", encoding="utf-8")
    (root / "sub" / "__init__.py").write_text("", encoding="utf-8")
    (root / "sub" / "nested.py").write_text("", encoding="utf-8")
    (root / "__pycache__" / "stale.py").write_text("", encoding="utf-8")

    sys.path.insert(0, str(tmp_path))
    try:
        yield root
    finally:
        sys.path.remove(str(tmp_path))
        for name in [m for m in sys.modules if m.startswith("synthetic_pkg")]:
            del sys.modules[name]


def test_descends_into_subpackages(tree: Path) -> None:
    assert sorted(discover_modules(tree, "synthetic_pkg.")) == [
        "synthetic_pkg.flat",
        "synthetic_pkg.sub.nested",
    ]


def test_skips_private_modules_and_pycache(tree: Path) -> None:
    found = discover_modules(tree, "synthetic_pkg.")
    assert not [n for n in found if "_private" in n or "__pycache__" in n or "stale" in n]


def test_reports_a_broken_subpackage(tree: Path) -> None:
    """The default `walk_packages` behaviour is to swallow this, leaving the caller none the wiser."""
    (tree / "sub" / "__init__.py").write_text("raise RuntimeError('boom')", encoding="utf-8")
    with pytest.raises(ImportError, match="synthetic_pkg.sub"):
        discover_modules(tree, "synthetic_pkg.")
