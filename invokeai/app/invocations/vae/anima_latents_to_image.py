"""Anima latents-to-image invocation.

Decodes Anima latents using the QwenImage VAE (AutoencoderKLWan) or
compatible FLUX VAE as fallback.

Latents from the denoiser are in normalized space (zero-centered). Before
VAE decode, they must be denormalized using the Wan 2.1 per-channel
mean/std: latents = latents * std + mean (matching diffusers WanPipeline).

The VAE expects 5D latents [B, C, T, H, W] — for single images, T=1.
"""

import torch
from diffusers.models.autoencoders import AutoencoderKLWan
from einops import rearrange
from PIL import Image

from invokeai.app.invocations.baseinvocation import BaseInvocation, Classification, invocation
from invokeai.app.invocations.fields import (
    FieldDescriptions,
    Input,
    InputField,
    LatentsField,
    WithBoard,
    WithMetadata,
)
from invokeai.app.invocations.model import VAEField
from invokeai.app.invocations.primitives import ImageOutput
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.backend.flux.modules.autoencoder import AutoEncoder as FluxAutoEncoder
from invokeai.backend.util.devices import TorchDevice
from invokeai.backend.util.vae_decode_diagnostics import (
    allocator_state_summary,
    force_real_empty_cache,
    nonfinite_fraction,
    scan_module_for_nonfinite_weights,
)
from invokeai.backend.util.vae_working_memory import (
    estimate_vae_working_memory_anima,
    estimate_vae_working_memory_flux,
)

# Tile geometry for tiled Wan VAE decode. 512px tiles with a 384px stride (128px blended
# overlap) cap peak decode working memory at ~1.7GB regardless of image size, while images
# <=512px still decode in a single pass.
ANIMA_VAE_TILE_SIZE = 512
ANIMA_VAE_TILE_STRIDE = 384


def _is_oom_error(e: RuntimeError) -> bool:
    """Return True if the error indicates an out-of-memory condition.

    The caching allocator raises torch.cuda.OutOfMemoryError, but an OOM surfaced from inside a
    cuDNN/cuBLAS kernel (e.g. workspace allocation in the Wan VAE's convolutions) arrives as a
    plain RuntimeError, which must be matched by message. XPU exhaustion likewise arrives as a
    plain RuntimeError, naming the Level Zero/UR result code (`..._OUT_OF_DEVICE_MEMORY`) rather
    than the words "out of memory" -- so it needs its own spelling to be matched here.

    `out_of_host_memory` is knowingly over-broad: Level Zero returns it for driver-side resource
    failures generally (kernel compilation, handle exhaustion), not only host allocation. Matching
    it means a genuinely broken decode costs one wasted tiled retry before the error re-raises
    unchanged. That is preferred over the alternative -- a real host-memory exhaustion that skips
    the retry -- because the retry is bounded and non-destructive, while a missed OOM fails a
    generation that would have succeeded tiled.
    """
    if isinstance(e, torch.cuda.OutOfMemoryError):
        return True
    msg = str(e).lower()
    return (
        "out of memory" in msg
        or "out_of_device_memory" in msg
        or "out_of_host_memory" in msg
        or "cudnn_status_alloc_failed" in msg
        or "cublas_status_alloc_failed" in msg
    )


