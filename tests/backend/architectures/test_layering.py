"""Import-layering policy for `invokeai.backend.architectures`, enforced over the whole package.

The registry only stays useful if its dependency direction stays one-way. Two failures in
particular are cheap to make and expensive to debug:

- a definition module importing the aggregate `invokeai.backend.architectures`, which imports the
  definition modules -- a circular import onto a partially initialised module, surfacing at boot as
  an ImportError with no obvious cause;
- core code reaching past the facade into `architectures.registry` or `architectures.facets.*`,
  which quietly makes the public surface whatever anyone happened to import.

`tests/test_imports.py` cannot catch either: it imports every module into one shared process, where
an order-dependent cycle passes. This test reads the source instead.

Modelled on `invokeai/frontend/webv2/src/architecture/dependencyPolicy.test.ts`, including its two
load-bearing habits: named rules in the violation string, and self-tests of the checker itself -- a
walker with a bug reports zero violations and stays green forever, which is this test's only
realistic failure mode.
"""

import ast
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path

import invokeai

INVOKEAI_DIR = Path(invokeai.__file__).parent
REPO_ROOT = INVOKEAI_DIR.parent

ARCH = "invokeai.backend.architectures"
ARCH_FACET = f"{ARCH}.facet"
ARCH_REGISTRY = f"{ARCH}.registry"
ARCH_FACETS = f"{ARCH}.facets"
ARCH_DEFS = f"{ARCH}.defs"
TAXONOMY = "invokeai.backend.model_manager.taxonomy"
CONDITIONING_DATA = "invokeai.backend.stable_diffusion.diffusion.conditioning_data"

FACET_ALLOWLIST: tuple[str, ...] = ()
"""`facet.py` is the bottom of the package: it imports nothing from `invokeai` at all."""

REGISTRY_ALLOWLIST = (ARCH_FACET, TAXONOMY)
"""`registry.py` knows the marker class and the enum, and deliberately no concrete facet -- which
is why `Facet` lives in its own module. Were `Facet` defined in `registry.py`, the edge
`facets -> registry` and the edge `registry -> facets` would be one line apart."""

FACETS_ALLOWLIST = (ARCH_FACET, ARCH_REGISTRY, TAXONOMY)
DEFS_ALLOWLIST = (ARCH_FACET, ARCH_FACETS, ARCH_REGISTRY, TAXONOMY, CONDITIONING_DATA)
"""What a definition module may import from `invokeai.*`.

Deliberately narrower than the target state described in `.ideas/Backend Modularization Plan.md`,
so that every widening is a visible, reviewable line in the PR that needs it rather than a blanket
permission granted up front. `conditioning_data` was added for `ConditioningFacet`; it is safe
because it is close to a leaf -- its only `invokeai` import is `regional_prompt_data`, which imports
nothing from `invokeai` at all, so a definition module cannot reach back into the registry through
it.
"""

EXCLUDED = (
    INVOKEAI_DIR / "frontend",
    # The same vendored trees `[tool.ruff] exclude` skips.
    INVOKEAI_DIR / "backend" / "image_util" / "mediapipe_face",
    INVOKEAI_DIR / "backend" / "image_util" / "mlsd",
    INVOKEAI_DIR / "backend" / "image_util" / "normal_bae",
    INVOKEAI_DIR / "backend" / "image_util" / "pidi",
    INVOKEAI_DIR / "backend" / "image_util" / "imwatermark",
)

_RELATIVE = "<relative-import>"


