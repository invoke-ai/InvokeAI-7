"""The architecture registry.

Every model architecture registers itself once, from its own `defs/<base>.py` module, declaring the
facets it supports. Core code then reads those facts through narrow accessors instead of branching
on `BaseModelType`, so adding an architecture means adding a file rather than editing a dispatch
chain in a dozen core modules.

This module imports only `facet` and `taxonomy`; it deliberately knows nothing about any concrete
facet. Which facets are mandatory is declared by the facet classes themselves, via
`Facet.REQUIRED`.
"""

from typing import Final, TypeVar

from invokeai.backend.architectures.facet import Facet
from invokeai.backend.model_manager.taxonomy import BaseModelType

FacetT = TypeVar("FacetT", bound=Facet)

_ARCHITECTURES: Final[dict[BaseModelType, dict[type[Facet], Facet]]] = {}
"""Every registered architecture and the facets it declares, both in registration order."""

_DEFS_DIR: Final = "invokeai/backend/architectures/defs"
_AGGREGATE: Final = "invokeai/backend/architectures/__init__.py"

_NOT_ARCHITECTURES: Final = frozenset(
    {
        BaseModelType.Any,
        BaseModelType.External,
        BaseModelType.Unknown,
    }
)
"""`Any` is the null base for architecture-agnostic models, `Unknown` is the probe's fallback, and
`External` is a hosting mode whose capabilities come per-record from `ExternalModelCapabilities`.
None of the three is a model architecture, so none of them may be registered."""


class ArchitectureError(ValueError):
    """Raised for registry misuse and for missing facets.

    Subclasses `ValueError` deliberately: it replaces `raise ValueError(f"Unsupported base model: ...")`
    call sites, so any existing `except ValueError` handler keeps behaving identically.
    """


def defs_module_path(base: BaseModelType) -> str:
    """The repo-relative path of the definition module for `base`.

    The convention is the base's enum *value* with dashes replaced by underscores -- derived rather
    than tabulated, so it cannot drift from reality. The enum value is the right thing to derive
    from: it is persisted in the database and can therefore never change.
    `tests/backend/architectures/test_registry_completeness.py` asserts that the files present in
    `defs/` are exactly the registered architectures, in both directions.
    """
    return f"{_DEFS_DIR}/{base.value.replace('-', '_')}.py"


def register(base: BaseModelType, *facets: Facet) -> None:
    """Register an architecture and the facets it declares.

    Called exactly once per `defs/<base>.py`, at import time.
    """
    if base in _NOT_ARCHITECTURES:
        raise ArchitectureError(
            f"'{base.value}' is a sentinel or a hosting mode, not a model architecture, and must not be registered."
        )
    if base in _ARCHITECTURES:
        raise ArchitectureError(
            f"Architecture '{base.value}' is already registered. Each architecture is registered exactly once, "
            f"from {defs_module_path(base)}."
        )

    declared: dict[type[Facet], Facet] = {}
    for facet in facets:
        facet_type = type(facet)
        if facet_type in declared:
            raise ArchitectureError(
                f"Architecture '{base.value}' declares {facet_type.__name__} more than once "
                f"in {defs_module_path(base)}."
            )
        declared[facet_type] = facet

    _ARCHITECTURES[base] = declared


def get(base: BaseModelType, facet_type: type[FacetT]) -> FacetT | None:
    """The facet of type `facet_type` that `base` declares, or None if it declares none.

    Use `require()` instead unless absence is a valid state that the caller handles.

    Lookup is by exact runtime type, not by subclass -- `get(base, ParentFacet)` will not find a
    registered `ChildFacet`. That is the price of an O(1), unambiguous lookup, and it is why facet
    classes are not meant to be subclassed.
    """
    facet = _ARCHITECTURES.get(base, {}).get(facet_type)
    # isinstance narrows `Facet | None` to `FacetT`. The registry keys by exact runtime type, so a
    # hit always passes; the check exists to satisfy the type system without a cast.
    return facet if isinstance(facet, facet_type) else None


def require(base: BaseModelType, facet_type: type[FacetT]) -> FacetT:
    """The facet of type `facet_type` that `base` declares.

    Raises `ArchitectureError` naming the file to edit if it is missing. This replaces the
    `raise ValueError(f"Unsupported base model: {base}")` pattern, which told the person hitting it
    -- usually mid-generation -- nothing about how to fix it.
    """
    facet = get(base, facet_type)
    if facet is not None:
        return facet

    if base not in _ARCHITECTURES:
        raise ArchitectureError(
            f"Architecture '{base.value}' is not registered, so it cannot declare {facet_type.__name__}. "
            f"Create {defs_module_path(base)} with a "
            f"`register(BaseModelType.{base.name}, {facet_type.__name__}(...))` call, then add the module "
            f"to the import list in {_AGGREGATE}."
        )

    raise ArchitectureError(
        f"Architecture '{base.value}' does not declare {facet_type.__name__}. "
        f"Add {facet_type.__name__}(...) to the `register(...)` call in {defs_module_path(base)}."
    )


def generative_bases() -> frozenset[BaseModelType]:
    """The registered architectures.

    Registration *is* the definition of "generative base". There is deliberately no
    `set(BaseModelType) - {Any, External, Unknown}` predicate anywhere in production code; that
    equality is asserted once, in CI, by
    `tests/backend/architectures/test_registry_completeness.py`.
    """
    return frozenset(_ARCHITECTURES)


def facets_of(base: BaseModelType) -> tuple[Facet, ...]:
    """Every facet `base` declares, in declaration order. For diagnostics and tests."""
    return tuple(_ARCHITECTURES.get(base, {}).values())


def validate() -> None:
    """Fail if any registered architecture is missing a facet that declares itself required.

    Idempotent and free of side effects. Called at boot from `run_app.py` and from
    `ApiDependencies.initialize()`, so that an incompletely registered architecture cannot start the
    app -- rather than failing later, mid-generation, on the first request that happens to need the
    missing facet.
    """
    required = [facet_type for facet_type in Facet.FACET_TYPES if facet_type.REQUIRED]
    problems = [
        f"  - '{base.value}' does not declare {facet_type.__name__}; add it to the `register(...)` call "
        f"in {defs_module_path(base)}"
        for base in sorted(_ARCHITECTURES, key=lambda b: b.value)
        for facet_type in required
        if facet_type not in _ARCHITECTURES[base]
    ]
    if problems:
        raise ArchitectureError("Incomplete architecture registry:\n" + "\n".join(problems))
