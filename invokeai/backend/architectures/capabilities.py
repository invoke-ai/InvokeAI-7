"""The architecture table, in the shape a client fetches it.

One row per architecture, plus a row per variant that answers differently. A client fetches this
once and joins it against model records locally: look up `(base, variant)`, fall back to
`(base, None)`.

This is not `ExternalModelCapabilities`, and deliberately not a subclass of it. That describes one
external provider's model — aspect ratios, resolution presets, mask format, per-request image
limits — and is stored on each such record. This describes an architecture, is the same for every
model of that architecture, and is not stored anywhere. Merging them would put fifteen irrelevant
fields on a schema webv2 already consumes.

Also deliberately not a computed field on `AnyModelConfig`: that would add these fields to all 115
config schemas and risk them being persisted into model records.
"""

from pydantic import BaseModel, ConfigDict, Field

from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.features import (
    ControlKind,
    FeaturesFacet,
    NegativePromptUsage,
    SchedulerSet,
)
from invokeai.backend.architectures.facets.latent_space import LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import GenerationModeKind, ModalityFacet
from invokeai.backend.architectures.registry import generative_bases, get
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType


class NegativePromptPolicy(BaseModel):
    visible: bool = Field(description="Whether to show a negative prompt field at all.")
    usage: NegativePromptUsage = Field(
        description="'always', 'cfg-gated' (only above CFG 1), or 'never'.",
    )

    model_config = ConfigDict(extra="forbid")


class ArchitectureModality(BaseModel):
    """What this architecture can produce, and what it calls it in image metadata."""

    modes: list[GenerationModeKind] = Field(description="Sorted. Empty means it generates nothing on its own.")
    metadata_slug: str | None = Field(
        default=None,
        description="Prefix its mode strings carry in image metadata; null means unprefixed.",
    )

    model_config = ConfigDict(extra="forbid")


class ArchitectureFeatures(BaseModel):
    """What a UI may offer for this architecture."""

    negative_prompt: NegativePromptPolicy
    dimension_grid: int = Field(description="Width and height must be a multiple of this.")
    spatial_compression: int = Field(description="How much smaller a latent is than the image, per side.")
    guidance_label: str = Field(description="What to call the guidance slider: 'CFG' or 'Guidance'.")
    scheduler_set: SchedulerSet | None = Field(
        default=None, description="Which scheduler family to offer; null means no choice."
    )
    scheduler_applies_to_graph: bool = False
    control_kinds: list[ControlKind] = Field(default_factory=list, description="Sorted.")
    max_reference_images: int = 0
    reference_images_require_variant: str | None = Field(
        default=None,
        description="If set, reference images are only accepted for models of this variant.",
    )
    supports_regional_guidance: bool = False
    regional_negative: bool = False
    clip_skip_max: int | None = None
    supports_seamless: bool = False
    supports_cfg_rescale: bool = False
    sd_vae_override: bool = False
    color_compensation: bool = False
    vae_precision: bool = False

    model_config = ConfigDict(extra="forbid")


class ArchitectureCapabilities(BaseModel):
    """One row of the table."""

    base: BaseModelType
    variant: str | None = Field(
        default=None,
        description="Null for the architecture's own row. A variant row overrides it.",
    )
    modality: ArchitectureModality
    features: ArchitectureFeatures
    defaults: MainModelDefaultSettings | None = Field(
        default=None, description="Recommended generation parameters, if the architecture has any."
    )

    model_config = ConfigDict(extra="forbid")


def _features_of(facet: FeaturesFacet, spatial_compression: int) -> ArchitectureFeatures:
    return ArchitectureFeatures(
        negative_prompt=NegativePromptPolicy(
            visible=facet.negative_prompt.visible,
            usage=facet.negative_prompt.usage,
        ),
        dimension_grid=facet.dimension_grid,
        spatial_compression=spatial_compression,
        guidance_label=facet.guidance_label,
        scheduler_set=facet.scheduler_set,
        scheduler_applies_to_graph=facet.scheduler_applies_to_graph,
        control_kinds=sorted(facet.control_kinds),
        max_reference_images=facet.max_reference_images,
        reference_images_require_variant=facet.reference_images_require_variant,
        supports_regional_guidance=facet.supports_regional_guidance,
        regional_negative=facet.regional_negative,
        clip_skip_max=facet.clip_skip_max,
        supports_seamless=facet.supports_seamless,
        supports_cfg_rescale=facet.supports_cfg_rescale,
        sd_vae_override=facet.sd_vae_override,
        color_compensation=facet.color_compensation,
        vae_precision=facet.vae_precision,
    )


def architecture_capabilities() -> list[ArchitectureCapabilities]:
    """Every row, base rows first, then the variant rows that override them.

    A variant gets its own row only where something actually differs — today that is the five
    architectures whose recommended parameters depend on the variant. Feature differences that hang
    on a variant are expressed on the base row instead, by
    `features.reference_images_require_variant`; Qwen-Image is the only one, and inventing a row for
    it would mean inventing which fields a variant row is allowed to omit.

    Sorted by base value, then variant, so the response is stable and diffable.
    """
    rows: list[ArchitectureCapabilities] = []
    for base in sorted(generative_bases(), key=lambda b: b.value):
        modality = get(base, ModalityFacet)
        features = get(base, FeaturesFacet)
        latent_space = get(base, LatentSpaceFacet)
        defaults = get(base, DefaultSettingsFacet)
        # All four are REQUIRED, so `validate()` has already refused to start without them.
        assert modality is not None and features is not None and latent_space is not None
        assert defaults is not None

        rendered = ArchitectureModality(modes=sorted(modality.modes), metadata_slug=modality.metadata_slug)
        rendered_features = _features_of(features, latent_space.primary.spatial_compression)

        rows.append(
            ArchitectureCapabilities(
                base=base,
                modality=rendered,
                features=rendered_features,
                defaults=defaults.resolve(),
            )
        )
        for variant in sorted(v for v in defaults.by_variant if v is not None):
            rows.append(
                ArchitectureCapabilities(
                    base=base,
                    # `.value`, not `str()`: these are `str`-mixin enums, and `str()` on one yields
                    # "FluxVariantType.DevFill" rather than the "dev_fill" a client stores and sends.
                    variant=variant.value,
                    modality=rendered,
                    features=rendered_features,
                    defaults=defaults.by_variant[variant],
                )
            )
    return rows
