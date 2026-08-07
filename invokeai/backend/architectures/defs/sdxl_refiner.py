from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ModelVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import SDXLConditioningInfo

register(
    BaseModelType.StableDiffusionXLRefiner,
    # The refiner takes SDXL conditioning; only the second text encoder is used.
    ConditioningFacet(SDXLConditioningInfo),
    # The refiner shares SDXL's latent space, smooth matrix included.
    LatentSpaceFacet(SDXL_4),
    VariantFacet({ModelType.Main: ModelVariantType}),
)
