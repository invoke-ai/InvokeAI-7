"""What the sd-2 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import BasicConditioningInfo

# SD 2.x previews with the SD 1.x factors; same four-channel VAE.
register(
    BaseModelType.StableDiffusion2,
    LatentSpaceFacet(SD15_4),
    ConditioningFacet(BasicConditioningInfo),
    DefaultSettingsFacet({None: MainModelDefaultSettings(width=768, height=768)}),
)
