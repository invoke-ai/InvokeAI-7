"""`force_tiled_decode` on the FLUX.1 latents-to-image node, and its OOM fallback.

The node exposes no tiling fields -- adding any would change the invocation schema -- so the app
config switch is the only way a user can ask it for a tiled decode. It used to be ignored here
while the Z-Image, SD and Qwen-Image decode nodes all honoured it.
"""

from unittest.mock import MagicMock, patch

import pytest
import torch

from invokeai.app.invocations.flux_vae_decode import FluxVaeDecodeInvocation
from invokeai.backend.flux.modules.autoencoder import DEFAULT_TILE_SAMPLE_MIN_SIZE
from invokeai.backend.flux.modules.autoencoder import AutoEncoder as FluxAutoEncoder


def _build_decode_mocks(latents: torch.Tensor, decoded: torch.Tensor, force_tiled_decode: bool = False):
    """Wire FluxVaeDecodeInvocation.invoke to run end-to-end on CPU against a mocked FLUX VAE."""
    vae = MagicMock(spec=FluxAutoEncoder)
    # A fresh iterator per call: the decode path reads `parameters()` after the estimator already
    # has, and a single stored iterator would be exhausted by then.
    vae.parameters.side_effect = lambda: iter([torch.zeros(1, dtype=torch.float16)])
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


def _build_invocation() -> FluxVaeDecodeInvocation:
    return FluxVaeDecodeInvocation.model_construct(
        latents=MagicMock(latents_name="test_latents"),
        vae=MagicMock(vae=MagicMock()),
    )


class TestForceTiledDecode:
    def test_the_default_decodes_untiled(self):
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512))
        _build_invocation().invoke(context)
        vae.disable_tiling.assert_called_once()
        vae.enable_tiling.assert_not_called()

    def test_the_config_flag_reaches_the_tiled_path(self):
        vae, _, context = _build_decode_mocks(
            torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512), force_tiled_decode=True
        )
        _build_invocation().invoke(context)
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)
        vae.disable_tiling.assert_not_called()

    @pytest.mark.parametrize("force_tiled_decode,expected_tile_size", [(False, None), (True, 0)])
    def test_the_reservation_matches_the_decode_that_will_run(self, force_tiled_decode, expected_tile_size):
        """A tiled decode reserved for a single pass is the OOM the retry exists to avoid, and an
        untiled decode reserved for a tile evicts models it did not need to."""
        path = "invokeai.app.invocations.flux_vae_decode.estimate_vae_working_memory_flux"
        _, _, context = _build_decode_mocks(
            torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512), force_tiled_decode=force_tiled_decode
        )
        with patch(path, return_value=1024) as estimate:
            _build_invocation().invoke(context)
        assert estimate.call_args.kwargs["tile_size"] == expected_tile_size


class TestOomFallback:
    def test_an_untiled_oom_retries_once_tiled_and_says_so(self):
        decoded = torch.zeros(1, 3, 512, 512)
        vae, _, context = _build_decode_mocks(torch.zeros(1, 16, 64, 64), decoded)
        vae.decode.side_effect = [torch.cuda.OutOfMemoryError("CUDA out of memory"), decoded]

        result = _build_invocation().invoke(context)

        assert vae.decode.call_count == 2
        vae.enable_tiling.assert_called_once_with(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)
        # The retry takes noticeably longer than the failed attempt; the user is told why.
        context.util.signal_progress.assert_any_call("VAE decode ran out of memory, retrying tiled")
        assert result.width == 512

    def test_an_oom_while_already_tiled_reraises(self):
        vae, _, context = _build_decode_mocks(
            torch.zeros(1, 16, 64, 64), torch.zeros(1, 3, 512, 512), force_tiled_decode=True
        )
        vae.decode.side_effect = torch.cuda.OutOfMemoryError("CUDA out of memory")

        with pytest.raises(torch.cuda.OutOfMemoryError):
            _build_invocation().invoke(context)

        assert vae.decode.call_count == 1
        vae.enable_tiling.assert_called_once()
