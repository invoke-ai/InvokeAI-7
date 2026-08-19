"""What the qwen-image architecture declares."""

from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# Qwen-Image uses the Wan 2.1 VAE.
register(
    BaseModelType.QwenImage,
    LatentSpaceFacet(WAN21_16),
)
