"""The starter model catalogue.

`STARTER_MODELS` is a curated order, not a derived one: it is what the install dialog shows, in
the sequence someone decided on. It stays written out here rather than assembled from the
per-architecture modules, because assembling it would lose that sequence and nothing could
reconstruct it.

Every name is re-exported, so `from ...starter_models import <anything>` keeps working.
"""

from invokeai.backend.model_manager.starter_models.anima import (
    anima_base as anima_base,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_depth_preview3 as anima_lllite_depth_preview3,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_inpainting as anima_lllite_inpainting,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_lineart_preview3 as anima_lllite_lineart_preview3,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_pose_preview3 as anima_lllite_pose_preview3,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_scribble_preview3 as anima_lllite_scribble_preview3,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_lllite_sketch as anima_lllite_sketch,
)
from invokeai.backend.model_manager.starter_models.anima import (
    anima_vae as anima_vae,
)
from invokeai.backend.model_manager.starter_models.cogview4 import (
    cogview4 as cogview4,
)
from invokeai.backend.model_manager.starter_models.common import (
    anima_qwen3_encoder as anima_qwen3_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    animesharp_v4_rcan as animesharp_v4_rcan,
)
from invokeai.backend.model_manager.starter_models.common import (
    clip_l_encoder as clip_l_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    clip_vit_l_image_encoder as clip_vit_l_image_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    esrgan_srx4 as esrgan_srx4,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_comfy_mistral_bf16 as flux2_dev_comfy_mistral_bf16,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_comfy_mistral_fp4 as flux2_dev_comfy_mistral_fp4,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_comfy_mistral_fp8 as flux2_dev_comfy_mistral_fp8,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_cow_mistral_iq4_xs as flux2_dev_cow_mistral_iq4_xs,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_cow_mistral_q4 as flux2_dev_cow_mistral_q4,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_dev_cow_mistral_q8 as flux2_dev_cow_mistral_q8,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_klein_qwen3_4b_encoder as flux2_klein_qwen3_4b_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    flux2_klein_qwen3_8b_encoder as flux2_klein_qwen3_8b_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    gemma2_2b_encoder as gemma2_2b_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    ip_adapter_sd_image_encoder as ip_adapter_sd_image_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    ip_adapter_sdxl_image_encoder as ip_adapter_sdxl_image_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    llava_onevision as llava_onevision,
)
from invokeai.backend.model_manager.starter_models.common import (
    llava_onevision_7b as llava_onevision_7b,
)
from invokeai.backend.model_manager.starter_models.common import (
    qwen2_5_1_5b_instruct as qwen2_5_1_5b_instruct,
)
from invokeai.backend.model_manager.starter_models.common import (
    qwen2_5_3b_instruct as qwen2_5_3b_instruct,
)
from invokeai.backend.model_manager.starter_models.common import (
    qwen3_vl_encoder_4b as qwen3_vl_encoder_4b,
)
from invokeai.backend.model_manager.starter_models.common import (
    qwen_vl_encoder_diffusers as qwen_vl_encoder_diffusers,
)
from invokeai.backend.model_manager.starter_models.common import (
    qwen_vl_encoder_fp8 as qwen_vl_encoder_fp8,
)
from invokeai.backend.model_manager.starter_models.common import (
    realesrgan_x2 as realesrgan_x2,
)
from invokeai.backend.model_manager.starter_models.common import (
    realesrgan_x4 as realesrgan_x4,
)
from invokeai.backend.model_manager.starter_models.common import (
    siglip as siglip,
)
from invokeai.backend.model_manager.starter_models.common import (
    smollm2_1_7b_instruct as smollm2_1_7b_instruct,
)
from invokeai.backend.model_manager.starter_models.common import (
    swinir as swinir,
)
from invokeai.backend.model_manager.starter_models.common import (
    t5_8b_quantized_encoder as t5_8b_quantized_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    t5_base_encoder as t5_base_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    t5_gguf_q3_k_s_encoder as t5_gguf_q3_k_s_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    t5_gguf_q6_k_encoder as t5_gguf_q6_k_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    wan_22_t5_encoder as wan_22_t5_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    z_image_qwen3_encoder as z_image_qwen3_encoder,
)
from invokeai.backend.model_manager.starter_models.common import (
    z_image_qwen3_encoder_quantized as z_image_qwen3_encoder_quantized,
)
from invokeai.backend.model_manager.starter_models.ernie_image import (
    ernie_image as ernie_image,
)
from invokeai.backend.model_manager.starter_models.ernie_image import (
    ernie_image_turbo as ernie_image_turbo,
)
from invokeai.backend.model_manager.starter_models.external import (
    GEMINI_3_1_FLASH_RESOLUTION_PRESETS as GEMINI_3_1_FLASH_RESOLUTION_PRESETS,
)
from invokeai.backend.model_manager.starter_models.external import (
    GEMINI_3_IMAGE_ALLOWED_ASPECT_RATIOS as GEMINI_3_IMAGE_ALLOWED_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    GEMINI_3_IMAGE_MAX_SIZE as GEMINI_3_IMAGE_MAX_SIZE,
)
from invokeai.backend.model_manager.starter_models.external import (
    GEMINI_3_PRO_RESOLUTION_PRESETS as GEMINI_3_PRO_RESOLUTION_PRESETS,
)
from invokeai.backend.model_manager.starter_models.external import (
    OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES as OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES,
)
from invokeai.backend.model_manager.starter_models.external import (
    OPENAI_GPT_IMAGE_ASPECT_RATIOS as OPENAI_GPT_IMAGE_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    OPENAI_GPT_IMAGE_PANEL_SCHEMA as OPENAI_GPT_IMAGE_PANEL_SCHEMA,
)
from invokeai.backend.model_manager.starter_models.external import (
    QWEN_IMAGE_2_ALLOWED_ASPECT_RATIOS as QWEN_IMAGE_2_ALLOWED_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    QWEN_IMAGE_MAX_ALLOWED_ASPECT_RATIOS as QWEN_IMAGE_MAX_ALLOWED_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    SEEDREAM_1K_SIZES as SEEDREAM_1K_SIZES,
)
from invokeai.backend.model_manager.starter_models.external import (
    SEEDREAM_2K_SIZES as SEEDREAM_2K_SIZES,
)
from invokeai.backend.model_manager.starter_models.external import (
    SEEDREAM_ASPECT_RATIOS as SEEDREAM_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    SEEDREAM_PANEL_SCHEMA as SEEDREAM_PANEL_SCHEMA,
)
from invokeai.backend.model_manager.starter_models.external import (
    WAN_V2_ALLOWED_ASPECT_RATIOS as WAN_V2_ALLOWED_ASPECT_RATIOS,
)
from invokeai.backend.model_manager.starter_models.external import (
    _gemini_3_resolution_presets as _gemini_3_resolution_presets,
)
from invokeai.backend.model_manager.starter_models.external import (
    alibabacloud_qwen_image_2 as alibabacloud_qwen_image_2,
)
from invokeai.backend.model_manager.starter_models.external import (
    alibabacloud_qwen_image_2_pro as alibabacloud_qwen_image_2_pro,
)
from invokeai.backend.model_manager.starter_models.external import (
    alibabacloud_qwen_image_edit_max as alibabacloud_qwen_image_edit_max,
)
from invokeai.backend.model_manager.starter_models.external import (
    alibabacloud_qwen_image_max as alibabacloud_qwen_image_max,
)
from invokeai.backend.model_manager.starter_models.external import (
    alibabacloud_wan26_t2i as alibabacloud_wan26_t2i,
)
from invokeai.backend.model_manager.starter_models.external import (
    gemini_3_1_flash_image_preview as gemini_3_1_flash_image_preview,
)
from invokeai.backend.model_manager.starter_models.external import (
    gemini_flash_image as gemini_flash_image,
)
from invokeai.backend.model_manager.starter_models.external import (
    gemini_pro_image_preview as gemini_pro_image_preview,
)
from invokeai.backend.model_manager.starter_models.external import (
    openai_dall_e_3 as openai_dall_e_3,
)
from invokeai.backend.model_manager.starter_models.external import (
    openai_gpt_image_1 as openai_gpt_image_1,
)
from invokeai.backend.model_manager.starter_models.external import (
    openai_gpt_image_1_5 as openai_gpt_image_1_5,
)
from invokeai.backend.model_manager.starter_models.external import (
    openai_gpt_image_1_mini as openai_gpt_image_1_mini,
)
from invokeai.backend.model_manager.starter_models.external import (
    openai_gpt_image_2 as openai_gpt_image_2,
)
from invokeai.backend.model_manager.starter_models.external import (
    seedream_4_0 as seedream_4_0,
)
from invokeai.backend.model_manager.starter_models.external import (
    seedream_4_5 as seedream_4_5,
)
from invokeai.backend.model_manager.starter_models.external import (
    seedream_5_0 as seedream_5_0,
)
from invokeai.backend.model_manager.starter_models.external import (
    seedream_5_0_lite as seedream_5_0_lite,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_canny_control_lora as flux_canny_control_lora,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_depth_control_lora as flux_depth_control_lora,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_dev as flux_dev,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_dev_quantized as flux_dev_quantized,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_fill as flux_fill,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_kontext as flux_kontext,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_kontext_quantized as flux_kontext_quantized,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_krea as flux_krea,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_krea_quantized as flux_krea_quantized,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_redux as flux_redux,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_schnell as flux_schnell,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_schnell_quantized as flux_schnell_quantized,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_schnell_sdnq as flux_schnell_sdnq,
)
from invokeai.backend.model_manager.starter_models.flux import (
    flux_vae as flux_vae,
)
from invokeai.backend.model_manager.starter_models.flux import (
    ip_adapter_flux as ip_adapter_flux,
)
from invokeai.backend.model_manager.starter_models.flux import (
    pid_decoder_flux_2k as pid_decoder_flux_2k,
)
from invokeai.backend.model_manager.starter_models.flux import (
    pid_decoder_flux_2kto4k as pid_decoder_flux_2kto4k,
)
from invokeai.backend.model_manager.starter_models.flux import (
    union_cnet_flux as union_cnet_flux,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_diffusers as flux2_dev_diffusers,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_diffusers_nf4 as flux2_dev_diffusers_nf4,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_gguf_q3_k_m as flux2_dev_gguf_q3_k_m,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_gguf_q4_k_m as flux2_dev_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_gguf_q5_k_m as flux2_dev_gguf_q5_k_m,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_gguf_q6_k as flux2_dev_gguf_q6_k,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_dev_gguf_q8_0 as flux2_dev_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b as flux2_klein_4b,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b_fp8 as flux2_klein_4b_fp8,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b_gguf_q4 as flux2_klein_4b_gguf_q4,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b_gguf_q8 as flux2_klein_4b_gguf_q8,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b_sdnq as flux2_klein_4b_sdnq,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_4b_single as flux2_klein_4b_single,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_9b as flux2_klein_9b,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_9b_fp8 as flux2_klein_9b_fp8,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_9b_gguf_q4 as flux2_klein_9b_gguf_q4,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_9b_gguf_q8 as flux2_klein_9b_gguf_q8,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_klein_9b_sdnq as flux2_klein_9b_sdnq,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    flux2_vae as flux2_vae,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    pid_decoder_flux2_2k as pid_decoder_flux2_2k,
)
from invokeai.backend.model_manager.starter_models.flux2 import (
    pid_decoder_flux2_2kto4k as pid_decoder_flux2_2kto4k,
)
from invokeai.backend.model_manager.starter_models.ideogram_4 import (
    ideogram_4_fp8 as ideogram_4_fp8,
)
from invokeai.backend.model_manager.starter_models.ideogram_4 import (
    ideogram_4_nf4 as ideogram_4_nf4,
)
from invokeai.backend.model_manager.starter_models.krea_2 import (
    krea2_raw as krea2_raw,
)
from invokeai.backend.model_manager.starter_models.krea_2 import (
    krea2_turbo as krea2_turbo,
)
from invokeai.backend.model_manager.starter_models.krea_2 import (
    krea2_turbo_gguf_q4_k_m as krea2_turbo_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.krea_2 import (
    krea2_turbo_gguf_q8_0 as krea2_turbo_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.minimax_h3 import (
    minimax_h3_components as minimax_h3_components,
)
from invokeai.backend.model_manager.starter_models.minimax_h3 import (
    minimax_h3_int8_text_encoder as minimax_h3_int8_text_encoder,
)
from invokeai.backend.model_manager.starter_models.minimax_h3 import (
    minimax_h3_int8_transformer as minimax_h3_int8_transformer,
)
from invokeai.backend.model_manager.starter_models.minimax_h3 import (
    minimax_h3_lightx2v_turbo_lora as minimax_h3_lightx2v_turbo_lora,
)
from invokeai.backend.model_manager.starter_models.minimax_h3 import (
    minimax_h3_turbo_lora as minimax_h3_turbo_lora,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    pid_decoder_qwenimage_2kto4k as pid_decoder_qwenimage_2kto4k,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image as qwen_image,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit as qwen_image_edit,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_gguf_q2_k as qwen_image_edit_gguf_q2_k,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_gguf_q4_k_m as qwen_image_edit_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_gguf_q6_k as qwen_image_edit_gguf_q6_k,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_gguf_q8_0 as qwen_image_edit_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_lightning_4step as qwen_image_edit_lightning_4step,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_edit_lightning_8step as qwen_image_edit_lightning_8step,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_gguf_q2_k as qwen_image_gguf_q2_k,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_gguf_q4_k_m as qwen_image_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_gguf_q6_k as qwen_image_gguf_q6_k,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_gguf_q8_0 as qwen_image_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_lightning_4step as qwen_image_lightning_4step,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_lightning_8step as qwen_image_lightning_8step,
)
from invokeai.backend.model_manager.starter_models.qwen_image import (
    qwen_image_vae as qwen_image_vae,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    canny_sd1 as canny_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    cyberrealistic_negative as cyberrealistic_negative,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    cyberrealistic_sd1 as cyberrealistic_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    deliberate_inpainting_sd1 as deliberate_inpainting_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    deliberate_sd1 as deliberate_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    depth_sd1 as depth_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    dreamshaper_8_inpainting_sd1 as dreamshaper_8_inpainting_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    dreamshaper_8_sd1 as dreamshaper_8_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    easy_neg_sd1 as easy_neg_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    inpaint_cnet_sd1 as inpaint_cnet_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    ip_adapter_plus_face_sd1 as ip_adapter_plus_face_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    ip_adapter_plus_sd1 as ip_adapter_plus_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    ip_adapter_sd1 as ip_adapter_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    lineart_anime_sd1 as lineart_anime_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    lineart_sd1 as lineart_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    mlsd_sd1 as mlsd_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    normal_bae_sd1 as normal_bae_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    openpose_sd1 as openpose_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    qr_code_cnet_sd1 as qr_code_cnet_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    rev_animated_sd1 as rev_animated_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    scribble_sd1 as scribble_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    seg_sd1 as seg_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    shuffle_sd1 as shuffle_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    softedge_sd1 as softedge_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    t2i_canny_sd1 as t2i_canny_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    t2i_depth_sd1 as t2i_depth_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    t2i_sketch_sd1 as t2i_sketch_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_1 import (
    tile_sd1 as tile_sd1,
)
from invokeai.backend.model_manager.starter_models.sd_3 import (
    pid_decoder_sd3_2k as pid_decoder_sd3_2k,
)
from invokeai.backend.model_manager.starter_models.sd_3 import (
    pid_decoder_sd3_2kto4k as pid_decoder_sd3_2kto4k,
)
from invokeai.backend.model_manager.starter_models.sd_3 import (
    sd35_large as sd35_large,
)
from invokeai.backend.model_manager.starter_models.sd_3 import (
    sd35_medium as sd35_medium,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    alien_lora_sdxl as alien_lora_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    archvis_sdxl as archvis_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    canny_sdxl as canny_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    depth_sdxl as depth_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    dreamshaper_sdxl as dreamshaper_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    ip_adapter_plus_sdxl as ip_adapter_plus_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    ip_adapter_sdxl as ip_adapter_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    juggernaut_sdxl as juggernaut_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    noodle_lora_sdxl as noodle_lora_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    openpose_sdxl as openpose_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    pid_decoder_sdxl_2kto4k as pid_decoder_sdxl_2kto4k,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    qr_code_cnet_sdxl as qr_code_cnet_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    scribble_sdxl as scribble_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    sdxl_fp16_vae_fix as sdxl_fp16_vae_fix,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    softedge_sdxl as softedge_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    t2i_canny_sdxl as t2i_canny_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    t2i_lineart_sdxl as t2i_lineart_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    t2i_sketch_sdxl as t2i_sketch_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    tile_sdxl as tile_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl import (
    union_cnet_sdxl as union_cnet_sdxl,
)
from invokeai.backend.model_manager.starter_models.sdxl_refiner import (
    sdxl_refiner as sdxl_refiner,
)
from invokeai.backend.model_manager.starter_models.types import (
    StarterModel as StarterModel,
)
from invokeai.backend.model_manager.starter_models.types import (
    StarterModelBundle as StarterModelBundle,
)
from invokeai.backend.model_manager.starter_models.types import (
    StarterModelWithoutDependencies as StarterModelWithoutDependencies,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_5b_vae as wan_22_5b_vae,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_a14b_vae as wan_22_a14b_vae,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_a14b_diffusers as wan_22_i2v_a14b_diffusers,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_a14b_gguf_q4_k_m as wan_22_i2v_a14b_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_a14b_gguf_q8_0 as wan_22_i2v_a14b_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_a14b_low_gguf_q4_k_m as wan_22_i2v_a14b_low_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_a14b_low_gguf_q8_0 as wan_22_i2v_a14b_low_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_lightning_high as wan_22_i2v_lightning_high,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_i2v_lightning_low as wan_22_i2v_lightning_low,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_a14b_diffusers as wan_22_t2v_a14b_diffusers,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_a14b_gguf_q4_k_m as wan_22_t2v_a14b_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_a14b_gguf_q8_0 as wan_22_t2v_a14b_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_a14b_low_gguf_q4_k_m as wan_22_t2v_a14b_low_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_a14b_low_gguf_q8_0 as wan_22_t2v_a14b_low_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_lightning_high as wan_22_t2v_lightning_high,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_t2v_lightning_low as wan_22_t2v_lightning_low,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_ti2v_5b_diffusers as wan_22_ti2v_5b_diffusers,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_ti2v_5b_gguf_q4_k_m as wan_22_ti2v_5b_gguf_q4_k_m,
)
from invokeai.backend.model_manager.starter_models.wan import (
    wan_22_ti2v_5b_gguf_q8_0 as wan_22_ti2v_5b_gguf_q8_0,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_controlnet_tile as z_image_controlnet_tile,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_controlnet_union as z_image_controlnet_union,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_turbo as z_image_turbo,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_turbo_q8 as z_image_turbo_q8,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_turbo_quantized as z_image_turbo_quantized,
)
from invokeai.backend.model_manager.starter_models.z_image import (
    z_image_turbo_sdnq as z_image_turbo_sdnq,
)
from invokeai.backend.model_manager.taxonomy import BaseModelType

# List of starter models, displayed on the frontend.
# The order/sort of this list is not changed by the frontend - set it how you want it here.
STARTER_MODELS: list[StarterModel] = [
    flux_kontext_quantized,
    flux_schnell_quantized,
    flux_dev_quantized,
    flux_schnell,
    flux_dev,
    flux_schnell_sdnq,
    sd35_medium,
    sd35_large,
    ideogram_4_nf4,
    ideogram_4_fp8,
    cyberrealistic_sd1,
    rev_animated_sd1,
    dreamshaper_8_sd1,
    dreamshaper_8_inpainting_sd1,
    deliberate_sd1,
    deliberate_inpainting_sd1,
    juggernaut_sdxl,
    dreamshaper_sdxl,
    archvis_sdxl,
    sdxl_refiner,
    sdxl_fp16_vae_fix,
    flux_vae,
    alien_lora_sdxl,
    noodle_lora_sdxl,
    easy_neg_sd1,
    ip_adapter_sd1,
    ip_adapter_plus_sd1,
    ip_adapter_plus_face_sd1,
    ip_adapter_sdxl,
    ip_adapter_plus_sdxl,
    ip_adapter_flux,
    qr_code_cnet_sd1,
    qr_code_cnet_sdxl,
    canny_sd1,
    inpaint_cnet_sd1,
    mlsd_sd1,
    depth_sd1,
    normal_bae_sd1,
    seg_sd1,
    lineart_sd1,
    lineart_anime_sd1,
    openpose_sd1,
    scribble_sd1,
    softedge_sd1,
    shuffle_sd1,
    tile_sd1,
    canny_sdxl,
    depth_sdxl,
    softedge_sdxl,
    openpose_sdxl,
    scribble_sdxl,
    tile_sdxl,
    union_cnet_sdxl,
    union_cnet_flux,
    flux_canny_control_lora,
    flux_depth_control_lora,
    t2i_canny_sd1,
    t2i_sketch_sd1,
    t2i_depth_sd1,
    t2i_canny_sdxl,
    t2i_lineart_sdxl,
    t2i_sketch_sdxl,
    realesrgan_x4,
    animesharp_v4_rcan,
    realesrgan_x2,
    swinir,
    t5_base_encoder,
    t5_8b_quantized_encoder,
    t5_gguf_q3_k_s_encoder,
    t5_gguf_q6_k_encoder,
    clip_l_encoder,
    clip_vit_l_image_encoder,
    siglip,
    flux_redux,
    llava_onevision,
    llava_onevision_7b,
    qwen2_5_1_5b_instruct,
    qwen2_5_3b_instruct,
    smollm2_1_7b_instruct,
    flux_fill,
    flux2_vae,
    flux2_klein_4b,
    flux2_klein_4b_single,
    flux2_klein_4b_fp8,
    flux2_klein_9b,
    flux2_klein_9b_fp8,
    flux2_klein_4b_sdnq,
    flux2_klein_9b_sdnq,
    flux2_klein_4b_gguf_q4,
    flux2_klein_4b_gguf_q8,
    flux2_klein_9b_gguf_q4,
    flux2_klein_9b_gguf_q8,
    flux2_klein_qwen3_4b_encoder,
    flux2_klein_qwen3_8b_encoder,
    flux2_dev_comfy_mistral_bf16,
    flux2_dev_comfy_mistral_fp4,
    flux2_dev_comfy_mistral_fp8,
    flux2_dev_cow_mistral_iq4_xs,
    flux2_dev_cow_mistral_q4,
    flux2_dev_cow_mistral_q8,
    flux2_dev_diffusers,
    flux2_dev_diffusers_nf4,
    flux2_dev_gguf_q3_k_m,
    flux2_dev_gguf_q4_k_m,
    flux2_dev_gguf_q5_k_m,
    flux2_dev_gguf_q6_k,
    flux2_dev_gguf_q8_0,
    cogview4,
    qwen_image_vae,
    qwen_vl_encoder_fp8,
    qwen_vl_encoder_diffusers,
    qwen_image_edit,
    qwen_image_edit_gguf_q2_k,
    qwen_image_edit_gguf_q4_k_m,
    qwen_image_edit_gguf_q6_k,
    qwen_image_edit_gguf_q8_0,
    qwen_image_edit_lightning_4step,
    qwen_image_edit_lightning_8step,
    qwen_image,
    qwen_image_gguf_q2_k,
    qwen_image_gguf_q4_k_m,
    qwen_image_gguf_q6_k,
    qwen_image_gguf_q8_0,
    qwen_image_lightning_4step,
    qwen_image_lightning_8step,
    flux_krea,
    flux_krea_quantized,
    z_image_turbo,
    z_image_turbo_quantized,
    z_image_turbo_q8,
    z_image_turbo_sdnq,
    z_image_qwen3_encoder,
    z_image_qwen3_encoder_quantized,
    z_image_controlnet_union,
    z_image_controlnet_tile,
    ernie_image,
    ernie_image_turbo,
    krea2_turbo,
    krea2_raw,
    krea2_turbo_gguf_q4_k_m,
    krea2_turbo_gguf_q8_0,
    qwen3_vl_encoder_4b,
    wan_22_t5_encoder,
    wan_22_a14b_vae,
    wan_22_5b_vae,
    wan_22_t2v_a14b_diffusers,
    wan_22_t2v_a14b_low_gguf_q4_k_m,
    wan_22_t2v_a14b_gguf_q4_k_m,
    wan_22_t2v_a14b_low_gguf_q8_0,
    wan_22_t2v_a14b_gguf_q8_0,
    wan_22_t2v_lightning_high,
    wan_22_t2v_lightning_low,
    wan_22_i2v_a14b_diffusers,
    wan_22_i2v_a14b_low_gguf_q4_k_m,
    wan_22_i2v_a14b_gguf_q4_k_m,
    wan_22_i2v_a14b_low_gguf_q8_0,
    wan_22_i2v_a14b_gguf_q8_0,
    wan_22_i2v_lightning_high,
    wan_22_i2v_lightning_low,
    wan_22_ti2v_5b_diffusers,
    wan_22_ti2v_5b_gguf_q4_k_m,
    wan_22_ti2v_5b_gguf_q8_0,
    minimax_h3_int8_transformer,
    minimax_h3_int8_text_encoder,
    minimax_h3_components,
    minimax_h3_turbo_lora,
    minimax_h3_lightx2v_turbo_lora,
    gemini_flash_image,
    gemini_pro_image_preview,
    gemini_3_1_flash_image_preview,
    openai_gpt_image_2,
    openai_gpt_image_1_5,
    openai_gpt_image_1,
    openai_gpt_image_1_mini,
    openai_dall_e_3,
    seedream_5_0,
    seedream_5_0_lite,
    seedream_4_5,
    seedream_4_0,
    alibabacloud_qwen_image_2_pro,
    alibabacloud_qwen_image_2,
    alibabacloud_qwen_image_max,
    alibabacloud_wan26_t2i,
    alibabacloud_qwen_image_edit_max,
    anima_base,
    anima_qwen3_encoder,
    anima_vae,
    anima_lllite_inpainting,
    anima_lllite_sketch,
    anima_lllite_depth_preview3,
    anima_lllite_scribble_preview3,
    anima_lllite_lineart_preview3,
    anima_lllite_pose_preview3,
    gemma2_2b_encoder,
    pid_decoder_flux_2k,
    pid_decoder_flux_2kto4k,
    pid_decoder_flux2_2k,
    pid_decoder_flux2_2kto4k,
    pid_decoder_sd3_2k,
    pid_decoder_sd3_2kto4k,
    pid_decoder_sdxl_2kto4k,
    pid_decoder_qwenimage_2kto4k,
]

sd1_bundle: list[StarterModel] = [
    dreamshaper_8_sd1,
    easy_neg_sd1,
    ip_adapter_sd1,
    ip_adapter_plus_sd1,
    ip_adapter_plus_face_sd1,
    canny_sd1,
    inpaint_cnet_sd1,
    mlsd_sd1,
    depth_sd1,
    normal_bae_sd1,
    seg_sd1,
    lineart_sd1,
    lineart_anime_sd1,
    openpose_sd1,
    scribble_sd1,
    softedge_sd1,
    shuffle_sd1,
    tile_sd1,
    swinir,
]

sdxl_bundle: list[StarterModel] = [
    juggernaut_sdxl,
    sdxl_fp16_vae_fix,
    ip_adapter_sdxl,
    ip_adapter_plus_sdxl,
    canny_sdxl,
    depth_sdxl,
    softedge_sdxl,
    openpose_sdxl,
    scribble_sdxl,
    tile_sdxl,
    swinir,
]

flux_bundle: list[StarterModel] = [
    flux_schnell_quantized,
    flux_dev_quantized,
    flux_vae,
    t5_8b_quantized_encoder,
    clip_l_encoder,
    union_cnet_flux,
    ip_adapter_flux,
    flux_canny_control_lora,
    flux_depth_control_lora,
    flux_redux,
    flux_fill,
    flux_kontext_quantized,
    flux_krea_quantized,
]

zimage_bundle: list[StarterModel] = [
    z_image_turbo_quantized,
    z_image_qwen3_encoder_quantized,
    z_image_controlnet_union,
    z_image_controlnet_tile,
    flux_vae,
]

flux2_klein_bundle: list[StarterModel] = [
    flux2_klein_4b_gguf_q4,
    flux2_vae,
    flux2_klein_qwen3_4b_encoder,
]

# Turbo only: both checkpoints are 8B and the full pipeline is a large download, so the bundle
# ships the fast default. The undistilled `ernie_image` is still installable individually.
ernie_image_bundle: list[StarterModel] = [
    ernie_image_turbo,
]

qwen_image_bundle: list[StarterModel] = [
    qwen_image_vae,
    qwen_vl_encoder_fp8,
    qwen_image_edit,
    qwen_image_edit_gguf_q4_k_m,
    qwen_image_edit_gguf_q8_0,
    qwen_image_edit_lightning_4step,
    qwen_image_edit_lightning_8step,
    qwen_image,
    qwen_image_gguf_q4_k_m,
    qwen_image_gguf_q8_0,
    qwen_image_lightning_4step,
    qwen_image_lightning_8step,
]

anima_bundle: list[StarterModel] = [
    anima_base,
    anima_qwen3_encoder,
    anima_vae,
    anima_lllite_inpainting,
    anima_lllite_sketch,
]

krea2_bundle: list[StarterModel] = [
    qwen_image_vae,
    qwen3_vl_encoder_4b,
    krea2_turbo,
    krea2_raw,
    krea2_turbo_gguf_q4_k_m,
    krea2_turbo_gguf_q8_0,
]

# Wan 2.2 starter bundles. Split into T2V and I2V so users only pay for the
# capability they need: a 12 GB card can install just the T2V bundle and have
# both text-to-video (T2V-A14B) and a low-VRAM image-to-video option (via
# TI2V-5B, which handles both modes in one ~3.4 GB model). The I2V bundle adds
# the heavier I2V-A14B path for users with more headroom. Q8 variants and full
# Diffusers builds stay available as a-la-carte starters.
wan_t2v_bundle: list[StarterModel] = [
    wan_22_t5_encoder,
    wan_22_a14b_vae,
    wan_22_5b_vae,
    wan_22_ti2v_5b_gguf_q4_k_m,
    wan_22_t2v_a14b_gguf_q4_k_m,
    wan_22_t2v_a14b_low_gguf_q4_k_m,
    wan_22_t2v_lightning_high,
    wan_22_t2v_lightning_low,
]

wan_i2v_bundle: list[StarterModel] = [
    wan_22_t5_encoder,
    wan_22_a14b_vae,
    wan_22_i2v_a14b_gguf_q4_k_m,
    wan_22_i2v_a14b_low_gguf_q4_k_m,
    wan_22_i2v_lightning_high,
    wan_22_i2v_lightning_low,
]

# nf4 is the recommended 24GB CUDA path; the fp8 build is offered separately for non-CUDA / more VRAM.
ideogram_bundle: list[StarterModel] = [
    ideogram_4_nf4,
]

# The working set for MiniMax H3 video+audio generation (~62 GB): shared components from
# the official repo plus Comfy-Org's int8 single-file transformer and text encoder, and the
# two turbo (step-distillation) LoRAs for fast low-step rendering. See the license note in
# the MiniMax H3 region above.
minimax_h3_bundle: list[StarterModel] = [
    minimax_h3_components,
    minimax_h3_int8_text_encoder,
    minimax_h3_int8_transformer,
    minimax_h3_turbo_lora,
    minimax_h3_lightx2v_turbo_lora,
]

STARTER_BUNDLES: dict[str, StarterModelBundle] = {
    BaseModelType.StableDiffusion1: StarterModelBundle(name="Stable Diffusion 1.5", models=sd1_bundle),
    BaseModelType.StableDiffusionXL: StarterModelBundle(name="SDXL", models=sdxl_bundle),
    BaseModelType.Flux: StarterModelBundle(name="FLUX.1 dev", models=flux_bundle),
    BaseModelType.Flux2: StarterModelBundle(name="FLUX.2 Klein", models=flux2_klein_bundle),
    BaseModelType.ZImage: StarterModelBundle(name="Z-Image Turbo", models=zimage_bundle),
    BaseModelType.ErnieImage: StarterModelBundle(name="ERNIE-Image", models=ernie_image_bundle),
    BaseModelType.QwenImage: StarterModelBundle(name="Qwen Image", models=qwen_image_bundle),
    BaseModelType.Anima: StarterModelBundle(name="Anima", models=anima_bundle),
    BaseModelType.Krea2: StarterModelBundle(name="Krea-2", models=krea2_bundle),
    "wan_t2v": StarterModelBundle(name="Wan 2.2 Text-to-Video", models=wan_t2v_bundle),
    "wan_i2v": StarterModelBundle(name="Wan 2.2 Image-to-Video", models=wan_i2v_bundle),
    BaseModelType.MiniMaxH3: StarterModelBundle(name="MiniMax H3", models=minimax_h3_bundle),
    BaseModelType.Ideogram4: StarterModelBundle(name="Ideogram 4", models=ideogram_bundle),
}

assert len(STARTER_MODELS) == len({m.source for m in STARTER_MODELS}), "Duplicate starter models"
