from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.QwenImage,
    # Qwen-Image decodes with the 16-channel Wan 2.1 VAE.
    LatentSpaceFacet(WAN21_16),
)
