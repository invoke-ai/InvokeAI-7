"""What the minimax-h3 architecture declares."""

from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.default_settings import DefaultSettingsFacet
from invokeai.backend.architectures.facets.latent_space import MINIMAX_H3_24, LatentSpaceFacet
from invokeai.backend.architectures.facets.modality import ModalityFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.configs.default_settings import MainModelDefaultSettings
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import MiniMaxH3ConditioningInfo

register(
    BaseModelType.MiniMaxH3,
    LatentSpaceFacet(MINIMAX_H3_24),
    ConditioningFacet(MiniMaxH3ConditioningInfo),
    # H3 is guidance-distilled (cfg_scale 1.0 means no guidance) and was released for a fixed
    # 768px short edge; 1344x768 is its native 16:9 canvas. Dimensions must be multiples of 32.
    DefaultSettingsFacet({None: MainModelDefaultSettings(steps=50, cfg_scale=1.0, width=1344, height=768)}),
    # Video first, with a single-frame still-image path. No img2img, inpaint or outpaint.
    ModalityFacet(frozenset({"txt2img", "t2v", "i2v"}), metadata_slug="minimax_h3"),
)
