"""What the sdxl-refiner architecture declares."""

from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# The refiner shares SDXL's VAE.
register(
    BaseModelType.StableDiffusionXLRefiner,
    LatentSpaceFacet(SDXL_4),
)
