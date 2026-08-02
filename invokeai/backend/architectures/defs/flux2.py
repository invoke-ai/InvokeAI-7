from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    Flux2VariantType,
    ModelType,
    PiDDecoderVariantType,
)

register(
    BaseModelType.Flux2,
    LatentSpaceFacet(FLUX2_32),
    VariantFacet(
        {
            # FLUX.2 LoRAs are labelled with the same variant enum as the mains they target.
            ModelType.Main: Flux2VariantType,
            ModelType.LoRA: Flux2VariantType,
            ModelType.PiDDecoder: PiDDecoderVariantType,
        }
    ),
)
