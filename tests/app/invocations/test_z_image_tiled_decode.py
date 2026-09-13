"""Tiling controls, the OOM fallback, and the tile-aware working-memory estimate for Z-Image."""

from unittest.mock import MagicMock, patch

import pytest
import torch
from diffusers.models.autoencoders.autoencoder_kl import AutoencoderKL

from invokeai.app.invocations.z_image_latents_to_image import ZImageLatentsToImageInvocation
from invokeai.backend.flux.modules.autoencoder import DEFAULT_TILE_SAMPLE_MIN_SIZE, MIN_TILE_SAMPLE_SIZE
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

    def test_the_tiled_estimate_is_a_tile_bounded_decode_plus_the_assembled_image(self):
        """The magnitude of both tiled terms, at one resolution, derived independently.

        Everything else about the tiled branch is a comparison against another call of the same
        function, which tracks the shape of the estimate but not its size. Dropping the 25% tile
        margin or halving the per-pixel image cost would be a several-hundred-megabyte
        under-reservation that no other assertion here can see.
        """
        # 512px tiles, fp16, over a 1536x1536 output.
        decode_term = 512 * 512 * 2 * 2200 * 1.25
        # 4 RGB buffers at the VAE's element size, plus the 8-bit one the node hands to PIL. Four
        # is measured, not assumed: the assembled image grows the device peak by ~1.6 copies on a
        # diffusers VAE and ~0.1 on the host-merging BFL one, and the node adds its in-window
        # clamp/scale copies on top. See the constant's comment for the measurements.
        image_term = 1536 * 1536 * 3 * (4 * 2 + 1)
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=torch.zeros(1, 16, 192, 192), vae=_mock_flux_vae(), tile_size=512
        )
        assert estimate == int(decode_term + image_term)

    def test_both_tiled_terms_scale_with_the_vaes_element_size(self):
        """An fp32 VAE costs twice the bytes per pixel, in the tile and in the assembled image
        alike. Only the 8-bit buffer is fixed, which is why this is a little under 2x."""
        latents = torch.zeros(1, 16, 192, 192)
        fp16 = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(element_size_bytes=2), tile_size=512
        )
        fp32 = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(element_size_bytes=4), tile_size=512
        )
        assert 1.95 < fp32 / fp16 < 2.0

    @pytest.mark.parametrize("latent_hw", [(128, 128), (192, 192), (256, 256)])
    def test_a_tiled_estimate_stays_a_fraction_of_the_untiled_one(self, latent_hw):
        """The point of the bound: the decode itself costs one tile, whatever the resolution.

        Not a flat number -- the assembled image and the node's post-processing are full-resolution
        however small the tile is, so an O(image) term rides along. That term is small next to the
        decode the bound removes, and this pins how small across a 4x span of image area. (It holds
        because a 512px tile is well under these images; a tile near the image size is priced at
        the clamped tile plus the same image term, which can land above the single-pass estimate.)
        """
        latents = torch.zeros(1, 16, *latent_hw)
        untiled = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=_mock_flux_vae())
        tiled = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=512
        )
        assert tiled < untiled / 2

    def test_a_tile_larger_than_the_image_is_not_estimated_as_tiled(self):
        """`_tiled_decode` short-circuits once the tile covers the image, so the reservation has to.

        `tile_size` has no upper bound, and the quadratic tile term ran away from the decode that
        would actually happen: a 4096px tile on a 1024px image reserved ~23GB for a single-pass
        decode needing ~4.6GB, evicting the transformer from the cache to make room for nothing.
        """
        latents = torch.zeros(1, 16, 128, 128)  # 1024px
        untiled = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=_mock_flux_vae())
        oversized = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=4096
        )
        assert oversized == untiled

    def test_a_tile_wider_than_one_axis_is_priced_at_the_clamped_tile(self):
        """`calc_tiles_min_overlap` clamps the tile to the image on each axis independently.

        A 1024x8192 image tiled with a 4096px tile therefore decodes 1024x4096 tiles, never
        4096x4096 ones. Pricing the requested tile squared put the reservation 2.5x *above* the
        single-pass decode that tiling is there to avoid -- ~92GB against ~37GB.
        """
        latents = torch.zeros(1, 16, 128, 1024)  # 1024 x 8192 px: only the long axis exceeds the tile
        tiled = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=4096
        )
        untiled = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=_mock_flux_vae())
        assert tiled < untiled

    def test_a_tiled_estimate_still_covers_the_assembled_image(self):
        """The other half of the bound: tiling caps the decode, not the assembly.

        The assembled output is one full-resolution device tensor, and the node then runs `clamp`,
        `+ 1.0`, `* 127.5` and `.byte()` over it. At 8192x8192 in fp16 a single one of those RGB
        buffers is 402MB, so a tile-only estimate is short by more than it reserves. This is the
        second resolution the image term is checked at, so a term that did not scale with area
        would fail here even if it matched at 1536px.
        """
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=torch.zeros(1, 16, 1024, 1024), vae=_mock_flux_vae(), tile_size=512
        )
        tile_term = int(512 * 512 * 2 * 2200 * 1.25)
        one_full_resolution_buffer = 8192 * 8192 * 3 * 2
        # The assembled output plus at least one of the post-processing copies.
        assert estimate >= tile_term + 2 * one_full_resolution_buffer

    def test_the_sentinel_does_not_read_the_size_off_the_vae(self):
        """Upstream #9427 found this exact shape of bug in the Qwen estimator: reading
        `vae.tile_sample_min_size` returns whatever the *previous* invocation left on the cached
        module, not the default this node is asking for."""
        latents = torch.zeros(1, 16, 192, 192)
        vae = _mock_flux_vae()
        vae.tile_sample_min_size = 384  # as if a previous run had set it
        estimate = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=vae, tile_size=0)
        assert estimate == estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=DEFAULT_TILE_SAMPLE_MIN_SIZE
        )

    def test_the_sentinel_works_on_a_vae_without_that_attribute_at_all(self):
        # The Z-Image nodes also hand a diffusers AutoencoderKL to this estimator; the SD1/SDXL
        # sibling dereferences `vae.tile_sample_min_size` directly and would raise here.
        latents = torch.zeros(1, 16, 192, 192)
        vae = MagicMock(spec=AutoencoderKL)
        vae.parameters.side_effect = lambda: iter([torch.zeros(1, dtype=torch.float16)])
        del vae.tile_sample_min_size
        estimate = estimate_vae_working_memory_flux(operation="decode", image_tensor=latents, vae=vae, tile_size=0)
        assert estimate == estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=DEFAULT_TILE_SAMPLE_MIN_SIZE
        )

    def test_a_tile_below_the_cost_floor_is_estimated_at_the_floor(self):
        latents = torch.zeros(1, 16, 192, 192)
        estimate = estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=8
        )
        assert estimate == estimate_vae_working_memory_flux(
            operation="decode", image_tensor=latents, vae=_mock_flux_vae(), tile_size=MIN_TILE_SAMPLE_SIZE
        )


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
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)
        vae.disable_tiling.assert_not_called()

    def test_force_tiled_decode_reaches_the_tiled_path(self):
        """The config switch a small-VRAM user actually has; the node field is not the only way in."""
        vae, _, context = _build_decode_mocks(
            torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512), force_tiled_decode=True
        )
        _build_invocation().invoke(context)
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)

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
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)
        assert result.width == 512
        # The user gets a different image than they asked for, so both channels have to carry it: the
        # progress line while it happens, and a log line a bug report can still be read off afterwards.
        context.util.signal_progress.assert_any_call("VAE decode ran out of memory, retrying tiled")
        assert "not identical to an untiled decode" in context.logger.warning.call_args[0][0]

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
