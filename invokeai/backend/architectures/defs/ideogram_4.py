"""What the ideogram-4 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.features import FeaturesFacet, NegativePrompt
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import Ideogram4ConditioningInfo

# Ideogram 4 also uses a FLUX.2-style 32-channel VAE. It was the one architecture missing
# from the old preview dispatch entirely — its node carried a second copy of the logic.
register(
    BaseModelType.Ideogram4,
    LatentSpaceFacet(FLUX2_32),
    ConditioningFacet(Ideogram4ConditioningInfo),
    # Ideogram 4 samples from presets (V4_QUALITY_48 by default) with a dual-branch guidance
    # schedule; these are sensible UI defaults rather than the sampler's own numbers.
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=48, cfg_scale=7.0, width=1024, height=1024)}),
    # Text-to-image only.
    ModalityFacet(frozenset({"txt2img"}), metadata_slug="ideogram4"),
    FeaturesFacet(
        negative_prompt=NegativePrompt(visible=False, usage="never"),
        dimension_grid=16,
        guidance_label="Guidance",
        scheduler_set="flow",
    ),
)
