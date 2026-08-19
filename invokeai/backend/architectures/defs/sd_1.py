"""What the sd-1 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.StableDiffusion1,
    LatentSpaceFacet(SD15_4),
)
