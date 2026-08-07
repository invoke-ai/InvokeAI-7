from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    Flux2VariantType,
    ModelType,
    PiDDecoderVariantType,
)
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import FLUXConditioningInfo

register(
    BaseModelType.Flux2,
    # Klein reuses the FLUX conditioning shape, but fills it differently: `clip_embeds` holds the
    # pooled embedding and `t5_embeds` the Qwen3 sequence. Same container, different encoders.
    ConditioningFacet(FLUXConditioningInfo),
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
