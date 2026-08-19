"""The default-settings facet: what each architecture recommends, and what it deliberately does not.

ERNIE-Image's name-based detection is covered by tests/backend/model_manager/test_ernie_image_default_settings.py,
which now runs through this resolver.
"""

import pytest

from invokeai.backend.architectures import generative_bases, resolve_default_settings
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    Flux2VariantType,
    FluxVariantType,
    Krea2VariantType,
    ZImageVariantType,
)

# The four that returned None from the old `case _:` fallback. A standing TODO in configs/main.py
# asks whether they should have defaults; until someone answers it, "none" is the declared answer.
WITHOUT_DEFAULTS = {
    BaseModelType.StableDiffusion3,
    BaseModelType.StableDiffusionXLRefiner,
    BaseModelType.CogView4,
    BaseModelType.Flux,
}


def test_the_facet_is_optional() -> None:
    """Unlike latent space and conditioning, a missing declaration here is a legitimate state.

    So `validate()` cannot enforce it, and forgetting a new architecture fails softly: no crash,
    just sliders the user sets themselves.
    """
    assert DefaultSettingsFacet.REQUIRED is False


def test_exactly_the_expected_architectures_declare_nothing() -> None:
    undeclared = {b for b in generative_bases() if get(b, DefaultSettingsFacet) is None}
    assert undeclared == WITHOUT_DEFAULTS


def test_an_architecture_without_defaults_resolves_to_none() -> None:
    for base in WITHOUT_DEFAULTS:
        assert resolve_default_settings(base) is None, base.value


@pytest.mark.parametrize(
    ("variant", "expected"),
    [
        (ZImageVariantType.ZBase, (50, 4.0)),
        (None, (9, 1.0)),
    ],
)
def test_z_image_dispatches_on_variant(variant: ZImageVariantType | None, expected: tuple[int, float]) -> None:
    settings = resolve_default_settings(BaseModelType.ZImage, variant)
    assert settings is not None
    assert (settings.steps, settings.cfg_scale) == expected


def test_flux2_has_three_distinct_answers() -> None:
    """[dev] carries guidance, the undistilled Klein bases carry steps, distilled Klein carries neither."""
    dev = resolve_default_settings(BaseModelType.Flux2, Flux2VariantType.Dev)
    klein_base = resolve_default_settings(BaseModelType.Flux2, Flux2VariantType.Klein4BBase)
    klein = resolve_default_settings(BaseModelType.Flux2, None)
    assert dev is not None and klein_base is not None and klein is not None
    assert (dev.steps, dev.guidance) == (28, 3.5)
    assert (klein_base.steps, klein_base.guidance) == (28, None)
    assert (klein.steps, klein.guidance) == (4, None)


def test_an_unknown_variant_falls_back() -> None:
    """`None` is the fallback key, and it is what an unrecognised variant lands on."""
    assert resolve_default_settings(BaseModelType.Krea2, Krea2VariantType.Turbo) == resolve_default_settings(
        BaseModelType.Krea2, None
    )


def test_a_variant_from_another_architecture_does_not_leak_in() -> None:
    """`FluxVariantType.Dev` and `Flux2VariantType.Dev` are equal and hash alike — both are "dev".

    A mapping is only ever consulted for the architecture that declared it, so this cannot happen in
    practice; pinned because the equality is surprising and someone will eventually key a mapping by
    a variant from the wrong enum.
    """
    assert FluxVariantType.Dev == Flux2VariantType.Dev
    flux2_dev = resolve_default_settings(BaseModelType.Flux2, Flux2VariantType.Dev)
    assert flux2_dev is not None and flux2_dev.guidance == 3.5
    # FLUX.1 declares no defaults at all, so its own lookup is unaffected by the shared value.
    assert resolve_default_settings(BaseModelType.Flux, FluxVariantType.Dev) is None
