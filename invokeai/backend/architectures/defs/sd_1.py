"""What the sd-1 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import SD15_4, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import BasicConditioningInfo

register(
    BaseModelType.StableDiffusion1,
    LatentSpaceFacet(SD15_4),
    ConditioningFacet(BasicConditioningInfo),
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=30, cfg_scale=7.0, width=512, height=512)}),
    # SD 1.x and 2.x share the unprefixed mode strings: a bare `txt2img`.
    ModalityFacet(frozenset({"txt2img", "img2img", "inpaint", "outpaint"})),
)
