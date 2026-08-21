"""Which generation features an architecture supports.

The UI has to know whether to show a negative prompt box, whether a ControlNet layer can attach,
how many reference images to accept, whether clip-skip means anything. None of it is derivable from
a model file — it follows from what the architecture is — and all of it was living in the frontend.

webv2 holds the working version of this table for thirteen bases at
`features/generation/core/baseGenerationPolicies.ts`, plus three more predicates scattered across
`controlValidation.ts` and `addRegionalGuidance.ts`. Those values are the source for what is
declared here; the point is not to change them but to move them somewhere a new architecture cannot
be added without them, and where the three bases webv2 has never heard of — ERNIE-Image, MiniMax H3
and the SDXL refiner — get an answer too.
"""

from dataclasses import dataclass
from typing import ClassVar, Literal

from invokeai.backend.architectures.facet import Facet

NegativePromptUsage = Literal["always", "cfg-gated", "never"]
"""`cfg-gated` means the field exists but only does anything above CFG 1 — the distilled models."""

ControlKind = Literal["controlnet", "t2i_adapter", "control_lora", "z_image_control"]

SchedulerSet = Literal["standard", "flow", "anima"]
"""Which family of schedulers to offer. `None` means the architecture drives its own and offers no
choice — MiniMax H3 steps video and audio down two hardcoded flow schedules."""


@dataclass(frozen=True)
class NegativePrompt:
    """Whether to show the box, and whether what is typed in it is used."""

    visible: bool
    usage: NegativePromptUsage


@dataclass(frozen=True)
class FeaturesFacet(Facet):
    """What the UI may offer for this architecture."""

    REQUIRED: ClassVar[bool] = True

    negative_prompt: NegativePrompt
    dimension_grid: int
    """Width and height must be a multiple of this. Already declared on the denoise node as
    `multiple_of`; a test asserts the two agree, so this cannot drift into a UI that offers
    dimensions the node will reject."""

    guidance_label: Literal["CFG", "Guidance"] = "CFG"
    """What to call the slider. FLUX-family models expose a distilled guidance embedding rather than
    classifier-free guidance, and calling it CFG has confused users into expecting CFG behaviour."""

    scheduler_set: SchedulerSet | None = None
    scheduler_applies_to_graph: bool = False
    """Whether the chosen scheduler reaches the graph, or is only a UI affordance."""

    control_kinds: frozenset[ControlKind] = frozenset()
    max_reference_images: int = 0
    reference_images_require_variant: str | None = None
    """Qwen-Image accepts reference images only as the `edit` variant — the one feature in this
    table that a base alone cannot answer."""

    supports_regional_guidance: bool = False
    regional_negative: bool = False
    """Regional *negative* prompts, which only the SD family has."""

    clip_skip_max: int | None = None
    supports_seamless: bool = False
    supports_cfg_rescale: bool = False
    sd_vae_override: bool = False
    color_compensation: bool = False
    vae_precision: bool = False

    @property
    def supports_reference_images(self) -> bool:
        return self.max_reference_images > 0
