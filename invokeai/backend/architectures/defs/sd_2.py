"""What the sd-2 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# SD 2.x previews with the SD 1.x factors; same four-channel VAE.
register(
    BaseModelType.StableDiffusion2,
    LatentSpaceFacet(SD15_4),
)
