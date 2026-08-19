"""What the krea-2 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# Krea-2 decodes with the Qwen-Image VAE, which is the Wan 2.1 VAE.
register(
    BaseModelType.Krea2,
    LatentSpaceFacet(WAN21_16),
)
