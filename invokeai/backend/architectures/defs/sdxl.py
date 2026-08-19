"""What the sdxl architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import SDXLConditioningInfo

register(
    BaseModelType.StableDiffusionXL,
    LatentSpaceFacet(SDXL_4),
    ConditioningFacet(SDXLConditioningInfo),
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=30, cfg_scale=7.0, width=1024, height=1024)}),
)