@invocation(
    "anima_l2i",
    title="Latents to Image - Anima",
    tags=["latents", "image", "vae", "l2i", "anima"],
    category="latents",
    version="1.0.3",
    classification=Classification.Prototype,
)
class AnimaLatentsToImageInvocation(BaseInvocation, WithMetadata, WithBoard):
    """Generates an image from latents using the Anima VAE.

    Supports the Wan 2.1 QwenImage VAE (AutoencoderKLWan) with explicit
    latent denormalization, and FLUX VAE as fallback.
    """

    latents: LatentsField = InputField(description=FieldDescriptions.latents, input=Input.Connection)
    vae: VAEField = InputField(description=FieldDescriptions.vae, input=Input.Connection)

    @staticmethod
    def _use_tiled_decode(device: torch.device, full_decode_working_memory: int) -> bool:
        """Decide whether to decode in tiles.

        A full 1024x1024 Wan VAE decode reserves ~6GB of working memory. On small-VRAM
        GPUs this evicts the (~4GB) Anima transformer from the model cache and thrashes
        the allocator near the VRAM ceiling (decode times of 7s+ observed on 8GB, vs
        ~1s tiled with the transformer left resident). Tile when the full-decode working
        memory would consume most of the device, otherwise a single-pass decode is
        faster (~0.65s vs ~1.05s at 1024x1024) and exact.
        """
        if device.type == "cuda":
            total_vram = torch.cuda.get_device_properties(device).total_memory
        elif device.type == "xpu":
            total_vram = torch.xpu.get_device_properties(device).total_memory
        else:
            return False
        return full_decode_working_memory > 0.7 * total_vram

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> ImageOutput:
        latents = context.tensors.load(self.latents.latents_name)

        vae_info = context.models.load(self.vae.vae)
        if not isinstance(vae_info.model, (AutoencoderKLWan, FluxAutoEncoder)):
            raise TypeError(
                f"Expected AutoencoderKLWan or FluxAutoEncoder for Anima VAE, got {type(vae_info.model).__name__}."
            )

        use_tiling = False
        if isinstance(vae_info.model, AutoencoderKLWan):
            full_decode_working_memory = estimate_vae_working_memory_anima(
                operation="decode",
                image_tensor=latents,
                vae=vae_info.model,
                tile_size=None,
            )
            use_tiling = self._use_tiled_decode(TorchDevice.choose_torch_device(), full_decode_working_memory)
            estimated_working_memory = estimate_vae_working_memory_anima(
                operation="decode",
                image_tensor=latents,
                vae=vae_info.model,
                tile_size=ANIMA_VAE_TILE_SIZE if use_tiling else None,
            )
        else:
            estimated_working_memory = estimate_vae_working_memory_flux(
                operation="decode",
                image_tensor=latents,
                vae=vae_info.model,
            )

        with vae_info.model_on_device(working_mem_bytes=estimated_working_memory) as (_, vae):
            context.util.signal_progress("Running Anima VAE decode")
            if not isinstance(vae, (AutoencoderKLWan, FluxAutoEncoder)):
                raise TypeError(f"Expected AutoencoderKLWan or FluxAutoEncoder, got {type(vae).__name__}.")

            vae_dtype = next(iter(vae.parameters())).dtype
            # Use the VAE's intended compute device (CUDA/MPS, or CPU if configured cpu_only). Do NOT infer it from
            # current param residency: partial loading may have temporarily offloaded all weights to RAM, which would
            # wrongly place the latents (and thus the whole decode) on the CPU (see #9373).
            latents = latents.to(device=vae_info.compute_device, dtype=vae_dtype)

            TorchDevice.empty_cache()

            with torch.inference_mode():
                if isinstance(vae, FluxAutoEncoder):
                    # FLUX VAE handles scaling internally, expects 4D [B, C, H, W]
                    img = vae.decode(latents)
                else:
                    # The cached VAE instance is shared across invocations, so always set
                    # the tiling state explicitly rather than leaving it as-is.
                    if use_tiling:
                        vae.enable_tiling(
                            tile_sample_min_height=ANIMA_VAE_TILE_SIZE,
                            tile_sample_min_width=ANIMA_VAE_TILE_SIZE,
                            tile_sample_stride_height=ANIMA_VAE_TILE_STRIDE,
                            tile_sample_stride_width=ANIMA_VAE_TILE_STRIDE,
                        )
                    else:
                        vae.disable_tiling()

                    # Expects 5D latents [B, C, T, H, W]
                    if latents.ndim == 4:
                        latents = latents.unsqueeze(2)  # [B, C, H, W] -> [B, C, 1, H, W]

                    # Denormalize from denoiser space to raw VAE space
                    # (same as diffusers WanPipeline and ComfyUI Wan21.process_out)
                    latents_mean = torch.tensor(vae.config.latents_mean).view(1, -1, 1, 1, 1).to(latents)
                    latents_std = torch.tensor(vae.config.latents_std).view(1, -1, 1, 1, 1).to(latents)
                    latents = latents * latents_std + latents_mean
                    # Cheap (latents are small); the black-image triage below needs it to tell
                    # upstream corruption from decode-side corruption.
                    latents_finite = bool(torch.isfinite(latents).all())

                    try:
                        decoded = vae.decode(latents, return_dict=False)[0]
                    except RuntimeError as e:
                        if use_tiling or not _is_oom_error(e):
                            raise
                        # The working-memory estimate was insufficient on this system;
                        # retry once with tiling, which caps the peak allocation.
                        TorchDevice.empty_cache()
                        vae.enable_tiling(
                            tile_sample_min_height=ANIMA_VAE_TILE_SIZE,
                            tile_sample_min_width=ANIMA_VAE_TILE_SIZE,
                            tile_sample_stride_height=ANIMA_VAE_TILE_STRIDE,
                            tile_sample_stride_width=ANIMA_VAE_TILE_STRIDE,
                        )
                        decoded = vae.decode(latents, return_dict=False)[0]

                    if not bool(torch.isfinite(decoded).all()):
                        # NaN survives clamp(-1, 1) and quantizes to 0: without this, the
                        # failure renders as a silent black image. Diagnose and try to recover.
                        decoded = self._recover_nonfinite_decode(context, vae, latents, decoded, latents_finite)

                    # Output is 5D [B, C, T, H, W] — squeeze temporal dim
                    if decoded.ndim == 5:
                        decoded = decoded.squeeze(2)
                    img = decoded

            img = img.clamp(-1, 1)
            img = rearrange(img[0], "c h w -> h w c")
            img_pil = Image.fromarray((127.5 * (img + 1.0)).byte().cpu().numpy())

        TorchDevice.empty_cache()

        image_dto = context.images.save(image=img_pil)
        return ImageOutput.build(image_dto)

    def _recover_nonfinite_decode(
        self,
        context: InvocationContext,
        vae: AutoencoderKLWan,
        latents: torch.Tensor,
        decoded: torch.Tensor,
        latents_finite: bool,
    ) -> torch.Tensor:
        """Diagnose and, when possible, recover a decode that produced NaN/Inf (a black image).

        Seen intermittently on a dual-GPU ROCm rig while a long video generation runs on the
        other GPU. Logs a fingerprint that discriminates the candidate mechanisms — non-finite
        latents from upstream, corrupt cached VAE weights, or clean-inputs/clean-weights decode
        compute failure (the allocator-state-dependent kernel class) — then makes two bounded
        recovery attempts whose outcomes sharpen the diagnosis. Returns the best decode
        achieved; never raises, since a black image plus a diagnostic log beats a failed
        generation.
        """
        try:
            return self._recover_nonfinite_decode_impl(context, vae, latents, decoded, latents_finite)
        except Exception:
            # The triage itself must never convert a black image into a failed generation.
            context.logger.exception("VAE decode non-finite triage failed; returning the corrupt decode.")
            return decoded

    def _recover_nonfinite_decode_impl(
        self,
        context: InvocationContext,
        vae: AutoencoderKLWan,
        latents: torch.Tensor,
        decoded: torch.Tensor,
        latents_finite: bool,
    ) -> torch.Tensor:
        device = latents.device
        scan = scan_module_for_nonfinite_weights(vae, device.type)

        if not latents_finite:
            assessment = (
                "the latents entering the decode already contain NaN/Inf — corruption happened "
                "UPSTREAM of the VAE (denoise output or tensor transfer); retrying the decode cannot help"
            )
        elif not scan.clean:
            assessment = (
                "NaN/Inf (or unreadable tensors) found among the cached VAE WEIGHTS — if genuinely "
                "corrupt, every decode will fail until the model is reloaded (clearing the model "
                "cache should recover it)"
            )
        else:
            assessment = (
                "latents and weights are finite but the decode COMPUTED NaN/Inf — consistent with an "
                "allocator-state-dependent kernel failure on this device"
            )
        context.logger.error(
            "VAE decode produced non-finite output (this renders as a black image).\n"
            f"  non-finite fraction of decode output: {nonfinite_fraction(decoded):.4f}\n"
            f"  latents finite: {latents_finite}\n"
            f"  weights: {scan.describe()}\n"
            f"  allocator: {allocator_state_summary(device)}\n"
            f"  assessment: {assessment}"
        )

        if not latents_finite or not scan.clean:
            return decoded

        try:
            # Attempt 1: plain retry, to rule out a transient.
            retry = vae.decode(latents, return_dict=False)[0]
            if bool(torch.isfinite(retry).all()):
                context.logger.warning("VAE decode recovered on a plain retry (transient non-finite decode).")
                return retry

            # Attempt 2: force a REAL global empty_cache — bypassing the peer-aware skip — and
            # retry. This stalls BOTH workers once: the peer's in-flight step, and this thread,
            # which waits inside hipFree until that step's kernel completes (up to ~a minute on
            # a long video step). Still a better trade than a black image; if it heals the
            # decode, the allocator-state mechanism is confirmed.
            context.logger.warning(
                "VAE decode still non-finite after a plain retry; forcing a global empty_cache "
                "(a peer GPU's in-flight step may stall once) and retrying."
            )
            force_real_empty_cache()
            retry = vae.decode(latents, return_dict=False)[0]
            if bool(torch.isfinite(retry).all()):
                context.logger.warning(
                    "VAE decode recovered after a forced global empty_cache — allocator-state-dependent "
                    "decode corruption on this device is CONFIRMED."
                )
                return retry
        except RuntimeError as e:
            context.logger.error(f"VAE decode recovery attempt raised {type(e).__name__}: {e}")
            return decoded

        context.logger.error(
            "VAE decode remained non-finite after both recovery attempts; returning the corrupt "
            "decode (the image will be black)."
        )
        return retry
