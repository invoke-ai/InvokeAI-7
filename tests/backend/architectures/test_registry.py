"""Unit tests for the registry mechanics.

These run against an empty registry and purpose-built dummy facets, never against the real
architectures -- so they keep passing as architectures and facets are added.
"""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from invokeai.backend.architectures import registry
from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.registry import ArchitectureError
from invokeai.backend.model_manager.taxonomy import BaseModelType


@dataclass(frozen=True)
class _AlphaFacet(Facet):
    value: int = 1


@dataclass(frozen=True)
class _BetaFacet(Facet):
    value: str = "beta"


@pytest.fixture
def isolated_registry(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Run a test against an empty registry, and restore the facet-type table afterwards.

    Both are process-global and mutated at class-creation/import time. Defining a facet subclass
    anywhere -- even inside a test function -- adds it to `Facet.FACET_TYPES` permanently. Without
    the restore, a dummy facet with `REQUIRED = True` would make `validate()` fail for every real
    architecture in every test that runs afterwards.
    """
    monkeypatch.setattr(registry, "_ARCHITECTURES", {})
    facet_types = dict(Facet.FACET_TYPES)
    yield
    Facet.FACET_TYPES.clear()
    Facet.FACET_TYPES.update(facet_types)


def test_register_and_get_roundtrip(isolated_registry: None) -> None:
    facet = _AlphaFacet(value=7)
    registry.register(BaseModelType.Flux, facet)

    assert registry.get(BaseModelType.Flux, _AlphaFacet) is facet


def test_get_returns_none_for_an_undeclared_facet(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _AlphaFacet())

    assert registry.get(BaseModelType.Flux, _BetaFacet) is None


def test_get_returns_none_for_an_unregistered_base(isolated_registry: None) -> None:
    assert registry.get(BaseModelType.Flux, _AlphaFacet) is None


def test_registering_a_base_twice_raises(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _AlphaFacet())

    with pytest.raises(ArchitectureError, match=r"already registered.*defs/flux\.py"):
        registry.register(BaseModelType.Flux, _BetaFacet())


def test_declaring_the_same_facet_type_twice_raises(isolated_registry: None) -> None:
    with pytest.raises(ArchitectureError, match=r"_AlphaFacet more than once.*defs/flux\.py"):
        registry.register(BaseModelType.Flux, _AlphaFacet(value=1), _AlphaFacet(value=2))


def test_a_failed_registration_leaves_no_partial_entry(isolated_registry: None) -> None:
    with pytest.raises(ArchitectureError):
        registry.register(BaseModelType.Flux, _AlphaFacet(), _AlphaFacet())

    assert BaseModelType.Flux not in registry.generative_bases()


@pytest.mark.parametrize("base", [BaseModelType.Any, BaseModelType.External, BaseModelType.Unknown])
def test_sentinel_bases_cannot_be_registered(isolated_registry: None, base: BaseModelType) -> None:
    with pytest.raises(ArchitectureError, match="not a model architecture"):
        registry.register(base, _AlphaFacet())


def test_require_returns_the_declared_facet(isolated_registry: None) -> None:
    facet = _AlphaFacet(value=3)
    registry.register(BaseModelType.Flux, facet)

    assert registry.require(BaseModelType.Flux, _AlphaFacet) is facet


def test_require_names_the_defs_module_when_the_facet_is_missing(isolated_registry: None) -> None:
    registry.register(BaseModelType.ZImage, _AlphaFacet())

    with pytest.raises(ArchitectureError) as exc_info:
        registry.require(BaseModelType.ZImage, _BetaFacet)

    message = str(exc_info.value)
    assert "'z-image' does not declare _BetaFacet" in message
    assert "invokeai/backend/architectures/defs/z_image.py" in message


def test_require_names_the_defs_module_and_the_aggregate_when_the_base_is_unregistered(
    isolated_registry: None,
) -> None:
    with pytest.raises(ArchitectureError) as exc_info:
        registry.require(BaseModelType.ZImage, _BetaFacet)

    message = str(exc_info.value)
    assert "'z-image' is not registered" in message
    # The fix-it message must be actionable without reading any other file: it names the module to
    # create, the exact call to write, and the import list to add it to.
    assert "Create invokeai/backend/architectures/defs/z_image.py" in message
    assert "register(BaseModelType.ZImage, _BetaFacet(...))" in message
    assert "invokeai/backend/architectures/__init__.py" in message


def test_architecture_error_is_a_value_error() -> None:
    # It replaces `raise ValueError(f"Unsupported base model: ...")` call sites, so any existing
    # `except ValueError` handler must keep behaving identically.
    assert issubclass(ArchitectureError, ValueError)


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        (BaseModelType.StableDiffusion1, "invokeai/backend/architectures/defs/sd_1.py"),
        (BaseModelType.StableDiffusionXLRefiner, "invokeai/backend/architectures/defs/sdxl_refiner.py"),
        (BaseModelType.Flux, "invokeai/backend/architectures/defs/flux.py"),
        (BaseModelType.ZImage, "invokeai/backend/architectures/defs/z_image.py"),
        (BaseModelType.Ideogram4, "invokeai/backend/architectures/defs/ideogram_4.py"),
        (BaseModelType.Krea2, "invokeai/backend/architectures/defs/krea_2.py"),
    ],
)
def test_defs_module_path_derives_from_the_enum_value(base: BaseModelType, expected: str) -> None:
    assert registry.defs_module_path(base) == expected


def test_facets_of_preserves_declaration_order(isolated_registry: None) -> None:
    alpha, beta = _AlphaFacet(), _BetaFacet()
    registry.register(BaseModelType.Flux, beta, alpha)

    assert registry.facets_of(BaseModelType.Flux) == (beta, alpha)


def test_facets_of_is_empty_for_an_unregistered_base(isolated_registry: None) -> None:
    assert registry.facets_of(BaseModelType.Flux) == ()


def test_generative_bases_is_exactly_the_registered_set(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux)
    registry.register(BaseModelType.Wan, _AlphaFacet())

    assert registry.generative_bases() == frozenset({BaseModelType.Flux, BaseModelType.Wan})


def test_validate_ignores_optional_facets(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux)
    registry.register(BaseModelType.Wan, _AlphaFacet())

    registry.validate()


def test_validate_reports_every_architecture_missing_a_required_facet(isolated_registry: None) -> None:
    @dataclass(frozen=True)
    class _MandatoryFacet(Facet):
        REQUIRED = True

    registry.register(BaseModelType.Wan)
    registry.register(BaseModelType.Flux, _MandatoryFacet())
    registry.register(BaseModelType.ZImage, _AlphaFacet())

    with pytest.raises(ArchitectureError) as exc_info:
        registry.validate()

    message = str(exc_info.value)
    assert "Incomplete architecture registry:" in message
    assert "'wan' does not declare _MandatoryFacet" in message
    assert "invokeai/backend/architectures/defs/wan.py" in message
    assert "'z-image' does not declare _MandatoryFacet" in message
    assert "'flux'" not in message
    # Sorted by enum value, so the report is stable across runs regardless of import order.
    assert message.index("'wan'") < message.index("'z-image'")


def test_validate_passes_once_every_architecture_declares_the_required_facet(isolated_registry: None) -> None:
    @dataclass(frozen=True)
    class _MandatoryFacet(Facet):
        REQUIRED = True

    registry.register(BaseModelType.Wan, _MandatoryFacet())
    registry.register(BaseModelType.Flux, _MandatoryFacet())

    registry.validate()
