"""What the z-image architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.features import FeaturesFacet, NegativePrompt
from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType, ZImageVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ZImageConditioningInfo

# Z-Image decodes with a FLUX-compatible 16-channel VAE.
register(
    BaseModelType.ZImage,
    LatentSpaceFacet(FLUX_16),
    ConditioningFacet(ZImageConditioningInfo),
    DefaultSettingsFacet(
        {
            # The undistilled base needs more steps and supports CFG.
            ZImageVariantType.ZBase: MainModelDefaultSettings(
                scheduler="euler", steps=50, cfg_scale=4.0, width=1024, height=1024
            ),
            # Turbo (distilled): fewer steps, no CFG.
            None: MainModelDefaultSettings(scheduler="euler", steps=9, cfg_scale=1.0, width=1024, height=1024),
        }
    ),
    ModalityFacet(frozenset({"txt2img", "img2img", "inpaint", "outpaint"}), metadata_slug="z_image"),
    FeaturesFacet(
        negative_prompt=NegativePrompt(visible=True, usage="cfg-gated"),
        dimension_grid=16,
        guidance_label="CFG",
        scheduler_set="flow",
        scheduler_applies_to_graph=True,
        control_kinds=frozenset({"z_image_control"}),
    ),
)
