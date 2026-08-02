"""Starter models for the ernie_image architecture."""

from invokeai.backend.model_manager.starter_models.types import (
    StarterModel,
)
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelType,
)

ernie_image = StarterModel(
    name="ERNIE-Image",
    base=BaseModelType.ErnieImage,
    source="baidu/ERNIE-Image",
    description=(
        "Baidu ERNIE-Image: 8B single-stream DiT with Mistral3 text encoder, AutoencoderKLFlux2 VAE, "
        "and bundled Ministral3 prompt enhancer. Defaults to 50 steps with CFG 4.0."
    ),
    type=ModelType.Main,
)


ernie_image_turbo = StarterModel(
    name="ERNIE-Image Turbo",
    base=BaseModelType.ErnieImage,
    source="baidu/ERNIE-Image-Turbo",
    description=(
        "ERNIE-Image-Turbo: distilled variant of ERNIE-Image. Same architecture as ERNIE-Image but "
        "tuned for fast inference at 8 steps with CFG disabled (1.0)."
    ),
    type=ModelType.Main,
)
