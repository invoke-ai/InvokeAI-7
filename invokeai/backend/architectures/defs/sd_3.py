"""What the sd-3 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import SD3_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import SD3ConditioningInfo

register(
    BaseModelType.StableDiffusion3,
    LatentSpaceFacet(SD3_16),
    ConditioningFacet(SD3ConditioningInfo),
)
