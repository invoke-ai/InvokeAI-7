from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.Krea2,
    # Krea-2 decodes with the Qwen-Image VAE, which is the Wan 2.1 VAE (16 latent channels), so it
    # shares the preview factors.
    LatentSpaceFacet(WAN21_16),
)
