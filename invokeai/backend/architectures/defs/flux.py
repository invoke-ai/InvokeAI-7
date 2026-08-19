"""What the flux architecture declares."""

from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.Flux,
    LatentSpaceFacet(FLUX_16),
)
