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


def test_the_facet_is_required() -> None:
    """Every architecture declares defaults, so `validate()` enforces it at boot.

    It was optional while four architectures legitimately had none. They now declare what their
    model cards recommend, and the SDXL refiner — the last holdout — declares SDXL's canvas. A
    missing prefill is quiet rather than loud, which is exactly why it needs a boot check.
    """
    assert DefaultSettingsFacet.REQUIRED is True


def test_every_architecture_declares_defaults() -> None:
    undeclared = sorted(b.value for b in generative_bases() if get(b, DefaultSettingsFacet) is None)
    assert undeclared == []


def test_the_refiner_declares_a_canvas_but_no_sampler_settings() -> None:
    """It is a second pass over an SDXL latent, driven by the UI's own refiner parameters."""
    settings = resolve_default_settings(BaseModelType.StableDiffusionXLRefiner)
    assert settings is not None
    assert (settings.width, settings.height) == (1024, 1024)
    assert (settings.steps, settings.cfg_scale) == (None, None)


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
    ideogram: 1.0, because the model is CFG-distilled and cannot do CFG at all -- `ideogram4_denoise`
              has no `cfg_scale` input, only `guidance_scale`, and the FeaturesFacet says
              `negative_prompt: never`. This field previously held 7.0, taken from the main weight in
              our own PRESETS. That number is the sampler's internal guidance schedule, not a default
              anyone sets: the node reads `guidance_scale=None` as "use the preset", and webv2 sends
              nothing unless the user overrides it through Ideogram's own dedicated fields. Declaring
              7.0 advertised a CFG default for a model that has no CFG.
    """
    expected = {
        BaseModelType.CogView4: (50, 3.5),
        BaseModelType.StableDiffusion3: (40, 4.5),
        BaseModelType.ZImage: (9, 1.0),
        BaseModelType.Ideogram4: (48, 1.0),
        BaseModelType.ErnieImage: (50, 4.0),
        # The classic Stable Diffusion defaults, which every SD generation is built around.
        BaseModelType.StableDiffusion1: (30, 7.0),
        BaseModelType.StableDiffusion2: (30, 7.0),
        BaseModelType.StableDiffusionXL: (30, 7.0),
    }
    for base, (steps, cfg) in expected.items():
        settings = resolve_default_settings(base)
        assert settings is not None, base.value
        assert (settings.steps, settings.cfg_scale) == (steps, cfg), base.value


def test_the_sd_family_keeps_its_native_sizes() -> None:
    """Same steps and CFG, three different canvases — 2.x is the judgment call.

    768 is right for the v-prediction checkpoints and wrong for the 512 `-base` ones. Nothing in the
    config distinguishes them, so one of the two had to be picked.
    """
    sizes = {
        BaseModelType.StableDiffusion1: (512, 512),
        BaseModelType.StableDiffusion2: (768, 768),
        BaseModelType.StableDiffusionXL: (1024, 1024),
    }
    for base, (width, height) in sizes.items():
        settings = resolve_default_settings(base)
        assert settings is not None, base.value
        assert (settings.width, settings.height) == (width, height), base.value


def test_every_architecture_with_a_scheduler_declares_which_one() -> None:
    """The last piece webv2 still hardcodes.

    `BASE_GENERATION` in `baseGenerationPolicies.ts` carries a `defaults.scheduler` per base, and it
    was the one field the capabilities endpoint could not supply -- so adding an architecture still
    meant editing the frontend even when nothing about it was special. The values mirror what that
    table ships, deliberately: which scheduler to prefer is a product decision, not a model-card
    fact, and mirroring means nothing changes for users when webv2 switches over.

    The converse matters too. An architecture with no `scheduler_set` has no scheduler to choose --
    MiniMax H3 steps video and audio down two hardcoded flow schedules -- and declaring a default for
    it would put a control in the UI that reaches nothing.
    """
    from invokeai.backend.architectures import FeaturesFacet, get

    missing, spurious = [], []
    for base in generative_bases():
        features = get(base, FeaturesFacet)
        settings = resolve_default_settings(base)
        if features is None or settings is None:
            continue
        # The refiner declares a canvas but no generation settings; it is not run on its own.
        if settings.steps is None:
            continue
        if features.scheduler_set is not None and settings.scheduler is None:
            missing.append(base.value)
        if features.scheduler_set is None and settings.scheduler is not None:
            spurious.append(base.value)

    assert missing == [], f"scheduler_set declared but no default scheduler: {missing}"
    assert spurious == [], f"default scheduler but no scheduler_set: {spurious}"
