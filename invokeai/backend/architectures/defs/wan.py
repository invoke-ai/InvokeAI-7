"""What the wan architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.features import FeaturesFacet, NegativePrompt
from invokeai.backend.architectures.facets.latent_space import WAN21_16, WAN22_48, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType, WanVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import WanConditioningInfo

# Two variants that model identity cannot tell apart: A14B denoises in the 16-channel Wan 2.1
# space at 8x, TI2V-5B in the 48-channel Wan2.2-VAE space at 16x. The loaded checkpoint
# decides, so the sample's channel count is what resolves it.
register(
    BaseModelType.Wan,
    LatentSpaceFacet(WAN21_16, alternates=(WAN22_48,)),
    ConditioningFacet(WanConditioningInfo),
    DefaultSettingsFacet(
        {
            WanVariantType.TI2V_5B: MainModelDefaultSettings(
                scheduler="euler", steps=30, cfg_scale=5.0, width=1024, height=1024
            ),
            # A14B, and whatever an unknown variant turns out to be.
            None: MainModelDefaultSettings(scheduler="euler", steps=40, cfg_scale=4.0, width=1024, height=1024),
        }
    ),
    # Wan generates images at num_frames=1 and video above that, from text or from one or two
    # given frames -- `interpolate` fills between two, `extend_video` continues an existing clip.
    ModalityFacet(
        frozenset({"txt2img", "img2img", "inpaint", "outpaint", "t2v", "i2v", "interpolate", "extend_video"}),
        metadata_slug="wan",
    ),
    FeaturesFacet(
        negative_prompt=NegativePrompt(visible=True, usage="always"),
        dimension_grid=16,
        guidance_label="Guidance",
        scheduler_set="flow",
    ),
)
