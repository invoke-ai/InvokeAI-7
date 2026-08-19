"""The invocation walker must find nodes in subpackages, not just in the top directory.

A walker that silently finds nothing is green forever, so the self-tests below run it against a
synthetic tree whose expected result is written out by hand — independent of how
`invokeai/app/invocations/` happens to be laid out today.
"""

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from invokeai.app.invocations import _MODULES, discover_node_modules

PACKAGE = "invokeai.app.invocations"


@pytest.fixture
def synthetic_tree(tmp_path: Path) -> Iterator[Path]:
    """A miniature invocations package: one flat module, one in a subpackage, plus things to skip."""
    root = tmp_path / "synthetic_nodes"
    (root / "arch").mkdir(parents=True)
    (root / "__pycache__").mkdir()
    (root / "__init__.py").write_text("", encoding="utf-8")
    (root / "flat_node.py").write_text("", encoding="utf-8")
    (root / "_private.py").write_text("", encoding="utf-8")
    (root / "arch" / "__init__.py").write_text("", encoding="utf-8")
    (root / "arch" / "nested_node.py").write_text("", encoding="utf-8")
    (root / "__pycache__" / "stale.py").write_text("", encoding="utf-8")

    sys.path.insert(0, str(tmp_path))
    try:
        yield root
    finally:
        sys.path.remove(str(tmp_path))
        for name in [m for m in sys.modules if m.startswith("synthetic_nodes")]:
            del sys.modules[name]


def test_walker_descends_into_subpackages(synthetic_tree: Path) -> None:
    found = discover_node_modules(synthetic_tree, prefix="synthetic_nodes.")
    assert sorted(found) == ["synthetic_nodes.arch.nested_node", "synthetic_nodes.flat_node"]


def test_walker_reports_a_broken_subpackage(synthetic_tree: Path) -> None:
    (synthetic_tree / "arch" / "__init__.py").write_text("raise RuntimeError('boom')", encoding="utf-8")
    with pytest.raises(ImportError, match="synthetic_nodes.arch"):
        discover_node_modules(synthetic_tree, prefix="synthetic_nodes.")


def test_every_node_module_on_disk_was_imported() -> None:
    """Filesystem and registry agree. Catches a subpackage that never got an `__init__.py`."""
    root = Path(__file__).parents[3] / "invokeai" / "app" / "invocations"
    on_disk = {
        f"{PACKAGE}." + p.relative_to(root).with_suffix("").as_posix().replace("/", ".")
        for p in root.rglob("*.py")
        if not any(part.startswith("_") for part in p.relative_to(root).parts)
    }
    assert on_disk == set(_MODULES), "walker and filesystem disagree"
