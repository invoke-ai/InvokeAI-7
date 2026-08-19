"""What the flux2 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import FLUXConditioningInfo

register(
    BaseModelType.Flux2,
    LatentSpaceFacet(FLUX2_32),
    # FLUX.2 encodes to the same conditioning shape as FLUX.1, both [dev] and Klein.
    ConditioningFacet(FLUXConditioningInfo),
)
