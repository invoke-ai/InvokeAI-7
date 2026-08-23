"""What the krea-2 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.features import FeaturesFacet, NegativePrompt
from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.facets.vae import VaeCompatibility, VaeFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType, Krea2VariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import Krea2ConditioningInfo

# Krea-2 decodes with the Qwen-Image VAE, which is the Wan 2.1 VAE.
register(
    BaseModelType.Krea2,
    LatentSpaceFacet(WAN21_16),
    ConditioningFacet(Krea2ConditioningInfo),
    DefaultSettingsFacet(
        {
            # Diffusers' Krea-2 guidance 4.5 uses cond + 4.5 * (cond - uncond), equivalent to
            # InvokeAI's CFG convention at 5.5.
            Krea2VariantType.Base: MainModelDefaultSettings(
                scheduler="euler", steps=28, cfg_scale=5.5, width=1024, height=1024
            ),
            # Turbo (distilled). cfg_scale has a floor of 1; 1.0 means no guidance.
            None: MainModelDefaultSettings(scheduler="euler", steps=8, cfg_scale=1.0, width=1024, height=1024),
        }
    ),
    ModalityFacet(frozenset({"txt2img", "img2img", "inpaint", "outpaint"}), metadata_slug="krea2"),
    FeaturesFacet(
        negative_prompt=NegativePrompt(visible=True, usage="cfg-gated"),
        dimension_grid=16,
        guidance_label="CFG",
        scheduler_set="flow",
        supports_regional_guidance=True,
    ),
    VaeFacet(
        frozenset(
            {
                # Krea-2 decodes with the Qwen-Image VAE, which is why its graph reuses
                # `qwen_image_l2i`. The same file also appears registered as `anima`.
                VaeCompatibility(BaseModelType.QwenImage),
                VaeCompatibility(BaseModelType.Anima),
            }
        )
    ),
)
