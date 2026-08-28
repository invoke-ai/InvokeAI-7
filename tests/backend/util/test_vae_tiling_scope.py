"""Scoped tiling state, and the tile-size sentinel.

Both are here because of what the Qwen-Image tiling PR (upstream #9427) found the hard way: an
`enable_tiling()` call writes through to the model cache's own module, `disable_tiling()` restores
the flag but not the geometry, and an estimator that reads the size back off the module gets
whatever the previous invocation left rather than the default it asked for.
"""

import pytest
import torch
from diffusers.models.autoencoders.autoencoder_kl import AutoencoderKL

from invokeai.backend.flux.modules.autoencoder import (
    DEFAULT_TILE_OVERLAP,
    DEFAULT_TILE_SAMPLE_MIN_SIZE,
    MIN_TILE_SAMPLE_SIZE,
    AutoEncoder,
    AutoEncoderParams,
    resolve_tile_size,
)
from invokeai.backend.util.vae_tiling_scope import scoped_vae_tiling


def _build_autoencoder() -> AutoEncoder:
    params = AutoEncoderParams(
        resolution=256,
        in_channels=3,
        ch=32,
        out_ch=3,
        ch_mult=[1, 2, 4, 4],
        num_res_blocks=1,
        z_channels=16,
        scale_factor=0.3611,
        shift_factor=0.1159,
    )
    torch.manual_seed(0)
    return AutoEncoder(params).eval()


class TestResolveTileSize:
    @pytest.mark.parametrize("sentinel", [0, -8, -1024])
    def test_the_sentinel_resolves_to_the_module_default(self, sentinel):
        # The workflow UI cannot send None, so 0 is "use the default". A negative value is not worth
        # failing a generation over -- upstream #9427 confirmed the same for the Qwen nodes.
        assert resolve_tile_size(sentinel) == DEFAULT_TILE_SAMPLE_MIN_SIZE

    @pytest.mark.parametrize("small", [8, 64, MIN_TILE_SAMPLE_SIZE - 8])
    def test_values_below_the_cost_floor_are_clamped(self, small):
        # A cost floor, not a correctness one: the tile count grows with the inverse square of the
        # tile size, and small tiles are also measurably less accurate.
        assert resolve_tile_size(small) == MIN_TILE_SAMPLE_SIZE

    @pytest.mark.parametrize("size", [128, 256, 384, 512, 1024])
    def test_usable_values_pass_through(self, size):
        assert resolve_tile_size(size) == size


class TestEveryFieldValueProducesTheRightShape:
    """The sweep upstream #9427 used to catch silent truncation.

    That bug cannot occur here -- the destination is preallocated at the exact output size and tiles
    are merged into it, rather than a loop stepping by one quantity and slicing by another -- but the
    guarantee is worth asserting rather than reasoning about, across the shapes most likely to leave
    an awkward remainder.
    """

    @pytest.mark.parametrize("latent_hw", [(2, 2), (10, 10), (50, 50), (34, 18), (128, 72), (18, 34), (150, 10)])
    @pytest.mark.parametrize("tile_size", [0, 8, 128, 256, 384, 512, 1024])
    def test_output_shape_is_exact(self, latent_hw, tile_size):
        ae = _build_autoencoder()
        h, w = latent_hw
        z = torch.randn(1, 16, h, w)
        with torch.no_grad(), scoped_vae_tiling(ae, tile_size):
            out = ae.decode(z)
        assert out.shape == (1, 3, h * 8, w * 8)


class TestStateIsRestored:
    def test_the_normal_path_restores_everything(self):
        ae = _build_autoencoder()
        before = (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap)
        with scoped_vae_tiling(ae, 256):
            assert ae.use_tiling is True
            assert ae.tile_sample_min_size == 256
        assert (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap) == before

    def test_the_untiled_path_restores_everything(self):
        # Entering with tiling already on: the block must decode untiled and hand the state back.
        ae = _build_autoencoder()
        ae.enable_tiling(tile_sample_min_size=256)
        before = (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap)
        with scoped_vae_tiling(ae, None):
            assert ae.use_tiling is False
        assert (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap) == before

    def test_an_exception_still_restores(self):
        # The OOM retry path raises through this context manager, so `finally` is load-bearing.
        ae = _build_autoencoder()
        before = (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap)
        with pytest.raises(RuntimeError, match="boom"):
            with scoped_vae_tiling(ae, 256):
                raise RuntimeError("boom")
        assert (ae.use_tiling, ae.tile_sample_min_size, ae.tile_overlap) == before

    def test_geometry_does_not_leak_between_two_scopes(self):
        """The bug this exists for: `disable_tiling()` clears the flag but keeps the geometry, so a
        size set once would otherwise silently become the default for everyone afterwards."""
        ae = _build_autoencoder()
        with scoped_vae_tiling(ae, 256):
            pass
        assert ae.tile_sample_min_size == DEFAULT_TILE_SAMPLE_MIN_SIZE
        assert ae.tile_overlap == DEFAULT_TILE_OVERLAP
        with scoped_vae_tiling(ae, 0):
            assert ae.tile_sample_min_size == DEFAULT_TILE_SAMPLE_MIN_SIZE

    def test_a_tiled_decode_does_not_leave_the_shared_vae_tiled(self):
        """Nine nodes reach this class and most never touch the tiling flag -- FLUX.1 encode, PiD,
        and Anima's FLUX branch among them. A leaked flag would silently tile their work."""
        ae = _build_autoencoder()
        z = torch.randn(1, 16, 96, 96)
        with torch.no_grad():
            with scoped_vae_tiling(ae, 0):
                ae.decode(z)
            assert ae.use_tiling is False
            # What an unguarded consumer would get next, decoded with no tiling call of its own.
            after = ae.decode(z)
            ae.disable_tiling()
            expected = ae.decode(z)
        assert torch.equal(after, expected)


class TestDiffusersVaesAreHandledToo:
    def test_a_class_without_a_settable_size_is_enabled_without_arguments(self):
        # diffusers' AutoencoderKL.enable_tiling() takes no parameters; passing one would raise.
        vae = AutoencoderKL(
            in_channels=3,
            out_channels=3,
            latent_channels=4,
            block_out_channels=(32,),
            down_block_types=("DownEncoderBlock2D",),
            up_block_types=("UpDecoderBlock2D",),
            layers_per_block=1,
            norm_num_groups=32,
        )
        with scoped_vae_tiling(vae, 384):
            assert vae.use_tiling is True
        assert vae.use_tiling is False
