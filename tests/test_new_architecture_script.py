"""The scaffolder generates valid stubs, and its residual list stays honest."""

import ast
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from new_architecture import (  # noqa: E402
    defs_module,
    derive_residual_edits,
    invocations_package,
    planned_files,
    starter_models_module,
)

REQUIRED_FACETS = {"LatentSpaceFacet", "ConditioningFacet", "DefaultSettingsFacet", "ModalityFacet", "FeaturesFacet"}


@pytest.mark.parametrize("render", [defs_module, invocations_package, starter_models_module], ids=lambda f: f.__name__)
def test_every_stub_is_valid_python(render) -> None:  # type: ignore[no-untyped-def]
    ast.parse(render("new-model", "NewModel"))


def test_the_declaration_carries_every_required_facet() -> None:
    """A stub missing one would fail at boot with a message about that facet rather than about the
    stub, which is a worse first experience than the TODOs."""
    tree = ast.parse(defs_module("new-model", "NewModel"))
    called = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
    assert REQUIRED_FACETS <= called, sorted(REQUIRED_FACETS - called)


def test_the_declaration_is_obviously_unfinished() -> None:
    """It must not look plausible. Someone who runs the scaffolder and forgets to fill it in should
    ship nothing — the placeholder projection is a single black row."""
    source = defs_module("new-model", "NewModel")
    assert source.count("TODO") >= 5
    assert "[0.0, 0.0, 0.0]" in source


def test_the_slug_convention_matches_the_registry() -> None:
    """`-` becomes `_`, the same rule `registry.defs_module_path` computes."""
    paths = set(planned_files("new-model", "NewModel"))
    assert "invokeai/backend/architectures/defs/new_model.py" in paths
    assert "invokeai/app/invocations/new_model/__init__.py" in paths
    assert "invokeai/backend/model_manager/starter_models/new_model.py" in paths


def test_the_residual_list_is_derived_from_the_tree() -> None:
    """Not a written-down list. It has already shrunk twice while this series ran, and a hardcoded
    one would still be naming files that no longer dispatch on base."""
    residual = dict(derive_residual_edits(REPO_ROOT / "invokeai"))

    # Still dispatching: one config class per architecture is inherent to how configs work.
    assert "invokeai/backend/model_manager/configs/main.py" in residual

    # No longer dispatching — each of these was a chain the registry absorbed. If one reappears
    # here, a facet has been bypassed.
    for absorbed in (
        "invokeai/app/util/step_callback.py",
        "invokeai/app/api/dependencies.py",
        "invokeai/app/invocations/ideal_size.py",
    ):
        assert absorbed not in residual, f"{absorbed} dispatches on base again"


def test_the_registry_itself_is_never_listed_as_a_cost() -> None:
    """`architectures/` names every base by construction; listing it would drown the real entries."""
    residual = dict(derive_residual_edits(REPO_ROOT / "invokeai"))
    assert not [path for path in residual if path.startswith("invokeai/backend/architectures/")]
