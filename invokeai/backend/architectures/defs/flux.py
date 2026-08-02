from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    FluxVariantType,
    ModelType,
    PiDDecoderVariantType,
)
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import FLUXConditioningInfo

register(
    BaseModelType.Flux,
    ConditioningFacet(FLUXConditioningInfo),
    LatentSpaceFacet(FLUX_16),
    VariantFacet(
        {
            ModelType.Main: FluxVariantType,
            ModelType.PiDDecoder: PiDDecoderVariantType,
        }
    ),
)
