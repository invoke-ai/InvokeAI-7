"""What the z-image architecture declares."""

from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# Z-Image decodes with a FLUX-compatible 16-channel VAE.
register(
    BaseModelType.ZImage,
    LatentSpaceFacet(FLUX_16),
)
