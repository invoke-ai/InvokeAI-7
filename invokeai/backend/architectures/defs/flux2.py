"""What the flux2 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType, Flux2VariantType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import FLUXConditioningInfo

register(
    BaseModelType.Flux2,
    LatentSpaceFacet(FLUX2_32),
    # FLUX.2 encodes to the same conditioning shape as FLUX.1, both [dev] and Klein.
    ConditioningFacet(FLUXConditioningInfo),
    DefaultSettingsFacet(
        {
            # [dev] is guidance-distilled: guidance 3.5, 28 steps, CFG off.
            Flux2VariantType.Dev: MainModelDefaultSettings(
                steps=28, cfg_scale=1.0, guidance=3.5, width=1024, height=1024
            ),
            # The undistilled Klein bases need the steps but not the guidance.
            Flux2VariantType.Klein4BBase: MainModelDefaultSettings(steps=28, cfg_scale=1.0, width=1024, height=1024),
            Flux2VariantType.Klein9BBase: MainModelDefaultSettings(steps=28, cfg_scale=1.0, width=1024, height=1024),
            # Distilled Klein 4B / 9B.
            None: MainModelDefaultSettings(steps=4, cfg_scale=1.0, width=1024, height=1024),
        }
    ),
    ModalityFacet(frozenset({"txt2img", "img2img", "inpaint", "outpaint"}), metadata_slug="flux2"),
)
