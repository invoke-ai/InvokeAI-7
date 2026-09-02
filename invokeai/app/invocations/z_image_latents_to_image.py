from contextlib import nullcontext
from typing import Union

import torch
from diffusers.models.autoencoders.autoencoder_kl import AutoencoderKL
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
from invokeai.backend.stable_diffusion.extensions.seamless import SeamlessExt
from invokeai.backend.util.devices import TorchDevice
from invokeai.backend.util.oom import is_oom_error
from invokeai.backend.util.vae_tiling_scope import scoped_vae_tiling
from invokeai.backend.util.vae_working_memory import estimate_vae_working_memory_flux

# Z-Image can use either the Diffusers AutoencoderKL or the FLUX AutoEncoder
ZImageVAE = Union[AutoencoderKL, FluxAutoEncoder]


@invocation(
    "z_image_l2i",
    title="Latents to Image - Z-Image",
    tags=["latents", "image", "vae", "l2i", "z-image"],
    category="latents",
    version="1.2.0",
    classification=Classification.Prototype,
)
class ZImageLatentsToImageInvocation(BaseInvocation, WithMetadata, WithBoard):
    """Generates an image from latents using Z-Image VAE (supports both Diffusers and FLUX VAE)."""

    latents: LatentsField = InputField(description=FieldDescriptions.latents, input=Input.Connection)
    vae: VAEField = InputField(description=FieldDescriptions.vae, input=Input.Connection)
    tiled: bool = InputField(default=False, description=FieldDescriptions.tiled)
    # NOTE: tile_size = 0 is a special value. We use this rather than `int | None`, because the workflow UI does not
    # offer a way to directly set None values. The size applies to InvokeAI's FLUX AutoEncoder; a diffusers
    # AutoencoderKL tiles with its own geometry, which it does not expose as a single settable size.
    tile_size: int = InputField(default=0, multiple_of=8, description=FieldDescriptions.vae_tile_size)

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> ImageOutput:
        latents = context.tensors.load(self.latents.latents_name)

        vae_info = context.models.load(self.vae.vae)
        if not isinstance(vae_info.model, (AutoencoderKL, FluxAutoEncoder)):
            raise TypeError(
                f"Expected AutoencoderKL or FluxAutoEncoder for Z-Image VAE, got {type(vae_info.model).__name__}. "
                "Ensure you are using a compatible VAE model."
            )

        is_flux_vae = isinstance(vae_info.model, FluxAutoEncoder)
        use_tiling = self.tiled or context.config.get().force_tiled_decode

        # Estimate working memory needed for VAE decode
        estimated_working_memory = estimate_vae_working_memory_flux(
            operation="decode",
            image_tensor=latents,
            vae=vae_info.model,
            tile_size=self.tile_size if use_tiling else None,
        )

        # FLUX VAE doesn't support seamless, so only apply for AutoencoderKL
        seamless_context = (
            nullcontext() if is_flux_vae else SeamlessExt.static_patch_model(vae_info.model, self.vae.seamless_axes)
        )

        with seamless_context, vae_info.model_on_device(working_mem_bytes=estimated_working_memory) as (_, vae):
            context.util.signal_progress("Running VAE")
            if not isinstance(vae, (AutoencoderKL, FluxAutoEncoder)):
                raise TypeError(
                    f"Expected AutoencoderKL or FluxAutoEncoder, got {type(vae).__name__}. "
                    "VAE model type changed unexpectedly after loading."
                )

            vae_dtype = next(iter(vae.parameters())).dtype
            # Use the VAE's intended compute device (CUDA/MPS, or CPU if configured cpu_only). Do NOT infer it from
            # current param residency: partial loading may have temporarily offloaded all weights to RAM, which would
            # wrongly place the latents (and thus the whole decode) on the CPU (see #9373).
            latents = latents.to(device=vae_info.compute_device, dtype=vae_dtype)

            # Clear memory as VAE decode can request a lot
            TorchDevice.empty_cache()

            if not isinstance(vae, FluxAutoEncoder):
                # AutoencoderKL - Apply scaling_factor and shift_factor from VAE config
                # Z-Image uses: latents = latents / scaling_factor + shift_factor
                # (the FLUX VAE handles scaling internally)
                scaling_factor = vae.config.scaling_factor
                shift_factor = getattr(vae.config, "shift_factor", None)

                latents = latents / scaling_factor
                if shift_factor is not None:
                    latents = latents + shift_factor

            def decode() -> torch.Tensor:
                if isinstance(vae, FluxAutoEncoder):
                    return vae.decode(latents)
                return vae.decode(latents, return_dict=False)[0]

            # The VAE belongs to the model cache and is shared with every other node that reaches
            # this class -- FLUX.1 decode and encode, Anima, PiD. Tiling is a property of this one
            # decode, not of the model, so the state is scoped and restored rather than left behind.
            with torch.inference_mode():
                try:
                    with scoped_vae_tiling(vae, self.tile_size if use_tiling else None):
                        img = decode()
                except RuntimeError as e:
                    if use_tiling or not is_oom_error(e):
                        raise
                    # The working-memory estimate was insufficient on this system. Retry once with
                    # tiling, which caps the peak allocation regardless of resolution.
                    context.util.signal_progress("VAE decode ran out of memory, retrying tiled")
                    TorchDevice.empty_cache()
                    with scoped_vae_tiling(vae, self.tile_size):
                        img = decode()

            img = img.clamp(-1, 1)
            img = rearrange(img[0], "c h w -> h w c")
            img_pil = Image.fromarray((127.5 * (img + 1.0)).byte().cpu().numpy())

        TorchDevice.empty_cache()

        image_dto = context.images.save(image=img_pil)

        return ImageOutput.build(image_dto)
