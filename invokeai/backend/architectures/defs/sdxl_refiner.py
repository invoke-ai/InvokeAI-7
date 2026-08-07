from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ModelVariantType

register(
    BaseModelType.StableDiffusionXLRefiner,
    # The refiner shares SDXL's latent space, smooth matrix included.
    LatentSpaceFacet(SDXL_4),
    VariantFacet({ModelType.Main: ModelVariantType}),
)
