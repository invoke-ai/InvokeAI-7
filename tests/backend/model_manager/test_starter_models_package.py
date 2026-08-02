"""Structural guards for the starter-model package.

`starter_models.py` was 2428 lines holding 185 definitions, the curated display order and the
bundles. The definitions now live one module per architecture; what stayed behind in `__init__` is
what cannot be derived from them.

The order in particular: `STARTER_MODELS` follows neither base nor model type nor definition order
-- 179 entries in 47 contiguous runs by base -- so it is curated product data, and an aggregator
that concatenated the per-architecture modules would silently reorder what the model manager shows.
Leaving it explicit means the new risk is the opposite one: an entry defined in an architecture
module that never reaches the list. That is what `test_every_entry_is_reachable` catches.
"""

import ast
from pathlib import Path

import pytest

from invokeai.backend.model_manager import starter_models
from invokeai.backend.model_manager.starter_models import STARTER_BUNDLES, STARTER_MODELS
from invokeai.backend.model_manager.starter_models.types import (
    StarterModel,
    StarterModelBundle,
    StarterModelWithoutDependencies,
)
from invokeai.backend.model_manager.taxonomy import BaseModelType

PACKAGE = Path(starter_models.__file__).parent
LEAF_MODULES = {"types", "common"}
NON_ARCHITECTURE_MODULES = LEAF_MODULES | {"external", "__init__"}

HIDDEN_DEPENDENCIES = {
    "clip_vit_l_image_encoder",
    "cyberrealistic_negative",
    "ip_adapter_sd_image_encoder",
    "ip_adapter_sdxl_image_encoder",
}
"""Installed as a side effect of something else, never offered on their own.

Nobody picks a CLIP image encoder from the model manager; it arrives with the IP-Adapter that needs
it. So these are referenced as dependencies but deliberately kept out of `STARTER_MODELS`.
"""

UNREFERENCED = {"esrgan_srx4", "flux_kontext"}
"""Defined and reachable by import, but listed nowhere, in no bundle, and depended on by nothing.

Surfaced by the split rather than caused by it -- both predate this change. Left in place: removing
them would be a content change, and `flux_kontext` in particular looks like a model someone meant
to offer. Worth a follow-up decision, not a silent deletion inside a mechanical move.
"""

DEPENDENCY_ONLY = HIDDEN_DEPENDENCIES | UNREFERENCED


def _module_files() -> list[Path]:
    return sorted(PACKAGE.glob("*.py"))


def _entries_defined_in(path: Path) -> set[str]:
    """Top-level names bound to a StarterModel(...) call in `path`."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in tree.body:
        if not isinstance(node, ast.Assign) or not isinstance(node.targets[0], ast.Name):
            continue
        value = node.value
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and "StarterModel" in value.func.id:
            names.add(node.targets[0].id)
    return names


def _imported_package_modules(path: Path) -> set[str]:
    """Sibling modules of this package that `path` imports."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    prefix = "invokeai.backend.model_manager.starter_models"
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith(f"{prefix}."):
            modules.add(node.module[len(prefix) + 1 :])
    return modules


# --- structure ------------------------------------------------------------------------------------


def test_the_monolith_is_gone() -> None:
    assert not (PACKAGE.parent / "starter_models.py").exists()
    assert (PACKAGE / "__init__.py").is_file()


@pytest.mark.parametrize(
    "path", [p for p in _module_files() if p.stem not in NON_ARCHITECTURE_MODULES], ids=lambda p: p.stem
)
def test_architecture_modules_import_only_the_leaf_modules(path: Path) -> None:
    """No architecture module may depend on another.

    This is what makes the split a DAG. Only five of the 97 dependency edges cross architectures --
    all of them VAEs -- and those targets live in `common`, which is why no cycle is possible.
    """
    assert _imported_package_modules(path) <= LEAF_MODULES


def test_common_and_types_depend_on_nothing_in_the_package_above_them() -> None:
    assert _imported_package_modules(PACKAGE / "types.py") == set()
    assert _imported_package_modules(PACKAGE / "common.py") <= {"types"}


