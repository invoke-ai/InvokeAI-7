"""What the sdxl-refiner architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import SDXLConditioningInfo

# The refiner shares SDXL's VAE.
register(
    BaseModelType.StableDiffusionXLRefiner,
    LatentSpaceFacet(SDXL_4),
    ConditioningFacet(SDXLConditioningInfo),
    # Same canvas as SDXL, which it refines. Steps and CFG are deliberately absent: the refiner
    # is a second pass over an SDXL latent and the UI drives it with its own parameters, so
    # there is nothing here for them to prefill.
    DefaultSettingsFacet({None: MainModelDefaultSettings(width=1024, height=1024)}),
)
