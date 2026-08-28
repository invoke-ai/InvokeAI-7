"""Ideogram 4 starter models."""

from invokeai.backend.model_manager.starter_models.types import StarterModel
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelType,
)

# region Ideogram 4
# Self-contained diffusers pipelines (both transformers + Qwen3-VL text encoder + VAE in one folder), so
# no separate dependencies. Gated, non-commercial license: the license must be accepted on the
# HuggingFace model page and a HuggingFace token configured before the download will succeed — same as
# FLUX.1 dev.
ideogram_4_nf4 = StarterModel(
    name="Ideogram 4 (nf4)",
    base=BaseModelType.Ideogram4,
    source="ideogram-ai/ideogram-4-nf4",
    description="Ideogram 4 text-to-image in nf4-quantized Diffusers format (CUDA only). Structured JSON "
    "prompting with regional layout control. Non-commercial license — accept it on HuggingFace first. ~16GB",
    type=ModelType.Main,
)

ideogram_4_fp8 = StarterModel(
    name="Ideogram 4 (fp8)",
    base=BaseModelType.Ideogram4,
    source="ideogram-ai/ideogram-4-fp8",
    description="Ideogram 4 text-to-image in fp8-quantized Diffusers format (runs on any device, higher "
    "memory use). Non-commercial license — accept it on HuggingFace first. ~26GB",
    type=ModelType.Main,
)
