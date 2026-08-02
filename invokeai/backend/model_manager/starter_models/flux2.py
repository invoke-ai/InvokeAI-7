"""Starter models for the flux2 architecture."""

from invokeai.backend.model_manager.starter_models.common import (
    flux2_klein_qwen3_4b_encoder,
    flux2_klein_qwen3_8b_encoder,
    gemma2_2b_encoder,
)
from invokeai.backend.model_manager.starter_models.types import (
    StarterModel,
)
from invokeai.backend.model_manager.taxonomy import (
    BaseModelType,
    ModelFormat,
    ModelType,
    PiDDecoderVariantType,
)

# FLUX.2 Klein shares one 32-channel VAE across the 4B and 9B variants, so a single decoder per preset covers both.
# The 128-channel packed latent is unambiguous (unlike the 16ch FLUX/SD3 case), so no directory-name disambiguation
# is needed for the config probe.
pid_decoder_flux2_2k = StarterModel(
    name="PiD Decoder FLUX.2 (2K)",
    base=BaseModelType.Flux2,
    source="nvidia/PiD::checkpoints/PiD_res2k_sr4x_official_flux2_distill_4step/model_ema_bf16.pth",
    description="NVIDIA PiD 4x super-resolution decoder for FLUX.2 Klein latents, 2K target preset (e.g. 512 -> 2048). ~5GB",
    type=ModelType.PiDDecoder,
    format=ModelFormat.Checkpoint,
    variant=PiDDecoderVariantType.Res2k_Sr4x,
    dependencies=[gemma2_2b_encoder],
)


pid_decoder_flux2_2kto4k = StarterModel(
    name="PiD Decoder FLUX.2 (2K to 4K)",
    base=BaseModelType.Flux2,
    source="nvidia/PiD::checkpoints_deprecated/PiD_res2kto4k_sr4x_official_flux2_distill_4step/model_ema_bf16.pth",
    description="NVIDIA PiD 4x super-resolution decoder for FLUX.2 Klein latents, 2K-to-4K preset (legacy architecture; NVIDIA's newer v1.5 checkpoint uses a different network that is not yet supported). ~5GB",
    type=ModelType.PiDDecoder,
    format=ModelFormat.Checkpoint,
    variant=PiDDecoderVariantType.Res2kTo4k_Sr4x,
    dependencies=[gemma2_2b_encoder],
)


flux2_vae = StarterModel(
    name="FLUX.2 VAE",
    base=BaseModelType.Flux2,
    source="black-forest-labs/FLUX.2-klein-4B::vae",
    description="FLUX.2 VAE (16-channel, same architecture as FLUX.1 VAE). ~168MB",
    type=ModelType.VAE,
)


flux2_klein_4b = StarterModel(
    name="FLUX.2 Klein 4B (Diffusers)",
    base=BaseModelType.Flux2,
    source="black-forest-labs/FLUX.2-klein-4B",
    description="FLUX.2 Klein 4B in Diffusers format - includes transformer, VAE and Qwen3 encoder. ~16GB",
    type=ModelType.Main,
)


flux2_klein_4b_single = StarterModel(
    name="FLUX.2 Klein 4B",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/main/flux-2-klein-4b.safetensors",
    description="FLUX.2 Klein 4B standalone transformer. Installs with VAE and Qwen3 4B encoder. ~8GB",
    type=ModelType.Main,
    dependencies=[flux2_vae, flux2_klein_qwen3_4b_encoder],
)


flux2_klein_4b_fp8 = StarterModel(
    name="FLUX.2 Klein 4B (FP8)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors",
    description="FLUX.2 Klein 4B FP8 quantized - smaller and faster. Installs with VAE and Qwen3 4B encoder. ~4GB",
    type=ModelType.Main,
    dependencies=[flux2_vae, flux2_klein_qwen3_4b_encoder],
)


flux2_klein_9b = StarterModel(
    name="FLUX.2 Klein 9B (Diffusers)",
    base=BaseModelType.Flux2,
    source="black-forest-labs/FLUX.2-klein-9B",
    description="FLUX.2 Klein 9B in Diffusers format - includes transformer, VAE and Qwen3 encoder. ~35GB",
    type=ModelType.Main,
)


flux2_klein_9b_fp8 = StarterModel(
    name="FLUX.2 Klein 9B (FP8)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-fp8/resolve/main/flux-2-klein-9b-fp8.safetensors",
    description="FLUX.2 Klein 9B FP8 quantized - more efficient than full precision. Installs with VAE and Qwen3 8B encoder. ~9.5GB",
    type=ModelType.Main,
    dependencies=[flux2_vae, flux2_klein_qwen3_8b_encoder],
)


flux2_klein_4b_gguf_q4 = StarterModel(
    name="FLUX.2 Klein 4B (GGUF Q4)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_K_M.gguf",
    description="FLUX.2 Klein 4B GGUF Q4_K_M quantized - runs on 6-8GB VRAM. Installs with VAE and Qwen3 4B encoder. ~2.6GB",
    type=ModelType.Main,
    format=ModelFormat.GGUFQuantized,
    dependencies=[flux2_vae, flux2_klein_qwen3_4b_encoder],
)


flux2_klein_4b_gguf_q8 = StarterModel(
    name="FLUX.2 Klein 4B (GGUF Q8)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q8_0.gguf",
    description="FLUX.2 Klein 4B GGUF Q8_0 quantized - higher quality than Q4. Installs with VAE and Qwen3 4B encoder. ~4.3GB",
    type=ModelType.Main,
    format=ModelFormat.GGUFQuantized,
    dependencies=[flux2_vae, flux2_klein_qwen3_4b_encoder],
)


flux2_klein_9b_gguf_q4 = StarterModel(
    name="FLUX.2 Klein 9B (GGUF Q4)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/resolve/main/flux-2-klein-9b-Q4_K_M.gguf",
    description="FLUX.2 Klein 9B GGUF Q4_K_M quantized - runs on 12GB+ VRAM. Installs with VAE and Qwen3 8B encoder. ~5.8GB",
    type=ModelType.Main,
    format=ModelFormat.GGUFQuantized,
    dependencies=[flux2_vae, flux2_klein_qwen3_8b_encoder],
)


flux2_klein_9b_gguf_q8 = StarterModel(
    name="FLUX.2 Klein 9B (GGUF Q8)",
    base=BaseModelType.Flux2,
    source="https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/resolve/main/flux-2-klein-9b-Q8_0.gguf",
    description="FLUX.2 Klein 9B GGUF Q8_0 quantized - higher quality than Q4. Installs with VAE and Qwen3 8B encoder. ~10GB",
    type=ModelType.Main,
    format=ModelFormat.GGUFQuantized,
    dependencies=[flux2_vae, flux2_klein_qwen3_8b_encoder],
)