def test_every_entry_is_defined_exactly_once() -> None:
    seen: dict[str, str] = {}
    duplicates = []
    for path in _module_files():
        if path.stem == "__init__":
            continue
        for name in _entries_defined_in(path):
            if name in seen:
                duplicates.append(f"{name}: {seen[name]} and {path.stem}")
            seen[name] = path.stem

    assert duplicates == []
    assert len(seen) == 185


def test_every_entry_is_reachable() -> None:
    """Defined in an architecture module but never listed -- the failure this structure invites."""
    defined = {name for path in _module_files() if path.stem != "__init__" for name in _entries_defined_in(path)}
    listed = {name for name in defined if getattr(starter_models, name) in STARTER_MODELS}

    assert defined - listed == DEPENDENCY_ONLY


def test_every_entry_is_re_exported() -> None:
    """Individual entries are imported by name elsewhere -- `siglip` in flux_redux, three image
    encoders in ip_adapter -- so the package must keep exposing all of them.
    """
    for name in ("siglip", "clip_vit_l_image_encoder", "ip_adapter_sd_image_encoder", "ip_adapter_sdxl_image_encoder"):
        assert isinstance(getattr(starter_models, name), StarterModelWithoutDependencies)

    for path in _module_files():
        if path.stem == "__init__":
            continue
        for name in _entries_defined_in(path):
            assert name in starter_models.__all__, f"{name} ({path.stem}) is missing from __all__"


# --- the catalog itself ----------------------------------------------------------------------------


def test_sources_are_unique() -> None:
    # The import-time assertion that used to sit at the bottom of the monolith, as a real test.
    sources = [m.source for m in STARTER_MODELS]
    assert len(sources) == len(set(sources))
    assert len(sources) == 179


def test_every_dependency_resolves_to_a_known_entry() -> None:
    """A dependency points either at an offered starter model or at a deliberately hidden one.

    Dangling dependencies are structurally impossible here, because `dependencies` holds object
    references -- an unknown name is an ImportError, not a runtime surprise. That is the property
    the plan wanted to reconstruct with resolvable string ids; keeping the references keeps it for
    free.
    """
    offered = {m.source for m in STARTER_MODELS}
    hidden = {getattr(starter_models, name).source for name in HIDDEN_DEPENDENCIES}
    unknown = sorted(
        f"{m.name} -> {dep.name}"
        for m in STARTER_MODELS
        for dep in (m.dependencies or [])
        if dep.source not in offered | hidden
    )

    assert unknown == []


def test_bundle_keys_are_preserved_exactly() -> None:
    """Ten bundles keyed by `BaseModelType`, two by plain strings.

    Wan has no base-keyed bundle at all -- it ships `wan_t2v` and `wan_i2v` instead. These keys are
    serialised into the `/starter_models` response, so they are load-bearing.
    """
    string_keys = {k for k in STARTER_BUNDLES if not isinstance(k, BaseModelType)}

    assert string_keys == {"wan_t2v", "wan_i2v"}
    assert len(STARTER_BUNDLES) == 12
    assert all(isinstance(v, StarterModelBundle) for v in STARTER_BUNDLES.values())


def test_bundle_models_are_registered() -> None:
    sources = {m.source for m in STARTER_MODELS}
    missing = sorted(
        f"{key}: {model.name}"
        for key, bundle in STARTER_BUNDLES.items()
        for model in bundle.models
        if model.source not in sources
    )

    assert missing == []


def test_the_public_types_are_unchanged() -> None:
    """`StarterModel` and friends are served by `GET /starter_models` and appear in openapi.json.

    In particular `dependencies` stays a list of models rather than becoming a list of ids: the
    plan proposed string ids to break import cycles, but there are none to break, and the change
    would have altered the public schema.
    """
    field = StarterModel.model_fields["dependencies"]
    assert field.annotation == list[StarterModelWithoutDependencies] | None
