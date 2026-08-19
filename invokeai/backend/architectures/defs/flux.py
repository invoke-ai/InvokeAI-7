"""What the flux architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import FLUX_16, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType, FluxVariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import FLUXConditioningInfo

register(
    BaseModelType.Flux,
    LatentSpaceFacet(FLUX_16),
    ConditioningFacet(FLUXConditioningInfo),
    # Per variant, from the model cards. FLUX's `guidance` is the distilled guidance embedding,
    # not classifier-free guidance — hence cfg_scale 1.0 (the field's floor, meaning "off") on all
    # three. Fill's 30.0 is corroborated in-tree: flux_denoise.py warns below 25.0.
    DefaultSettingsFacet(
        {
            # schnell is timestep-distilled: 4 steps, and it ignores guidance entirely.
            FluxVariantType.Schnell: MainModelDefaultSettings(steps=4, cfg_scale=1.0, width=1024, height=1024),
            FluxVariantType.DevFill: MainModelDefaultSettings(
                steps=50, cfg_scale=1.0, guidance=30.0, width=1024, height=1024
            ),
            # dev. The card's example uses 50 steps; 28 is the de-facto standard and what FLUX.2
            # [dev] already declares here, so the two stay consistent.
            None: MainModelDefaultSettings(steps=28, cfg_scale=1.0, guidance=3.5, width=1024, height=1024),
        }
    ),
)
