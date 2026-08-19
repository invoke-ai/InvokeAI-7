"""Registry mechanics, exercised against throwaway facets rather than the real ones.

Using dummy facets keeps these tests from restating what production declares — otherwise they would
fail on every legitimate change to an architecture, and pass for the wrong reason when a facet is
quietly dropped.
"""

from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from invokeai.backend.architectures import registry
from invokeai.backend.architectures.facet import Facet
from invokeai.backend.model_manager.taxonomy import BaseModelType


@dataclass(frozen=True)
class _Colour(Facet):
    name: str


@dataclass(frozen=True)
class _Size(Facet):
    value: int


@dataclass(frozen=True)
class _Mandatory(Facet):
    REQUIRED = True


# `Facet.__init_subclass__` put the three above into the real `Facet.FACET_TYPES` the moment this
# module was imported, and `validate()` reads that collection to decide what every architecture must
# declare — so leaving `_Mandatory` in it would make the real registry fail validation for the rest
# of the session. Undone here rather than in a fixture: the damage is done at import time, which is
# before any fixture runs.
for _test_double in (_Colour, _Size, _Mandatory):
    Facet.FACET_TYPES.pop(_test_double, None)


@pytest.fixture
def isolated_registry(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """An empty registry, and an empty facet-type collection.

    Both have to be reset. `Facet.FACET_TYPES` is class state filled at import time by every facet
    in the codebase, so leaving it alone would let a real `REQUIRED` facet leak into `validate()`
    here and fail against architectures this test never registered.
    """
    monkeypatch.setattr(registry, "_ARCHITECTURES", {})
    monkeypatch.setattr(Facet, "FACET_TYPES", {})
    yield


def test_register_then_get_round_trips(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _Colour("blue"), _Size(3))
    assert registry.get(BaseModelType.Flux, _Colour) == _Colour("blue")
    assert registry.get(BaseModelType.Flux, _Size) == _Size(3)


def test_get_returns_none_for_an_undeclared_facet(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _Colour("blue"))
    assert registry.get(BaseModelType.Flux, _Size) is None


def test_get_returns_none_for_an_unregistered_base(isolated_registry: None) -> None:
    assert registry.get(BaseModelType.Wan, _Colour) is None


def test_facets_of_returns_everything_declared(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _Colour("blue"), _Size(3))
    assert set(registry.facets_of(BaseModelType.Flux)) == {_Colour("blue"), _Size(3)}


def test_registering_twice_raises(isolated_registry: None) -> None:
    registry.register(BaseModelType.Flux, _Colour("blue"))
    with pytest.raises(registry.ArchitectureError, match="already registered"):
        registry.register(BaseModelType.Flux, _Colour("red"))


def test_the_same_facet_type_twice_in_one_call_raises(isolated_registry: None) -> None:
    with pytest.raises(registry.ArchitectureError, match="more than once"):
        registry.register(BaseModelType.Flux, _Colour("blue"), _Colour("red"))


@pytest.mark.parametrize("base", [BaseModelType.Any, BaseModelType.External, BaseModelType.Unknown])
def test_a_sentinel_cannot_be_registered(isolated_registry: None, base: BaseModelType) -> None:
    with pytest.raises(registry.ArchitectureError, match="not a model architecture"):
        registry.register(base, _Colour("blue"))


def test_require_names_the_file_to_edit_when_the_facet_is_missing(isolated_registry: None) -> None:
    registry.register(BaseModelType.ZImage, _Colour("blue"))
    with pytest.raises(registry.ArchitectureError) as exc:
        registry.require(BaseModelType.ZImage, _Size)
    assert "invokeai/backend/architectures/defs/z_image.py" in str(exc.value)
    assert "_Size" in str(exc.value)


def test_require_says_how_to_create_a_missing_architecture(isolated_registry: None) -> None:
    """The other half of the message: there is no file yet, so say what to put in it."""
    with pytest.raises(registry.ArchitectureError) as exc:
        registry.require(BaseModelType.ZImage, _Size)
    message = str(exc.value)
    assert "invokeai/backend/architectures/defs/z_image.py" in message
    assert "register(BaseModelType.ZImage, _Size(...))" in message
    assert "no import list to edit" in message


def test_architecture_error_is_a_value_error() -> None:
    """It replaces `raise ValueError("Unsupported base model: ...")`, so handlers must still catch."""
    assert issubclass(registry.ArchitectureError, ValueError)


def test_validate_reports_an_undeclared_required_facet(isolated_registry: None) -> None:
    """The negative probe for the boot gate. Without this, `validate()` could be a no-op forever."""
    for base in BaseModelType:
        if base not in registry._NOT_ARCHITECTURES:
            registry.register(base)
    Facet.FACET_TYPES[_Mandatory] = None

    with pytest.raises(registry.ArchitectureError) as exc:
        registry.validate()
    assert "_Mandatory" in str(exc.value)
    assert "invokeai/backend/architectures/defs/flux.py" in str(exc.value)


def test_validate_reports_an_unregistered_architecture(isolated_registry: None) -> None:
    """Discovery is automatic, so the way to fail is a new enum member with no module under defs/."""
    for base in BaseModelType:
        if base not in registry._NOT_ARCHITECTURES and base is not BaseModelType.Wan:
            registry.register(base)

    with pytest.raises(registry.ArchitectureError) as exc:
        registry.validate()
    assert "'wan'" in str(exc.value)
