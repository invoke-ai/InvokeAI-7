"""The conditioning type an architecture's text encoder produces.

Only the *registration* lives here; the classes stay where they are, in
`stable_diffusion/diffusion/conditioning_data.py`. Moving them was the original plan and was
dropped deliberately: their names are OpenAPI `$ref`s and appear in stored workflows, so a move is
risk without benefit. A missing Field or Output class is already an `ImportError` that
`tests/test_imports.py` catches; the one thing that fails *late* is `safe_globals`, and
registration alone fixes that.

`ApiDependencies.initialize()` used to pass a hand-maintained list of thirteen classes to
`ObjectSerializerDisk`, next to a comment in `conditioning_data.py` asking whoever adds a type to
remember to update it. Forgetting meant `torch.load` refusing to deserialize mid-graph, on the
first generation that happened to use the new architecture. That list is now derived from the
registry.

The facet carries a bare `type` rather than something narrower because there is no common base or
protocol to bind to: `SDXLConditioningInfo` extends `BasicConditioningInfo`, but `FLUXConditioningInfo`
and the other nine are unrelated dataclasses. Their one shared property -- being a member of
`ConditioningFieldData.conditionings` -- is asserted in CI instead.
"""

from dataclasses import dataclass

from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.registry import generative_bases, require
from invokeai.backend.model_manager.taxonomy import BaseModelType


@dataclass(frozen=True)
class ConditioningFacet(Facet):
    """The `*ConditioningInfo` dataclass this architecture's text encoder puts in a
    `ConditioningFieldData`.

    Required: every generative architecture encodes a prompt somehow, and an architecture whose
    conditioning type is unregistered is one whose conditioning cannot be read back from disk.

    Several architectures share one: SD1 and SD2 both use `BasicConditioningInfo`, SDXL and its
    refiner `SDXLConditioningInfo`, and FLUX.2 Klein reuses `FLUXConditioningInfo` -- twelve types
    for fifteen architectures.
    """

    REQUIRED = True

    info: type


def get_conditioning_info(base: BaseModelType) -> type:
    """The conditioning type `base` produces."""
    return require(base, ConditioningFacet).info


def conditioning_infos() -> tuple[type, ...]:
    """Every conditioning type any registered architecture produces, by name.

    Sorted so that the `safe_globals` allowlist derived from it is stable across runs -- the
    registry preserves registration order, but a set would not.
    """
    infos = {require(base, ConditioningFacet).info for base in generative_bases()}
    return tuple(sorted(infos, key=lambda cls: cls.__name__))
