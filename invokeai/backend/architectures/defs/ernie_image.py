"""What the ernie-image architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import ErnieImageConditioningInfo

# ERNIE-Image uses AutoencoderKLFlux2. The shapes line up because the denoise loop unpatches
# before previewing; the values are approximate, because ERNIE denoises in BN-normalized
# latent space and the BN stats live on the VAE, which is not loaded to draw a preview.
register(
    BaseModelType.ErnieImage,
    LatentSpaceFacet(FLUX2_32),
    ConditioningFacet(ErnieImageConditioningInfo),
    DefaultSettingsFacet(
        {None: MainModelDefaultSettings(steps=50, cfg_scale=4.0, width=1024, height=1024)},
        # Turbo and the base model share an architecture and a config, so there is nothing on
        # disk to discriminate on and no variant is modeled. The name is the only signal.
        by_name_hint={"turbo": MainModelDefaultSettings(steps=8, cfg_scale=1.0, width=1024, height=1024)},
    ),
)
