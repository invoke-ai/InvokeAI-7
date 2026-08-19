"""What the minimax-h3 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import MINIMAX_H3_24, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import MiniMaxH3ConditioningInfo

register(
    BaseModelType.MiniMaxH3,
    LatentSpaceFacet(MINIMAX_H3_24),
    ConditioningFacet(MiniMaxH3ConditioningInfo),
)
