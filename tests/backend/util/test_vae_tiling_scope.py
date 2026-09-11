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
    """`AutoencoderKL.enable_tiling()` takes no arguments, so the size has to be set afterwards.

    Leaving it out is not a smaller tile than asked for -- it is the VAE's own `sample_size`, which
    for Z-Image is 1024, so a 1024px decode does not tile at all while the caller has already
    reserved working memory on the assumption that it did. Asserting `use_tiling is True` alone does
    not see that: it held while every requested size was being discarded.
    """

    @staticmethod
    def _vae(block_out_channels=(32, 64, 128, 128), sample_size=1024, norm_num_groups=32) -> AutoencoderKL:
        return AutoencoderKL(
            in_channels=3,
            out_channels=3,
            latent_channels=4,
            block_out_channels=block_out_channels,
            down_block_types=("DownEncoderBlock2D",) * len(block_out_channels),
            up_block_types=("UpDecoderBlock2D",) * len(block_out_channels),
            layers_per_block=1,
            norm_num_groups=norm_num_groups,
            sample_size=sample_size,
        )

    @pytest.mark.parametrize(
        ("requested", "expected_sample"),
        [
            (384, 384),
            (256, 256),
            (0, DEFAULT_TILE_SAMPLE_MIN_SIZE),
            # Not a multiple of 32, so the latent tile (25) is snapped down to 24: this VAE's
            # tiled decode cannot assemble a correct image from a latent tile the overlap factor
            # does not divide. See `test_every_tile_size_the_field_accepts_assembles_the_full_image`.
            (200, 192),
        ],
    )
    def test_the_requested_size_reaches_the_vae(self, requested, expected_sample):
        vae = self._vae()
        # Four blocks, so the latent grid is 8x smaller than the pixel grid.
        downsample = 2 ** (len(vae.config.block_out_channels) - 1)

        with scoped_vae_tiling(vae, requested):
            assert vae.use_tiling is True
            assert vae.tile_sample_min_size == expected_sample
            assert vae.tile_latent_min_size == expected_sample // downsample

    def test_the_vaes_own_geometry_is_restored(self):
        vae = self._vae()
        before = (vae.use_tiling, vae.tile_sample_min_size, vae.tile_latent_min_size)

        with scoped_vae_tiling(vae, 256):
            pass

        assert (vae.use_tiling, vae.tile_sample_min_size, vae.tile_latent_min_size) == before

    def test_every_tile_size_the_field_accepts_assembles_the_full_image(self):
        """The sweep the FLUX sibling above runs, pointed at the class that can actually fail it.

        `tiled_decode` steps the latent loop by one quantity and crops each decoded tile by another,
        and the two agree only for some tile sizes. Setting `tile_sample_min_size` and
        `tile_latent_min_size` independently got that wrong for every `multiple_of=8` field value
        that is not a multiple of 32: measured over this range, 36 of the 84 values assembled an
        image between 514 and 542 pixels wide instead of 512.
        """
        # Four blocks for the real 8x latent grid; the widths only have to be legal, so they are
        # cut to what keeps 84 decodes cheap on CPU.
        vae = self._vae(block_out_channels=(4, 8, 16, 16), norm_num_groups=4).eval()
        latent = torch.zeros(1, 4, 64, 64)

        wrong: list[tuple[int, tuple[int, ...]]] = []
        for tile_size in range(128, 800, 8):
            with torch.no_grad(), scoped_vae_tiling(vae, tile_size):
                decoded = vae.decode(latent, return_dict=False)[0]
            if decoded.shape != (1, 3, 512, 512):
                wrong.append((tile_size, tuple(decoded.shape)))

        assert not wrong

    @pytest.mark.parametrize("overlap_factor", [0.125, 0.2, 0.3, 1 / 3, 0.35])
    def test_a_non_stock_overlap_factor_is_honoured_rather_than_assumed(self, overlap_factor):
        """Which tiles a factor admits depends on how it rounds in binary, not on its value.

        0.25 is the only factor diffusers ships, and at an 8x downsample it admits every multiple
        of 4 -- exactly what treating the factor as the fraction it looks like would also pick. The
        other factors are where that shortcut breaks: 0.3 admits only multiples of 10, and 0.35 only
        multiples of 20, neither of which is the denominator of any nearby simple fraction. Reading
        the answer out of diffusers' own two expressions is what gets those right; approximating
        0.35 as 5/14 picks a wrong tile for every size below.
        """
        vae = self._vae(block_out_channels=(4, 8, 16, 16), norm_num_groups=4).eval()
        vae.tile_overlap_factor = overlap_factor
        latent = torch.zeros(1, 4, 64, 64)

        for tile_size in (168, 200, 264, 328, 392):
            with torch.no_grad(), scoped_vae_tiling(vae, tile_size):
                assert vae.decode(latent, return_dict=False)[0].shape == (1, 3, 512, 512)

    def test_a_decode_at_the_vaes_default_resolution_actually_tiles(self):
        """The case the missing size costs: a 1024px decode against a VAE whose default tile is also
        1024 stays in the single-pass path, which is the one the reservation was sized against."""
        vae = self._vae().eval()
        calls = []
        real = vae.tiled_decode
        vae.tiled_decode = lambda z, return_dict=True: (calls.append(1), real(z, return_dict=return_dict))[1]

        latent = torch.zeros(1, 4, 1024 // 8, 1024 // 8)
        with torch.no_grad(), scoped_vae_tiling(vae, 0):
            vae.decode(latent)

        assert calls, "the decode did not tile, so the tile size never reached the VAE"
