from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import AnimaConditioningInfo

register(
    BaseModelType.Anima,
    ConditioningFacet(AnimaConditioningInfo),
    # Anima uses the Wan 2.1 VAE with 16 latent channels.
    LatentSpaceFacet(WAN21_16),
)
