"""What the wan architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import WAN21_16, WAN22_48, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import WanConditioningInfo

# Two variants that model identity cannot tell apart: A14B denoises in the 16-channel Wan 2.1
# space at 8x, TI2V-5B in the 48-channel Wan2.2-VAE space at 16x. The loaded checkpoint
# decides, so the sample's channel count is what resolves it.
register(
    BaseModelType.Wan,
    LatentSpaceFacet(WAN21_16, alternates=(WAN22_48,)),
    ConditioningFacet(WanConditioningInfo),
)
