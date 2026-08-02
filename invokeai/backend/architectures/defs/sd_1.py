from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.unet import UNetDownscaleFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, ModelVariantType

register(
    BaseModelType.StableDiffusion1,
    LatentSpaceFacet(SD15_4),
    UNetDownscaleFacet(max_unet_downscale=8),
    VariantFacet({ModelType.Main: ModelVariantType}),
)
