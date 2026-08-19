"""What the z-image architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ZImageConditioningInfo

# Z-Image decodes with a FLUX-compatible 16-channel VAE.
register(
    BaseModelType.ZImage,
    LatentSpaceFacet(FLUX_16),
    ConditioningFacet(ZImageConditioningInfo),
)
