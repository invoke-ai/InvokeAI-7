"""Tiling controls, the OOM fallback, and the tile-aware working-memory estimate for Z-Image."""

from unittest.mock import MagicMock, patch

import pytest
import torch
from diffusers.models.autoencoders.autoencoder_kl import AutoencoderKL

from invokeai.app.invocations.z_image_latents_to_image import ZImageLatentsToImageInvocation
from invokeai.backend.flux.modules.autoencoder import DEFAULT_TILE_SAMPLE_MIN_SIZE
from invokeai.backend.flux.modules.autoencoder import AutoEncoder as FluxAutoEncoder
from invokeai.backend.util.vae_working_memory import estimate_vae_working_memory_flux


def _mock_flux_vae(element_size_bytes: int = 2) -> MagicMock:
    vae = MagicMock(spec=FluxAutoEncoder)
    dtype = torch.float16 if element_size_bytes == 2 else torch.float32
    # A fresh iterator per call: the decode path reads `parameters()` after the estimator already
    # has, and a single stored iterator would be exhausted by then.
    vae.parameters.side_effect = lambda: iter([torch.zeros(1, dtype=dtype)])
    return vae


class TestFluxWorkingMemoryEstimate:
    def test_the_default_reproduces_the_untiled_estimate(self):
        """Regression guard for the six call sites that pass no tile_size at all."""
        latents = torch.zeros(1, 16, 128, 128)
        # 1024x1024 output px * 2 bytes * 2200
        expected = 1024 * 1024 * 2 * 2200
        actual = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=_mock_flux_vae())
        assert actual == expected

    @pytest.mark.parametrize("latent_hw", [(128, 128), (192, 192), (256, 256)])
    def test_a_tiled_estimate_does_not_grow_with_the_image(self, latent_hw):
        """The point of the bound: peak memory is one tile, whatever the resolution."""
        h, w = latent_hw
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=torch.zeros(1, 16, h, w), vae=_mock_flux_vae(), tile_size=512
        )
        assert estimate == int(512 * 512 * 2 * 2200 * 1.25)

    def test_a_tiled_estimate_is_smaller_than_the_untiled_one_where_it_matters(self):
        latents = torch.zeros(1, 16, 192, 192)  # 1536px, the resolution that OOMs on 16GB
        untiled = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=_mock_flux_vae())
        tiled = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=512
        )
        assert tiled < untiled

    def test_tile_size_zero_resolves_against_the_vae(self):
        vae = _mock_flux_vae()
        vae.tile_sample_min_size = 384
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=torch.zeros(1, 16, 192, 192), vae=vae, tile_size=0
        )
        assert estimate == int(384 * 384 * 2 * 2200 * 1.25)

    def test_tile_size_zero_on_a_vae_without_a_default_does_not_raise(self):
        # The Z-Image nodes also hand a diffusers AutoencoderKL to this estimator; the SD1/SDXL
        # sibling dereferences `vae.tile_sample_min_size` directly and would raise here.
        vae = MagicMock(spec=AutoencoderKL)
        vae.parameters.return_value = iter([torch.zeros(1, dtype=torch.float16)])
        del vae.tile_sample_min_size
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=torch.zeros(1, 16, 192, 192), vae=vae, tile_size=0
        )
        assert estimate == int(DEFAULT_TILE_SAMPLE_MIN_SIZE**2 * 2 * 2200 * 1.25)