def _within(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(f"{prefix}.")


@lru_cache(maxsize=None)
def _is_module(dotted: str) -> bool:
    """Whether `dotted` names a real module or package on disk."""
    path = REPO_ROOT.joinpath(*dotted.split("."))
    return path.with_suffix(".py").is_file() or (path / "__init__.py").is_file()


def collect_imports(source: str) -> Iterator[str]:
    """Every module referenced by an import in `source`.

    `from a.b import c` yields `a.b` and, when `a.b.c` is itself a module on disk, `a.b.c` too --
    that is how `from invokeai.backend.architectures import defs` reaches a subpackage. The
    on-disk check is what keeps `from invokeai.backend.architectures import validate` (a function,
    not a module) from being misread as reaching past the facade.

    Imports inside `if TYPE_CHECKING:` are included deliberately: a type-only edge is still an
    architectural edge, and it becomes a runtime edge the moment someone drops the guard.
    """
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                yield _RELATIVE
                continue
            module = node.module or ""
            yield module
            for alias in node.names:
                candidate = f"{module}.{alias.name}"
                if _is_module(candidate):
                    yield candidate


def check_source(module: str, source: str) -> list[str]:
    """Every layering rule `module` breaks, as `"<rule>: <module> -> <imported>"`."""
    violations: list[str] = []
    for imported in collect_imports(source):
        if imported == _RELATIVE:
            if _within(module, ARCH):
                violations.append(f"no-relative-imports: {module} -> {imported}")
            continue
        if not imported.startswith("invokeai."):
            continue

        if _within(module, ARCH_DEFS):
            if not any(_within(imported, allowed) for allowed in DEFS_ALLOWLIST):
                violations.append(f"defs-allowlist: {module} -> {imported}")
        elif module == ARCH_FACET:
            if not any(_within(imported, allowed) for allowed in FACET_ALLOWLIST):
                violations.append(f"facet-is-a-leaf: {module} -> {imported}")
        elif module == ARCH_REGISTRY:
            if not any(_within(imported, allowed) for allowed in REGISTRY_ALLOWLIST):
                violations.append(f"registry-is-a-leaf: {module} -> {imported}")
        elif _within(module, ARCH_FACETS):
            if not any(_within(imported, allowed) for allowed in FACETS_ALLOWLIST):
                violations.append(f"facets-allowlist: {module} -> {imported}")
        elif module == ARCH:
            if not _within(imported, ARCH):
                violations.append(f"aggregate-is-a-facade: {module} -> {imported}")
        elif _within(imported, ARCH) and imported != ARCH:
            violations.append(f"aggregate-only: {module} -> {imported}")
    return violations


def _module_name(path: Path) -> str:
    parts = path.relative_to(REPO_ROOT).with_suffix("").parts
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def _production_files() -> Iterator[Path]:
    for path in INVOKEAI_DIR.rglob("*.py"):
        if not any(excluded in path.parents for excluded in EXCLUDED):
            yield path


# --- self-tests: without these, a broken walker reports nothing and stays green forever ----------


def test_checker_flags_a_defs_module_reaching_into_core() -> None:
    assert check_source(f"{ARCH_DEFS}.wan", "from invokeai.app.util.step_callback import calc_percentage") == [
        f"defs-allowlist: {ARCH_DEFS}.wan -> invokeai.app.util.step_callback"
    ]


def test_checker_flags_a_defs_module_importing_the_aggregate() -> None:
    # The circular-import trap: defs modules must reach the registry directly, never through the
    # package __init__ that imports them.
    assert check_source(f"{ARCH_DEFS}.wan", "from invokeai.backend.architectures import register") == [
        f"defs-allowlist: {ARCH_DEFS}.wan -> {ARCH}"
    ]


def test_checker_flags_core_reaching_past_the_facade() -> None:
    assert check_source(
        "invokeai.app.util.step_callback",
        "from invokeai.backend.architectures.facets.latent_space import get_latent_space",
    ) == [f"aggregate-only: invokeai.app.util.step_callback -> {ARCH_FACETS}.latent_space"]


def test_checker_flags_a_type_checking_only_edge() -> None:
    source = """
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from invokeai.backend.architectures import registry
"""
    assert check_source("invokeai.app.invocations.denoise_latents", source) == [
        f"aggregate-only: invokeai.app.invocations.denoise_latents -> {ARCH_REGISTRY}"
    ]


def test_checker_flags_a_relative_import_inside_the_package() -> None:
    assert check_source(f"{ARCH_DEFS}.wan", "from ..registry import register") == [
        f"no-relative-imports: {ARCH_DEFS}.wan -> {_RELATIVE}"
    ]


def test_checker_flags_the_registry_importing_a_concrete_facet() -> None:
    assert check_source(ARCH_REGISTRY, "from invokeai.backend.architectures.facets.unet import UNetDownscaleFacet") == [
        f"registry-is-a-leaf: {ARCH_REGISTRY} -> {ARCH_FACETS}.unet"
    ]


def test_checker_permits_the_registry_importing_the_marker_class() -> None:
    # `facet` (the marker module) is not `facets` (the concrete-facet package). The distinction is
    # a single character, so it is worth pinning.
    assert check_source(ARCH_REGISTRY, "from invokeai.backend.architectures.facet import Facet") == []


def test_checker_flags_the_marker_module_importing_anything() -> None:
    assert check_source(ARCH_FACET, "from invokeai.backend.model_manager.taxonomy import BaseModelType") == [
        f"facet-is-a-leaf: {ARCH_FACET} -> {TAXONOMY}"
    ]


def test_checker_permits_the_facade_import_and_third_party() -> None:
    # `validate` is a function, not a module, so the on-disk check must not mistake it for one.
    assert (
        check_source(
            "invokeai.app.util.step_callback",
            "import torch\nfrom invokeai.backend.architectures import validate\n",
        )
        == []
    )


def test_checker_permits_the_aggregate_importing_its_own_submodules() -> None:
    assert (
        check_source(
            ARCH,
            "from invokeai.backend.architectures.defs import wan\nfrom invokeai.backend.architectures.facet import Facet\n",
        )
        == []
    )


# --- the policy itself ---------------------------------------------------------------------------


def test_no_layering_violations() -> None:
    violations = sorted(
        violation
        for path in _production_files()
        for violation in check_source(_module_name(path), path.read_text(encoding="utf-8"))
    )

    assert violations == []
