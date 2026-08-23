"""Which generation features each architecture declares."""

import pytest

from invokeai.app.invocations.baseinvocation import InvocationRegistry
from invokeai.backend.architectures import generative_bases
from invokeai.backend.architectures.facets.features import ControlKind, FeaturesFacet
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import BaseModelType

# The node that owns width/height for each architecture. Bases absent from this map drive their
# dimensions from the latent tensor rather than from fields on a node.
DENOISE_NODE = {
    BaseModelType.StableDiffusion3: "sd3_denoise",
    BaseModelType.CogView4: "cogview4_denoise",
    BaseModelType.Flux: "flux_denoise",
    BaseModelType.Flux2: "flux2_denoise",
    BaseModelType.ZImage: "z_image_denoise",
    BaseModelType.ErnieImage: "ernie_image_denoise",
    BaseModelType.Ideogram4: "ideogram4_denoise",
    BaseModelType.QwenImage: "qwen_image_denoise",
    BaseModelType.Anima: "anima_denoise",
    BaseModelType.Krea2: "krea2_denoise",
    BaseModelType.Wan: "wan_denoise",
    BaseModelType.MiniMaxH3: "minimax_h3_denoise",
}


def test_every_architecture_declares_its_features() -> None:
    undeclared = sorted(b.value for b in generative_bases() if get(b, FeaturesFacet) is None)
    assert undeclared == []


def test_the_dimension_grid_matches_the_node_that_enforces_it() -> None:
    """The declared grid and the node's `multiple_of` are the same number, or the UI offers
    dimensions the graph will reject.

    Two independent sources today: the node's field constraint, and webv2's own `dimensions.grid`.
    They agree for all thirteen bases webv2 knows; this pins the declaration to the node, which is
    the one that actually enforces it.
    """
    widths = {
        cls.get_type(): cls.model_json_schema()["properties"]["width"]
        for cls in InvocationRegistry.get_invocation_classes()
        if "width" in cls.model_json_schema().get("properties", {})
    }
    mismatched = []
    for base, node_type in DENOISE_NODE.items():
        facet = get(base, FeaturesFacet)
        assert facet is not None, base.value
        node_grid = widths[node_type].get("multipleOf")
        if node_grid != facet.dimension_grid:
            mismatched.append(f"{base.value}: declared {facet.dimension_grid}, {node_type} says {node_grid}")
    assert mismatched == []


def test_the_sd_family_grid_is_the_vae_compression() -> None:
    """SD has no width field to constrain — its grid follows from the VAE's 8x downscale."""
    for base in (BaseModelType.StableDiffusion1, BaseModelType.StableDiffusion2, BaseModelType.StableDiffusionXL):
        facet = get(base, FeaturesFacet)
        assert facet is not None and facet.dimension_grid == 8, base.value


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        ("controlnet", {"sd-1", "sdxl", "flux"}),
        ("t2i_adapter", {"sd-1", "sdxl"}),
        ("control_lora", {"flux"}),
        ("z_image_control", {"z-image"}),
    ],
)
def test_control_kinds_match_the_frontend_policy(kind: ControlKind, expected: set[str]) -> None:
    """Lifted from webv2's `isControlKindSupportedForBase`, which is four nested conditionals."""
    declared = {
        b.value for b in generative_bases() if (f := get(b, FeaturesFacet)) is not None and kind in f.control_kinds
    }
    assert declared == expected


def test_reference_images_and_the_one_variant_condition() -> None:
    """Qwen-Image is the only base whose answer depends on the variant, so it is the only one with
    `reference_images_require_variant` set."""
    supported = {
        b.value for b in generative_bases() if (f := get(b, FeaturesFacet)) is not None and f.supports_reference_images
    }
    assert supported == {"flux", "flux2", "sd-1", "sdxl", "qwen-image"}

    conditional = {
        b.value
        for b in generative_bases()
        if (f := get(b, FeaturesFacet)) is not None and f.reference_images_require_variant is not None
    }
    assert conditional == {"qwen-image"}
    qwen = get(BaseModelType.QwenImage, FeaturesFacet)
    assert qwen is not None and qwen.reference_images_require_variant == "edit"


def test_regional_guidance_and_its_negative_subset() -> None:
    """Regional negative prompts are a strict subset — only the SD family has them."""
    regional = {
        b.value for b in generative_bases() if (f := get(b, FeaturesFacet)) is not None and f.supports_regional_guidance
    }
    negative = {b.value for b in generative_bases() if (f := get(b, FeaturesFacet)) is not None and f.regional_negative}
    assert regional == {"sd-1", "sdxl", "flux", "flux2", "krea-2"}
    assert negative == {"sd-1", "sdxl"}
    assert negative < regional, "a regional negative prompt without regional guidance is meaningless"


def test_the_negative_prompt_policy_follows_the_guidance_model() -> None:
    """`cfg-gated` is for models that take a negative prompt only above CFG 1; `never` for the
    guidance-distilled ones, which have no CFG at all."""
    by_usage: dict[str, set[str]] = {}
    for base in generative_bases():
        facet = get(base, FeaturesFacet)
        assert facet is not None
        by_usage.setdefault(facet.negative_prompt.usage, set()).add(base.value)

    assert by_usage["never"] == {"flux", "flux2", "ideogram-4", "minimax-h3"}
    assert by_usage["cfg-gated"] == {"anima", "krea-2", "qwen-image", "z-image", "ernie-image"}
    # Nothing declares a visible box it never uses, or an invisible one it does.
    for base in generative_bases():
        facet = get(base, FeaturesFacet)
        assert facet is not None
        assert facet.negative_prompt.visible == (facet.negative_prompt.usage != "never"), base.value


def test_the_flux_family_labels_its_slider_guidance() -> None:
    """Calling a distilled guidance embedding "CFG" has misled users into expecting CFG behaviour."""
    labelled = {
        b.value
        for b in generative_bases()
        if (f := get(b, FeaturesFacet)) is not None and f.guidance_label == "Guidance"
    }
    assert labelled == {"flux", "flux2", "ideogram-4", "wan", "minimax-h3"}


def test_clip_skip_is_an_sd_1_and_2_feature_only() -> None:
    """SDXL has no `clipSkipMax` in webv2 at all, and legacy's 24 for it was never reachable."""
    with_clip_skip = {
        b.value: (f := get(b, FeaturesFacet)) and f.clip_skip_max
        for b in generative_bases()
        if (f := get(b, FeaturesFacet)) is not None and f.clip_skip_max is not None
    }
    assert with_clip_skip == {"sd-1": 12, "sd-2": 24}


def test_an_architecture_that_cannot_do_cfg_declares_no_cfg() -> None:
    """`negative_prompt: never` means CFG-distilled, and a CFG-distilled model has one honest
    cfg_scale: 1.0, meaning "off".

    The two facts live in different facets, so nothing stopped them from disagreeing -- and they
    did. Ideogram 4 shipped `cfg_scale=7.0` while its own FeaturesFacet said `never` and its denoise
    node had no `cfg_scale` input at all, only `guidance_scale`. The UI would have offered a slider
    for a control the sampler does not read.
    """
    from invokeai.backend.architectures import resolve_default_settings

    contradictory = []
    for base in generative_bases():
        features = get(base, FeaturesFacet)
        settings = resolve_default_settings(base)
        if features is None or settings is None or settings.cfg_scale is None:
            continue
        if features.negative_prompt.usage == "never" and settings.cfg_scale != 1.0:
            contradictory.append(f"{base.value}: cfg_scale={settings.cfg_scale} but negative prompt is 'never'")
    assert contradictory == []
