from invokeai.backend.architectures.facets.latent_space import WAN21_16, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelType,
    PiDDecoderVariantType,
    QwenImageVariantType,
)

register(
    BaseModelType.QwenImage,
    # Qwen-Image decodes with the 16-channel Wan 2.1 VAE.
    LatentSpaceFacet(WAN21_16),
    VariantFacet(
        {
            ModelType.Main: QwenImageVariantType,
            ModelType.PiDDecoder: PiDDecoderVariantType,
        }
    ),
)
