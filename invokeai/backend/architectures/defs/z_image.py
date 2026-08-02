from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ZImageVariantType

register(
    BaseModelType.ZImage,
    # Z-Image uses a FLUX-compatible VAE with 16 latent channels.
    LatentSpaceFacet(FLUX_16),
    VariantFacet(
        {
            ModelType.Main: ZImageVariantType,
            ModelType.LoRA: ZImageVariantType,
        }
    ),
)
