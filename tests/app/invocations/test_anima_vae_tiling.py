"""Tiling state on the Anima latents-to-image node's shared, cached Wan VAE.

`enable_tiling` writes the tile geometry onto the module and `disable_tiling` restores only the
flag, never the sizes -- and the module is the model cache's own instance, shared with the
Qwen-Image nodes whenever a native-layout `qwen_image_vae` single file is loaded. A real
`AutoencoderKLWan` is used here rather than a mock precisely because that write-through is the
behaviour under test; a mocked `enable_tiling` would leave nothing behind to leak.
"""

from unittest.mock import MagicMock, patch

import torch
from diffusers.models.autoencoders import AutoencoderKLWan

from invokeai.app.invocations.anima_latents_to_image import (
    ANIMA_VAE_TILE_SIZE,
    ANIMA_VAE_TILE_STRIDE,
    AnimaLatentsToImageInvocation,
)
from invokeai.backend.util.devices import TorchDevice


def _build_tiny_vae() -> AutoencoderKLWan:
    """The smallest Wan VAE that still decodes: 2 latent channels, 2x spatial, 3 output channels."""
    return AutoencoderKLWan(
        base_dim=2,
        z_dim=2,
        dim_mult=[1, 1],
        num_res_blocks=1,
        attn_scales=[],
        temperal_downsample=[True],
        latents_mean=[0.0, 0.0],
        latents_std=[1.0, 1.0],
        scale_factor_temporal=2,
        scale_factor_spatial=2,
    ).eval()


def _tiling_state(vae: AutoencoderKLWan) -> tuple:
    return (
        vae.use_tiling,
        vae.tile_sample_min_height,
        vae.tile_sample_min_width,
        vae.tile_sample_stride_height,
        vae.tile_sample_stride_width,
    )


def _build_context(vae: AutoencoderKLWan, latents: torch.Tensor):
    vae_info = MagicMock()
    vae_info.model = vae
    # The invocation places latents on the VAE's intended compute device (see #9373), so this must
    # be a real torch.device rather than a MagicMock for `latents.to(device=...)` to work.
    vae_info.compute_device = torch.device("cpu")
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=(None, vae))
    cm.__exit__ = MagicMock(return_value=None)
    vae_info.model_on_device.return_value = cm

    context = MagicMock()
    context.models.load.return_value = vae_info
    context.tensors.load.return_value = latents
    image_dto = MagicMock()
    image_dto.image_name = "test.png"
    image_dto.width = latents.shape[-1] * 2
    image_dto.height = latents.shape[-2] * 2
    context.images.save.return_value = image_dto
    return context


def _build_invocation() -> AnimaLatentsToImageInvocation:
    return AnimaLatentsToImageInvocation.model_construct(
        latents=MagicMock(latents_name="test_latents"),
        vae=MagicMock(vae=MagicMock()),
    )


def test_the_oom_retry_does_not_leave_the_shared_vae_tiled():
    """The leak the scoped helper exists for, on the path that used to set the geometry twice.

    Without the scope the retry leaves `use_tiling` set and the 512/384 geometry written onto the
    cached module, so the next node to decode through it silently tiles at a geometry it never
    asked for -- including the Qwen-Image nodes, whose stock tile is 256/192.
    """
    vae = _build_tiny_vae()
    before = _tiling_state(vae)
    context = _build_context(vae, torch.zeros(1, 2, 8, 8))

    real_decode = vae.decode
    attempts: list[bool] = []

    def flaky_decode(*args, **kwargs):
        attempts.append(vae.use_tiling)
        if len(attempts) == 1:
            raise torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate 5.9 GiB")
        return real_decode(*args, **kwargs)

    vae.decode = flaky_decode
    with patch.object(TorchDevice, "choose_torch_device", return_value=torch.device("cpu")):
        _build_invocation().invoke(context)

    # The first attempt was untiled and the retry was tiled -- otherwise nothing was restored.
    assert attempts == [False, True]
    assert vae.use_tiling is False
    assert _tiling_state(vae) == before


def test_a_tiled_decode_applies_the_calibrated_geometry_and_restores_it():
    """The tiling decision is made against a working-memory estimate calibrated at 512/384, so the
    decode has to run at that geometry -- and hand the cached module back unchanged."""
    vae = _build_tiny_vae()
    before = _tiling_state(vae)
    context = _build_context(vae, torch.zeros(1, 2, 8, 8))

    real_decode = vae.decode
    during: list[tuple] = []

    def spy_decode(*args, **kwargs):
        during.append(_tiling_state(vae))
        return real_decode(*args, **kwargs)

    vae.decode = spy_decode
    with (
        patch.object(TorchDevice, "choose_torch_device", return_value=torch.device("cpu")),
        patch.object(AnimaLatentsToImageInvocation, "_use_tiled_decode", return_value=True),
    ):
        _build_invocation().invoke(context)

    assert during == [(True, ANIMA_VAE_TILE_SIZE, ANIMA_VAE_TILE_SIZE, ANIMA_VAE_TILE_STRIDE, ANIMA_VAE_TILE_STRIDE)]
    assert _tiling_state(vae) == before
