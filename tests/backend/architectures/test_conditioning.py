"""The `safe_globals` allowlist, derived and then actually exercised.

The failure this guards against is specific and late: `ObjectSerializerDisk` hands `safe_globals` to
`torch.serialization.add_safe_globals`, and `torch.load` refuses to deserialize a type that is not
on the list. An architecture missing from it therefore worked fine until the first generation that
used it, at which point conditioning could not be read back mid-graph.

`conditioning_data.py` still carries the comment asking whoever adds a type to remember to update
`dependencies.py`. The list is derived now, so nothing has to be remembered -- but the union in
that module is still hand-written, and these tests are what keep it and the registry in step.
"""

import typing

import pytest
import torch

from invokeai.backend.architectures import conditioning_infos, generative_bases, get_conditioning_info
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import (
    AnimaConditioningInfo,
    BasicConditioningInfo,
    CogView4ConditioningInfo,
    ConditioningFieldData,
    ErnieImageConditioningInfo,
    FLUXConditioningInfo,
    Ideogram4ConditioningInfo,
    Krea2ConditioningInfo,
    QwenImageConditioningInfo,
    SD3ConditioningInfo,
    SDXLConditioningInfo,
    WanConditioningInfo,
    ZImageConditioningInfo,
)

FROZEN_BASELINE = (
    ConditioningFieldData,
    BasicConditioningInfo,
    SDXLConditioningInfo,
    FLUXConditioningInfo,
    SD3ConditioningInfo,
    CogView4ConditioningInfo,
    ZImageConditioningInfo,
    ErnieImageConditioningInfo,
    Ideogram4ConditioningInfo,
    QwenImageConditioningInfo,
    Krea2ConditioningInfo,
    AnimaConditioningInfo,
    WanConditioningInfo,
)
"""The thirteen classes `dependencies.py` passed by hand before the registry derived them.

Copied here verbatim so the derivation is checked against what actually shipped, not against
itself.
"""

# base -> the conditioning type its text encoder builds, read off the invocation that builds it.
REFERENCE = {
    BaseModelType.StableDiffusion1: BasicConditioningInfo,  # compel.py
    BaseModelType.StableDiffusion2: BasicConditioningInfo,  # compel.py
    BaseModelType.StableDiffusionXL: SDXLConditioningInfo,  # compel.py (SDXLPromptInvocation)
    BaseModelType.StableDiffusionXLRefiner: SDXLConditioningInfo,  # compel.py (SDXLRefinerPrompt)
    BaseModelType.StableDiffusion3: SD3ConditioningInfo,  # sd3_text_encoder.py
    BaseModelType.CogView4: CogView4ConditioningInfo,  # cogview4_text_encoder.py
    BaseModelType.Flux: FLUXConditioningInfo,  # flux_text_encoder.py
    BaseModelType.Flux2: FLUXConditioningInfo,  # flux2_klein_text_encoder.py -- shared with FLUX
    BaseModelType.ZImage: ZImageConditioningInfo,  # z_image_text_encoder.py
    BaseModelType.ErnieImage: ErnieImageConditioningInfo,  # ernie_image_text_encoder.py
    BaseModelType.Ideogram4: Ideogram4ConditioningInfo,  # ideogram4_text_encoder.py
    BaseModelType.QwenImage: QwenImageConditioningInfo,  # qwen_image_text_encoder.py
    BaseModelType.Krea2: Krea2ConditioningInfo,  # krea2_text_encoder.py
    BaseModelType.Anima: AnimaConditioningInfo,  # anima_text_encoder.py
    BaseModelType.Wan: WanConditioningInfo,  # wan_text_encoder.py
}


def _serializable_conditioning_types() -> set[type]:
    """The members of `ConditioningFieldData.conditionings`, i.e. what can reach `torch.load`."""
    annotation = ConditioningFieldData.__annotations__["conditionings"]
    if isinstance(annotation, str):
        annotation = typing.get_type_hints(ConditioningFieldData)["conditionings"]
    return {arg for member in typing.get_args(annotation) for arg in typing.get_args(member)}


