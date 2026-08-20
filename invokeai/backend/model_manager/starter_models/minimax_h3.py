"""MiniMax H3 starter models."""

from invokeai.backend.model_manager.starter_models.types import StarterModel
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelFormat,
    ModelType,
)

minimax_h3_components = StarterModel(
    name="MiniMax H3 Components",
    base=BaseModelType.MiniMaxH3,
    source="MiniMaxAI/MiniMax-H3::modular_model_index.json+transformer/config.json+tokenizer+processor+vae+audio_vae",
    description="MiniMax H3 shared components: tokenizer, processor and video/audio VAEs, without "
    "transformer or text-encoder weights (~11 GB). Pair with the MiniMax H3 single-file transformer "
    "and text encoder. NOTE: This model is distributed under a restrictive license that forbids its "
    "use in certain territories. Please see https://huggingface.co/MiniMaxAI/MiniMax-H3 for details.",
    type=ModelType.Main,
    format=ModelFormat.Diffusers,
)

minimax_h3_int8_text_encoder = StarterModel(
    name="MiniMax H3 Text Encoder (int8)",
    base=BaseModelType.MiniMaxH3,
    source="Comfy-Org/MiniMax-H3::text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
    description="Truncated Qwen3-VL-32B conditioning encoder for MiniMax H3, int8 quantized (~27 GB). "
    "Select it in the MiniMax H3 Model Loader's text encoder field. NOTE: This model is distributed "
    "under a restrictive license that forbids its use in certain territories. Please see "
    "https://huggingface.co/MiniMaxAI/MiniMax-H3 for details.",
    type=ModelType.Qwen3VLEncoder,
    format=ModelFormat.Checkpoint,
)

minimax_h3_int8_transformer = StarterModel(
    name="MiniMax H3 FL2VA Transformer (int8, pruned)",
    base=BaseModelType.MiniMaxH3,
    source="Comfy-Org/MiniMax-H3::diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    description="MiniMax H3 video+audio generation. AdaLN-pruned int8 single-file transformer (~21 GB); "
    "select it in the MiniMax H3 Model Loader's transformer field. Total size with dependencies: ~59 GB. "
    "NOTE: This model is distributed under a restrictive license that forbids its use in certain "
    "territories. Please see https://huggingface.co/MiniMaxAI/MiniMax-H3 for details.",
    type=ModelType.Main,
    format=ModelFormat.Checkpoint,
    dependencies=[minimax_h3_components, minimax_h3_int8_text_encoder],
)

minimax_h3_turbo_lora = StarterModel(
    name="MiniMax H3 Turbo LoRA",
    base=BaseModelType.MiniMaxH3,
    source="larryvrh/MiniMax-H3-Turbo-Lora::minimax_h3_turbo_v4_step600_ema.safetensors",
    description="Step-distillation LoRA for MiniMax H3 (Apache 2.0): renders video+audio in 4-8 "
    "denoising steps instead of ~50. Apply at strength 1.0 and lower Steps to 6-8. Works with the "
    "full and the pruned int8 transformers.",
    type=ModelType.LoRA,
    format=ModelFormat.LyCORIS,
)
