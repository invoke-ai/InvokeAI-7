from invokeai.backend.architectures.facets.latent_space import WAN21_16, WAN22_48, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.Wan,
    # The only architecture with more than one latent space. A14B uses the standard 16-channel Wan
    # VAE at 8x spatial; TI2V-5B uses the 48-channel Wan2.2-VAE at 16x. The latent channel count
    # uniquely identifies the variant, which is how `LatentSpaceFacet.resolve()` tells them apart.
    LatentSpaceFacet(WAN21_16, alternates=(WAN22_48,)),
)
