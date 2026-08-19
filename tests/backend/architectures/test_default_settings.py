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

# SD 3.5, CogView 4 and FLUX.1 reached the old `case _:` fallback and had no defaults at all; they
# now declare what their model cards recommend. The refiner is the one left: it is not run on its
# own, so there is nothing for it to prefill.
WITHOUT_DEFAULTS = {BaseModelType.StableDiffusionXLRefiner}


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


def test_a_variant_from_another_architecture_falls_back_rather_than_matching() -> None:
    """`FluxVariantType.Dev` and `Flux2VariantType.Dev` are equal and hash alike — both are "dev".

    A mapping is only ever consulted for the architecture that declared it, so this cannot happen in
    practice. Pinned because the equality is surprising: a lookup keyed by the wrong enum would find
    an entry rather than miss it, and nothing but the fallback would reveal the mistake.

    Both architectures happen to declare 28 steps at guidance 3.5 for their `dev`, so the shared key
    is not observable there — which is exactly why the check uses a value the two do not share.
    """
    assert FluxVariantType.Dev == Flux2VariantType.Dev
    assert resolve_default_settings(BaseModelType.Flux2, FluxVariantType.Schnell) == resolve_default_settings(
        BaseModelType.Flux2, None
    )


def test_flux1_dispatches_on_variant() -> None:
    """Three genuinely different answers, and `guidance` is not CFG.

    FLUX's `guidance` is the distilled guidance embedding, so cfg_scale stays at its floor (1.0,
    meaning "off") for every variant. Fill's 30.0 is corroborated in-tree: `flux_denoise.py` warns
    when guidance drops below 25.0 for a Fill model.
    """
    schnell = resolve_default_settings(BaseModelType.Flux, FluxVariantType.Schnell)
    dev = resolve_default_settings(BaseModelType.Flux, FluxVariantType.Dev)
    fill = resolve_default_settings(BaseModelType.Flux, FluxVariantType.DevFill)
    assert schnell is not None and dev is not None and fill is not None

    assert (schnell.steps, schnell.guidance) == (4, None), "schnell is distilled and ignores guidance"
    assert (dev.steps, dev.guidance) == (28, 3.5)
    assert (fill.steps, fill.guidance) == (50, 30.0)
    assert {schnell.cfg_scale, dev.cfg_scale, fill.cfg_scale} == {1.0}, "FLUX never uses CFG"


def test_the_researched_values_are_what_the_model_cards_say() -> None:
    """Pinned against their sources, so a later edit has to argue with the citation.

    cogview4: THUDM/CogView4-6B, 50 steps at guidance 3.5 (true CFG — it takes a negative prompt).
    sd-3:     stable-diffusion-3.5-medium, 40 steps at guidance 4.5. Medium, not Large (28/3.5):
              there is one `sd-3` row and no variant to tell them apart.
    z-image:  Tongyi-MAI/Z-Image-Turbo, `num_inference_steps=9`, guidance 0 -> cfg_scale 1.0.
    ideogram: not from a card but from our own PRESETS — every preset runs main guidance 7.0.
    """
    expected = {
        BaseModelType.CogView4: (50, 3.5),
        BaseModelType.StableDiffusion3: (40, 4.5),
        BaseModelType.ZImage: (9, 1.0),
        BaseModelType.Ideogram4: (48, 7.0),
        BaseModelType.ErnieImage: (50, 4.0),
    }
    for base, (steps, cfg) in expected.items():
        settings = resolve_default_settings(base)
        assert settings is not None, base.value
        assert (settings.steps, settings.cfg_scale) == (steps, cfg), base.value
