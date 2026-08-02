"""The scaffolder is checked against the fifteen architectures that already exist.

A generator that drifts from what the registry expects is worse than none: it produces files that
look right and fail at boot. So rather than testing the templates against themselves, these assert
that what the scaffolder would emit for an existing architecture matches what that architecture
actually has.
"""

import ast
import importlib.util
from pathlib import Path

import pytest

import invokeai
from invokeai.backend.architectures import generative_bases
from invokeai.backend.architectures.registry import defs_module_path
from invokeai.backend.model_manager.taxonomy import BaseModelType

REPO_ROOT = Path(invokeai.__file__).parent.parent

_spec = importlib.util.spec_from_file_location("new_architecture", REPO_ROOT / "scripts" / "new_architecture.py")
assert _spec and _spec.loader
scaffold = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scaffold)

BASES = sorted(generative_bases(), key=lambda b: b.value)


@pytest.mark.parametrize("base", BASES, ids=lambda b: b.value)
def test_module_name_matches_the_registry(base: BaseModelType) -> None:
    """The scaffolder and `registry.defs_module_path()` must agree on where a definition lives."""
    assert defs_module_path(base).endswith(f"/defs/{scaffold.module_name(base.value)}.py")


@pytest.mark.parametrize("base", BASES, ids=lambda b: b.value)
def test_the_generated_import_line_is_the_one_actually_used(base: BaseModelType) -> None:
    """What the scaffolder would add to `architectures/__init__.py` is what is already there.

    Catches the drift that would otherwise go unnoticed: someone changes the import style in the
    aggregate, and the scaffolder keeps emitting the old shape.
    """
    aggregate = (REPO_ROOT / "invokeai" / "backend" / "architectures" / "__init__.py").read_text(encoding="utf-8")
    expected = scaffold.defs_import_line(base.value).strip()

    assert expected in {line.strip() for line in aggregate.splitlines()}


STARTER_MODELS_DIR = REPO_ROOT / "invokeai" / "backend" / "model_manager" / "starter_models"


@pytest.mark.parametrize("base", BASES, ids=lambda b: b.value)
def test_the_starter_models_import_line_is_the_one_actually_used(base: BaseModelType) -> None:
    """Starter models are optional -- SD2 ships none -- so this only binds architectures that have a
    module. Where one exists, the scaffolder must emit the import the catalog actually uses.
    """
    module = STARTER_MODELS_DIR / f"{scaffold.module_name(base.value)}.py"
    if not module.exists():
        pytest.skip(f"{base.value} ships no starter models")

    catalog = (STARTER_MODELS_DIR / "__init__.py").read_text(encoding="utf-8")

    assert scaffold.starter_import_line(base.value) in catalog


def test_sd2_is_the_only_architecture_without_starter_models() -> None:
    """Pinned so the skip above stays a fact rather than a way for modules to go missing unnoticed."""
    without = {
        base.value for base in BASES if not (STARTER_MODELS_DIR / f"{scaffold.module_name(base.value)}.py").exists()
    }

    assert without == {"sd-2"}


def test_the_rendered_defs_module_is_valid_python() -> None:
    """It is a template with placeholders, but it must still parse -- a contributor edits it, and a
    syntax error in generated code is a bad first impression of the pattern.
    """
    source = scaffold.render_defs_module("NewModel", "new-model")

    tree = ast.parse(source)
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "register"]

    assert len(calls) == 1
    declared = {getattr(arg.func, "id", None) for arg in calls[0].args if isinstance(arg, ast.Call)}
    assert declared == {"LatentSpaceFacet", "ConditioningFacet"}, (
        "the template must scaffold exactly the required facets: leaving one out moves the failure "
        "from `validate()` at boot to somewhere later"
    )


def test_the_rendered_starter_module_is_valid_python() -> None:
    ast.parse(scaffold.render_starter_models_module("NewModel", "new-model"))


def test_the_template_scaffolds_every_required_facet() -> None:
    """Whatever declares itself REQUIRED must appear in the template.

    Adding a required facet without updating the scaffolder would produce definition modules that
    cannot boot the app.
    """
    from invokeai.backend.architectures.facet import Facet

    required = {facet.__name__ for facet in Facet.FACET_TYPES if facet.REQUIRED}
    source = scaffold.render_defs_module("NewModel", "new-model")
    missing = sorted(name for name in required if f"{name}(" not in source)

    assert missing == [], f"scripts/new_architecture.py does not scaffold: {missing}"


@pytest.mark.parametrize(
    ("enum_name", "enum_value"),
    [("newmodel", "new-model"), ("New_Model", "new-model"), ("NewModel", "New-Model"), ("NewModel", "new_model")],
)
def test_bad_identifiers_are_rejected(enum_name: str, enum_value: str) -> None:
    with pytest.raises(SystemExit):
        scaffold.main(["--enum-name", enum_name, "--enum-value", enum_value])


def test_a_dry_run_writes_nothing(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    before = (REPO_ROOT / "invokeai" / "backend" / "architectures" / "__init__.py").read_text(encoding="utf-8")

    scaffold.main(["--enum-name", "ScaffoldProbe", "--enum-value", "scaffold-probe"])

    after = (REPO_ROOT / "invokeai" / "backend" / "architectures" / "__init__.py").read_text(encoding="utf-8")
    assert after == before
    assert not (REPO_ROOT / "invokeai" / "backend" / "architectures" / "defs" / "scaffold_probe.py").exists()
    assert "would write" in capsys.readouterr().out
