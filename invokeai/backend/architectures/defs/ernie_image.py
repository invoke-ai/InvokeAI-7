from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ErnieImageConditioningInfo

register(
    BaseModelType.ErnieImage,
    ConditioningFacet(ErnieImageConditioningInfo),
    # ERNIE-Image uses AutoencoderKLFlux2 (same as FLUX.2) with 32 latent channels, and the denoise
    # loop unpatches before previewing, so the shapes line up. The values do not: ERNIE denoises in
    # BN-normalized latent space (denormalized only at VAE decode) and the BN stats live on the VAE,
    # which isn't loaded here. Previews are therefore approximate in color/contrast.
    LatentSpaceFacet(FLUX2_32),
)
