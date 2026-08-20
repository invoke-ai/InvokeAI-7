"""The conditioning facet, and the `safe_globals` list built from it."""

from invokeai.backend.architectures import conditioning_infos, generative_bases
from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import (
    BasicConditioningInfo,
    FLUXConditioningInfo,
    IPAdapterConditioningInfo,
    SDXLConditioningInfo,
)


def test_every_architecture_declares_a_conditioning_type() -> None:
    undeclared = sorted(b.value for b in generative_bases() if get(b, ConditioningFacet) is None)
    assert undeclared == []


def test_the_shared_types_are_shared_by_identity() -> None:
    """Three pairs share a class. Asserted by identity, so an equal-looking copy would fail."""
    for bases, info in (
        ((BaseModelType.StableDiffusion1, BaseModelType.StableDiffusion2), BasicConditioningInfo),
        ((BaseModelType.StableDiffusionXL, BaseModelType.StableDiffusionXLRefiner), SDXLConditioningInfo),
        ((BaseModelType.Flux, BaseModelType.Flux2), FLUXConditioningInfo),
    ):
        for base in bases:
            facet = get(base, ConditioningFacet)
            assert facet is not None and facet.info is info, base.value


def test_thirteen_types_serve_sixteen_architectures() -> None:
    """Pins the sharing itself. A fourteenth type means a new architecture stopped sharing."""
    assert len(conditioning_infos()) == 13
    assert len(generative_bases()) == 16


def test_the_list_is_deterministic() -> None:
    """`safe_globals` should be diffable, and registry order is only incidentally stable."""
    names = [cls.__name__ for cls in conditioning_infos()]
    assert names == sorted(names)


def test_the_declared_classes_are_the_ones_that_get_serialized() -> None:
    """Each facet holds a class, not a name — so this can check the object, not a string.

    `ConditioningFieldData` itself is added separately by the caller, and
    `IPAdapterConditioningInfo` is deliberately absent: it is built in memory and handed to the
    pipeline, never written through `context.conditioning.save`, so it is not unpickled and does not
    need to be a safe global.
    """
    infos = set(conditioning_infos())
    assert IPAdapterConditioningInfo not in infos
    assert all(isinstance(cls, type) for cls in infos)


def test_it_matches_what_dependencies_installs() -> None:
    """The list the app actually builds, assembled the same way `dependencies` assembles it."""
    from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ConditioningFieldData

    safe_globals = [ConditioningFieldData, *conditioning_infos()]
    assert len(safe_globals) == 14
    assert safe_globals[0] is ConditioningFieldData
    assert len(set(safe_globals)) == len(safe_globals), "a class appears twice"


def test_the_node_api_exports_every_declared_conditioning_type() -> None:
    """Custom node authors build these; the public surface must offer all of them.

    Derived from the registry rather than written down, because a hand-kept list is exactly what
    goes stale: the version of this list on the abandoned branch already omitted MiniMax H3 by the
    time it was ported. `invocation_api` still needs the static imports -- `__all__` is a real
    re-export, not a runtime lookup -- so this test is what keeps the two in step.
    """
    import invokeai.invocation_api as node_api

    declared = {info.__name__ for info in conditioning_infos()}
    exported = set(node_api.__all__)

    assert declared <= exported, sorted(declared - exported)
    for name in sorted(declared):
        assert getattr(node_api, name, None) is not None, f"{name} is in __all__ but not importable"
