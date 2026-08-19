"""What the cogview4 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import COGVIEW4_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import CogView4ConditioningInfo

register(
    BaseModelType.CogView4,
    LatentSpaceFacet(COGVIEW4_16),
    ConditioningFacet(CogView4ConditioningInfo),
)
