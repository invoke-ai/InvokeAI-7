from invokeai.backend.architectures.facets.latent_space import SDXL_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.unet import UNetDownscaleFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.StableDiffusionXL,
    LatentSpaceFacet(SDXL_4),
    UNetDownscaleFacet(max_unet_downscale=4),
)
