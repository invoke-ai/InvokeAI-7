"""What the cogview4 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import COGVIEW4_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.CogView4,
    LatentSpaceFacet(COGVIEW4_16),
)
