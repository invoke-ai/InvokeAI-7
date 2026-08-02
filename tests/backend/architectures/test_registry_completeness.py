"""The gate that makes an incompletely registered architecture a CI failure.

Adding a `BaseModelType` without a `defs/<base>.py`, writing the module but forgetting the import
line in `architectures/__init__.py`, or declaring a base that no longer exists -- each of those used
to surface as a runtime `ValueError` mid-generation, if at all. Each is a failure here instead.
"""

from pathlib import Path

import pytest

import invokeai
from invokeai.backend import architectures
from invokeai.backend.architectures.registry import _NOT_ARCHITECTURES, defs_module_path
from invokeai.backend.model_manager.taxonomy import BaseModelType

REPO_ROOT = Path(invokeai.__file__).parent.parent
ARCHITECTURES_DIR = Path(architectures.__file__).parent
DEFS_DIR = ARCHITECTURES_DIR / "defs"
FACETS_DIR = ARCHITECTURES_DIR / "facets"


def test_every_architecture_base_is_registered() -> None:
    """The one place the sentinel subtraction is allowed to be written.

    Production code never asks "which bases are architectures?" by subtracting sentinels -- it asks
    the registry, and registration *is* the definition. This test is what keeps the two in step, so
    that a new `BaseModelType` cannot be added without a definition module.
    """
    expected = set(BaseModelType) - set(_NOT_ARCHITECTURES)
    registered = set(architectures.generative_bases())

    assert registered == expected, (
        f"missing a defs module: {sorted(b.value for b in expected - registered)}; "
        f"registered but not an architecture: {sorted(b.value for b in registered - expected)}"
    )


@pytest.mark.parametrize("base", sorted(architectures.generative_bases(), key=lambda b: b.value))
def test_every_registered_architecture_has_a_defs_module_at_the_derived_path(base: BaseModelType) -> None:
    assert (REPO_ROOT / defs_module_path(base)).is_file()


def test_the_defs_directory_holds_exactly_the_registered_architectures() -> None:
    """Catches a definition module that exists but is never imported, and the reverse.

    A module missing from the import list in `architectures/__init__.py` is never executed, so its
    `register()` call never runs -- the file looks right and does nothing. A module in the import
    list but absent from disk is an ImportError, caught by `tests/test_imports.py`.
    """
    on_disk = {path.name for path in DEFS_DIR.glob("*.py")} - {"__init__.py"}
    derived = {Path(defs_module_path(base)).name for base in architectures.generative_bases()}

    assert on_disk == derived, (
        f"defs modules that register nothing (missing from the import list in "
        f"{ARCHITECTURES_DIR.name}/__init__.py): {sorted(on_disk - derived)}"
    )


def test_validate_passes_for_the_real_registry() -> None:
    """The same check `run_app.py` and `ApiDependencies.initialize()` run at boot.

    In PR 0 no facet declares itself required, so this is structurally sharp and semantically empty.
    It becomes load-bearing with the first `REQUIRED` facet.
    """
    architectures.validate()


def test_every_facet_module_is_imported_by_the_aggregate() -> None:
    """A facet class is only in `Facet.FACET_TYPES` once its module has been imported.

    A `REQUIRED` facet in a module that nothing imports would be invisible to `validate()`, which
    would then pass while every architecture silently lacks it.
    """
    aggregate_source = (ARCHITECTURES_DIR / "__init__.py").read_text(encoding="utf-8")
    facet_modules = sorted(path.stem for path in FACETS_DIR.glob("*.py") if path.stem != "__init__")

    missing = [stem for stem in facet_modules if f"architectures.facets.{stem}" not in aggregate_source]

    assert missing == [], f"facet modules not imported by architectures/__init__.py: {missing}"
