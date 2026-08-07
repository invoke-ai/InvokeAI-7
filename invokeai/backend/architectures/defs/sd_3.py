from invokeai.backend.architectures.facets.latent_space import SD3_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType, PiDDecoderVariantType

register(
    BaseModelType.StableDiffusion3,
    LatentSpaceFacet(SD3_16),
    # SD3 mains carry no variant; only its PiD decoder checkpoints do.
    VariantFacet({ModelType.PiDDecoder: PiDDecoderVariantType}),
)
