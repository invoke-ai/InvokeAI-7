from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ModelVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import BasicConditioningInfo

register(
    BaseModelType.StableDiffusion2,
    # Like SD1, conditioned by Compel through a single CLIP text encoder.
    ConditioningFacet(BasicConditioningInfo),
    # SD2 shares SD1's 4-channel latent space and preview factors.
    LatentSpaceFacet(SD15_4),
    VariantFacet({ModelType.Main: ModelVariantType}),
)
