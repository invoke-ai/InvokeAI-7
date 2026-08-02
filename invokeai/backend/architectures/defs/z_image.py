from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.loader import LoaderFlagsFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ZImageVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ZImageConditioningInfo

register(
    BaseModelType.ZImage,
    ConditioningFacet(ZImageConditioningInfo),
    # Z-Image uses a FLUX-compatible VAE with 16 latent channels.
    LatentSpaceFacet(FLUX_16),
    # Diffusers' layerwise casting hits a dtype mismatch here: skipped modules produce bf16 while
    # hooked modules expect fp16.
    LoaderFlagsFacet(supports_fp8_storage=False),
    VariantFacet(
        {
            ModelType.Main: ZImageVariantType,
            ModelType.LoRA: ZImageVariantType,
        }
    ),
)
