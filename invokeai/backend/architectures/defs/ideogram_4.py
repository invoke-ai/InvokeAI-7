"""What the ideogram-4 architecture declares."""

from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# Ideogram 4 also uses a FLUX.2-style 32-channel VAE. It was the one architecture missing
# from the old preview dispatch entirely — its node carried a second copy of the logic.
register(
    BaseModelType.Ideogram4,
    LatentSpaceFacet(FLUX2_32),
)
