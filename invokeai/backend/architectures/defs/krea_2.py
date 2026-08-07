from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, Krea2VariantType, ModelType

register(
    BaseModelType.Krea2,
    # Krea-2 decodes with the Qwen-Image VAE, which is the Wan 2.1 VAE (16 latent channels), so it
    # shares the preview factors.
    LatentSpaceFacet(WAN21_16),
    # The values are krea2_turbo / krea2_base rather than turbo / base, because variant strings are
    # resolved without base context in configs/factory.py and so must be globally unique.
    VariantFacet({ModelType.Main: Krea2VariantType}),
)
