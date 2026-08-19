"""What the flux2 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.Flux2,
    LatentSpaceFacet(FLUX2_32),
)
