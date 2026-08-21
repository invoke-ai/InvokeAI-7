"""Every node module on disk must actually have been imported.

The walker itself is exercised against a synthetic tree in
`tests/backend/util/test_module_discovery.py`. What is left to check here is that this package's
real layout agrees with it — the realistic mistake being a new architecture folder that never got an
`__init__.py`, which is not a package and therefore contributes no nodes at all.
"""

from pathlib import Path

from invokeai.app.invocations import _MODULES

PACKAGE = "invokeai.app.invocations"


def test_every_node_module_on_disk_was_imported() -> None:
    root = Path(__file__).parents[3] / "invokeai" / "app" / "invocations"
    on_disk = {
        f"{PACKAGE}." + p.relative_to(root).with_suffix("").as_posix().replace("/", ".")
        for p in root.rglob("*.py")
        if not any(part.startswith("_") for part in p.relative_to(root).parts)
    }
    assert on_disk == set(_MODULES), "walker and filesystem disagree"