def test_the_reference_table_covers_every_architecture() -> None:
    assert set(REFERENCE) == set(generative_bases())


@pytest.mark.parametrize("base", sorted(REFERENCE, key=lambda b: b.value))
def test_each_architecture_declares_the_type_its_text_encoder_builds(base: BaseModelType) -> None:
    assert get_conditioning_info(base) is REFERENCE[base]


def test_twelve_types_serve_fifteen_architectures() -> None:
    # SD1/SD2 share BasicConditioningInfo, SDXL/SDXL-Refiner share SDXLConditioningInfo, and
    # FLUX.2 Klein reuses FLUXConditioningInfo. Pinned so that "why 12, not 15" stays answered.
    assert len(conditioning_infos()) == 12
    assert len(generative_bases()) == 15


def test_declared_types_are_exactly_the_serializable_union() -> None:
    """`ConditioningFieldData.conditionings` stays hand-written -- it is a type annotation -- so
    this is what keeps it and the registry from drifting apart.
    """
    assert set(conditioning_infos()) == _serializable_conditioning_types()


def test_derived_safe_globals_match_the_frozen_baseline() -> None:
    derived = [ConditioningFieldData, *conditioning_infos()]

    assert set(derived) == set(FROZEN_BASELINE)
    assert len(derived) == len(FROZEN_BASELINE), "the derived list must not contain duplicates"


def test_conditioning_infos_is_ordered_deterministically() -> None:
    # add_safe_globals does not care, but a stable order keeps this test suite and any diff of the
    # derived list reproducible across runs; the registry itself is insertion-ordered.
    assert list(conditioning_infos()) == sorted(conditioning_infos(), key=lambda cls: cls.__name__)


def test_ip_adapter_conditioning_is_deliberately_absent() -> None:
    """`IPAdapterConditioningInfo` is not in the baseline and must not creep in.

    It never reaches `ObjectSerializerDisk`: it lives on `IPAdapterData`, which is built and
    consumed within a single denoise run and is never written to the conditioning store.
    """
    from invokeai.backend.stable_diffusion.diffusion.conditioning_data import IPAdapterConditioningInfo

    assert IPAdapterConditioningInfo not in conditioning_infos()
    assert IPAdapterConditioningInfo not in _serializable_conditioning_types()


@pytest.mark.parametrize(
    "info_class", sorted(set(REFERENCE.values()), key=lambda cls: cls.__name__), ids=lambda cls: cls.__name__
)
def test_every_declared_type_survives_a_real_torch_round_trip(info_class: type, tmp_path) -> None:
    """The actual failure mode, reproduced.

    Builds a `ConditioningFieldData` holding one instance of each declared type, writes it through
    the same `ObjectSerializerDisk` the app uses, and reads it back. Without the class on
    `safe_globals`, `torch.load` refuses -- which is precisely the mid-graph error this facet
    exists to prevent.
    """
    from invokeai.app.services.object_serializer.object_serializer_disk import ObjectSerializerDisk

    fields = typing.get_type_hints(info_class)
    kwargs = {}
    for name, annotation in fields.items():
        optional = type(None) in typing.get_args(annotation)
        kwargs[name] = None if optional else torch.zeros(1, 2)

    data = ConditioningFieldData(conditionings=[info_class(**kwargs)])

    serializer = ObjectSerializerDisk[ConditioningFieldData](
        tmp_path / "conditioning",
        safe_globals=[ConditioningFieldData, *conditioning_infos()],
        ephemeral=False,
    )
    name = serializer.save(data)
    loaded = serializer.load(name)

    assert type(loaded.conditionings[0]) is info_class


def test_the_public_node_api_exports_every_conditioning_type() -> None:
    """Custom nodes that build conditioning need the types, and ten of twelve were missing."""
    from invokeai import invocation_api

    missing = sorted(cls.__name__ for cls in conditioning_infos() if cls.__name__ not in invocation_api.__all__)

    assert missing == [], f"add to invokeai/invocation_api/__init__.py: {missing}"
