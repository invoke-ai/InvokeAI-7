"""What the anima architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import AnimaConditioningInfo

# Anima uses the Wan 2.1 VAE.
register(
    BaseModelType.Anima,
    LatentSpaceFacet(WAN21_16),
    ConditioningFacet(AnimaConditioningInfo),
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=35, cfg_scale=4.5, width=1024, height=1024)}),
)
