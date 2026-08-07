from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.unet import UNetDownscaleFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelType,
    ModelVariantType,
    PiDDecoderVariantType,
)
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import SDXLConditioningInfo

register(
    BaseModelType.StableDiffusionXL,
    ConditioningFacet(SDXLConditioningInfo),
    LatentSpaceFacet(SDXL_4),
    UNetDownscaleFacet(max_unet_downscale=4),
    VariantFacet(
        {
            ModelType.Main: ModelVariantType,
            ModelType.PiDDecoder: PiDDecoderVariantType,
        }
    ),
)
