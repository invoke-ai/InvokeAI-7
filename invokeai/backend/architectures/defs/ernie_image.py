"""What the ernie-image architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ErnieImageConditioningInfo

# ERNIE-Image uses AutoencoderKLFlux2. The shapes line up because the denoise loop unpatches
# before previewing; the values are approximate, because ERNIE denoises in BN-normalized
# latent space and the BN stats live on the VAE, which is not loaded to draw a preview.
register(
    BaseModelType.ErnieImage,
    LatentSpaceFacet(FLUX2_32),
    ConditioningFacet(ErnieImageConditioningInfo),
)