def _build_decode_mocks(latents: torch.Tensor, decoded: torch.Tensor, force_tiled_decode: bool = False):
    """Wire ZImageLatentsToImageInvocation.invoke to run end-to-end on CPU against a mocked FLUX VAE."""
    vae = _mock_flux_vae()
    vae.decode.return_value = decoded

    vae_info = MagicMock()
    vae_info.model = vae
    vae_info.compute_device = torch.device("cpu")
    cm = MagicMock()
    cm.__enter__ = MagicMock(return_value=(None, vae))
    cm.__exit__ = MagicMock(return_value=None)
    vae_info.model_on_device.return_value = cm

    context = MagicMock()
    context.models.load.return_value = vae_info
    context.tensors.load.return_value = latents
    # A bare MagicMock config would read as truthy and silently tile everything.
    context.config.get.return_value.force_tiled_decode = force_tiled_decode
    image_dto = MagicMock()
    image_dto.image_name = "test.png"
    image_dto.width = decoded.shape[-1]
    image_dto.height = decoded.shape[-2]
    context.images.save.return_value = image_dto
    return vae, vae_info, context


def _build_invocation(tiled: bool = False, tile_size: int = 0) -> ZImageLatentsToImageInvocation:
    return ZImageLatentsToImageInvocation.model_construct(
        latents=MagicMock(latents_name="test_latents"),
        vae=MagicMock(vae=MagicMock()),
        tiled=tiled,
        tile_size=tile_size,
    )


class TestTilingIsWired:
    def test_the_default_decodes_untiled(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        _build_invocation().invoke(context)
        vae.disable_tiling.assert_called_once()
        vae.enable_tiling.assert_not_called()

    def test_the_node_field_reaches_the_tiled_path(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        _build_invocation(tiled=True).invoke(context)
        vae.enable_tiling.assert_called_once_with()
        vae.disable_tiling.assert_not_called()

    def test_force_tiled_decode_reaches_the_tiled_path(self):
        """The config switch a small-VRAM user actually has; the node field is not the only way in."""
        vae, _, context = _build_decode_mocks(
            torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512), force_tiled_decode=True
        )
        _build_invocation().invoke(context)
        vae.enable_tiling.assert_called_once_with()

    def test_a_requested_tile_size_is_passed_through(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        _build_invocation(tiled=True, tile_size=384).invoke(context)
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=384)

    @pytest.mark.parametrize("tiled,expected_tile_size", [(False, None), (True, 0)])
    def test_the_estimate_is_tile_bounded_only_when_tiling(self, tiled, expected_tile_size):
        path = "invokeai.app.invocations.z_image_latents_to_image.estimate_vae_working_memory_flux"
        _, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        with patch(path, return_value=1024) as estimate:
            _build_invocation(tiled=tiled).invoke(context)
        assert estimate.call_args.kwargs["tile_size"] == expected_tile_size


class TestOomFallback:
    @pytest.mark.parametrize(
        "oom_error",
        [
            torch.cuda.OutOfMemoryError("CUDA out of memory. Tried to allocate 5.9 GiB"),
            RuntimeError("CUDA error: out of memory"),
            RuntimeError("cuDNN error: CUDNN_STATUS_ALLOC_FAILED"),
            RuntimeError("Native API failed. Native API returns: UR_RESULT_ERROR_OUT_OF_DEVICE_MEMORY"),
        ],
    )
    def test_an_untiled_oom_retries_once_tiled(self, oom_error):
        decoded = torch.zeros(1, 3, 512, 512)
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), decoded)
        vae.decode.side_effect = [oom_error, decoded]

        result = _build_invocation().invoke(context)

        assert vae.decode.call_count == 2
        vae.enable_tiling.assert_called_once_with()
        assert result.width == 512

    def test_a_non_oom_error_propagates_without_a_retry(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        vae.decode.side_effect = RuntimeError("Input type (float) and weight type (half) should be the same")

        with pytest.raises(RuntimeError, match="weight type"):
            _build_invocation().invoke(context)

        assert vae.decode.call_count == 1
        vae.enable_tiling.assert_not_called()

    def test_an_oom_while_already_tiled_reraises(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        vae.decode.side_effect = torch.cuda.OutOfMemoryError("CUDA out of memory")

        with pytest.raises(torch.cuda.OutOfMemoryError):
            _build_invocation(tiled=True).invoke(context)

        assert vae.decode.call_count == 1
        vae.enable_tiling.assert_called_once()
