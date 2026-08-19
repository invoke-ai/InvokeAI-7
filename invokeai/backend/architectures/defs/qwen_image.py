"""What the qwen-image architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import QwenImageConditioningInfo

# Qwen-Image uses the Wan 2.1 VAE.
register(
    BaseModelType.QwenImage,
    LatentSpaceFacet(WAN21_16),
    ConditioningFacet(QwenImageConditioningInfo),
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=40, cfg_scale=4.0, width=1024, height=1024)}),
)
