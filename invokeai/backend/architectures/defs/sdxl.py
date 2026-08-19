"""What the sdxl architecture declares."""

from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.StableDiffusionXL,
    LatentSpaceFacet(SDXL_4),
)
