"""`_should_use_fp8` no longer knows any architecture by name.

It carried `config.base == BaseModelType.ZImage` in the middle of otherwise architecture-blind
logic, behind a function-local import of a module the file already imports at module level.

An audit of the whole loading path found that branch to be the only per-architecture *policy* in
generic loader code. The other base-keyed code there is dispatch -- `model_loaders/lora.py` picks a
different state-dict conversion per architecture, `model_loader_registry.py` builds a lookup key --
and dispatch is not a flag, so it stays where it is. These tests pin that boundary.
"""

import pytest

from invokeai.backend.architectures import (
    DEFAULT_LOADER_FLAGS,
    LoaderFlagsFacet,
    generative_bases,
    get,
    get_loader_flags,
)
from invokeai.backend.model_manager.configs.base import Config_Base
from invokeai.backend.model_manager.configs.factory import AnyModelConfig  # noqa: F401  (registers every config class)
from invokeai.backend.model_manager.taxonomy import BaseModelType

NO_FP8_STORAGE = {BaseModelType.ZImage}
"""The architectures that opt out. Kept as a set so adding one is a visible change here too."""


def test_z_image_declares_no_fp8_storage() -> None:
    assert get_loader_flags(BaseModelType.ZImage).supports_fp8_storage is False


@pytest.mark.parametrize(
    "base", sorted(set(generative_bases()) - NO_FP8_STORAGE, key=lambda b: b.value), ids=lambda b: b.value
)
def test_every_other_architecture_gets_the_general_rule(base: BaseModelType) -> None:
    assert get_loader_flags(base).supports_fp8_storage is True


@pytest.mark.parametrize("base", [BaseModelType.Any, BaseModelType.External, BaseModelType.Unknown])
def test_sentinel_bases_get_the_defaults_rather_than_raising(base: BaseModelType) -> None:
    """Models with `base=Any` -- CLIP embedders, T5 encoders -- reach `_should_use_fp8` too.

    They are never registered, so the accessor must fall through to the defaults instead of raising,
    exactly as the old `config.base == ZImage` comparison simply evaluated to False for them.
    """
    assert get_loader_flags(base) is DEFAULT_LOADER_FLAGS


def test_only_the_opting_out_architectures_declare_the_facet() -> None:
    """The facet is optional: declaring nothing means the general rule applies.

    An architecture declaring `LoaderFlagsFacet()` with all defaults would be indistinguishable in
    behaviour but misleading to read, so it should not happen.
    """
    declaring = {base for base in generative_bases() if get(base, LoaderFlagsFacet) is not None}

    assert declaring == NO_FP8_STORAGE


def test_the_defaults_describe_the_ordinary_case() -> None:
    assert DEFAULT_LOADER_FLAGS.supports_fp8_storage is True
    assert LoaderFlagsFacet() == DEFAULT_LOADER_FLAGS


def test_every_config_declares_base_and_type() -> None:
    """What made the `hasattr(config, "base")` / `hasattr(config, "type")` guards dead code.

    `Config_Base.__pydantic_init_subclass__` refuses to create a concrete config class that does not
    declare `type`, `base` and `format` with defaults, so no instance reaching `_should_use_fp8` can
    lack them. Removing the guards is safe only while this holds, so it is asserted rather than
    assumed.
    """
    missing = sorted(
        f"{cls.__name__}.{field}"
        for cls in Config_Base.CONFIG_CLASSES
        for field in ("base", "type", "format")
        if field not in cls.model_fields
    )

    assert missing == []
