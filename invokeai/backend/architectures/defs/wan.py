from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import WAN21_16, WAN22_48, LatentSpaceFacet
from invokeai.backend.architectures.facets.variant import VariantFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelType,
    WanLoRAVariantType,
    WanVariantType,
)
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import WanConditioningInfo

register(
    BaseModelType.Wan,
    ConditioningFacet(WanConditioningInfo),
    # The only architecture with more than one latent space. A14B uses the standard 16-channel Wan
    # VAE at 8x spatial; TI2V-5B uses the 48-channel Wan2.2-VAE at 16x. The latent channel count
    # uniquely identifies the variant, which is how `LatentSpaceFacet.resolve()` tells them apart.
    LatentSpaceFacet(WAN21_16, alternates=(WAN22_48,)),
    # The one architecture whose LoRAs carry a different variant enum from its mains. They are not
    # interchangeable: an A14B LoRA (inner_dim=5120) against a TI2V-5B main (3072) crashes in the
    # layer patcher, which is why the LoRA enum exists separately at all.
    VariantFacet(
        {
            ModelType.Main: WanVariantType,
            ModelType.LoRA: WanLoRAVariantType,
        }
    ),
)
