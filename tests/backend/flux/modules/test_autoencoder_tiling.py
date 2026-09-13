"""Tiled decode for InvokeAI's FLUX.1 autoencoder.

The reference numbers for tiled-vs-untiled agreement come from measurement, not taste: diffusers'
own tiling of this VAE gives max 0.082 / mean 0.0022 per pixel at 1536px on a +/-1 image. A tiled
decode of this architecture can never be exact, because the decoder's GroupNorms normalise over the
whole spatial extent and its mid-block attention is global -- both see a different input when the
image arrives in tiles. `test_the_full_decoder_lands_in_the_measured_accuracy_band` pins that gap
from both sides on the shipping decoder. What *is* exact is the tile geometry, and
`test_geometry_is_exact_without_the_global_operators` pins it by removing those two operators and
demanding equality.
"""

import numpy as np
import pytest
import torch
from torch import nn

from invokeai.backend.flux.modules.autoencoder import (
    DEFAULT_TILE_OVERLAP,
    DEFAULT_TILE_SAMPLE_MIN_SIZE,
    AutoEncoder,
    AutoEncoderParams,
)


def _build_autoencoder() -> AutoEncoder:
    """A structurally faithful but tiny FLUX.1 autoencoder: same block layout and the same
    8x spatial compression, with the channel counts cut down so the test runs on CPU."""
    params = AutoEncoderParams(
        resolution=256,
        in_channels=3,
        ch=32,  # GroupNorm(32) means this cannot go lower
        out_ch=3,
        ch_mult=[1, 2, 4, 4],
        num_res_blocks=1,
        z_channels=16,
        scale_factor=0.3611,
        shift_factor=0.1159,
    )
    torch.manual_seed(0)
    return AutoEncoder(params).eval()


def _make_purely_convolutional(ae: AutoEncoder) -> None:
    """Strip the two operators with an unbounded receptive field from the decoder.

    Both make a tiled decode differ from an untiled one by construction, everywhere in the image
    rather than only near the seams, which is why they have to go before the geometry can be
    asserted at all.
    """
    ae.decoder.mid.attn_1 = nn.Identity()
    for name, module in list(ae.decoder.named_modules()):
        if not isinstance(module, nn.GroupNorm):
            continue
        parent: nn.Module = ae.decoder
        *path, attr = name.split(".")
        for step in path:
            parent = parent[int(step)] if step.isdigit() else getattr(parent, step)
        setattr(parent, attr, nn.Identity())


class TestTilingState:
    def test_tiling_is_off_by_default(self):
        ae = _build_autoencoder()
        assert ae.use_tiling is False
        assert ae.tile_sample_min_size == DEFAULT_TILE_SAMPLE_MIN_SIZE
        assert ae.tile_overlap == DEFAULT_TILE_OVERLAP

    def test_spatial_compression_follows_ch_mult(self):
        assert _build_autoencoder().spatial_compression == 8

    def test_disable_tiling_restores_the_untiled_result(self):
        ae = _build_autoencoder()
        z = torch.randn(1, 16, 96, 96)
        with torch.no_grad():
            before = ae.decode(z)
            ae.enable_tiling()
            ae.decode(z)
            ae.disable_tiling()
            after = ae.decode(z)
        # The VAE instance is cached and shared across invocations, so a tiled run must not leave
        # the next one tiled.
        assert torch.equal(before, after)

    @pytest.mark.parametrize(
        "kwargs,message",
        [
            ({"tile_sample_min_size": 500}, "divisible by 8"),
            ({"tile_overlap": 100}, "divisible by 8"),
            ({"tile_sample_min_size": 128, "tile_overlap": 128}, "must be smaller than"),
            ({"tile_overlap": 0}, "greater than 0"),
            # The automatic overlap for an 8px tile is min(128, 4) rounded down to a multiple of
            # 8, i.e. 0. `merge_tiles_with_linear_blending` would take that as a blend band of
            # zero pixels and butt the tiles together with a hard seam instead of blending.
            ({"tile_sample_min_size": 8}, "greater than 0"),
        ],
    )
    def test_geometry_that_cannot_be_sliced_is_rejected(self, kwargs, message):
        # A tile edge that is not a multiple of the compression factor has no exact latent slice,
        # and an overlap at least as large as the tile -- or no overlap at all -- makes the layout
        # degenerate.
        with pytest.raises(ValueError, match=message):
            _build_autoencoder().enable_tiling(**kwargs)


class TestTiledDecode:
    def test_the_full_decoder_lands_in_the_measured_accuracy_band(self):
        """The counterweight to the test below: exactness is a property of the *geometry* only.

        With the GroupNorms and the mid-block attention left in place -- i.e. the decoder that
        actually ships -- a tiled decode differs from a single-pass one everywhere, because both
        operators see the whole spatial extent and a tile is not the whole image. Measured on this
        fixture at 768px: 0.113 at the shipped 512/128 geometry, against an output range of about
        +/-2.7. The floor rules out the `enable_tiling` docstring's since-corrected claim of float32
        epsilon; the ceiling has ~2.7x headroom over the measurement and rules out a blend band,
        tile offset or slice that is merely plausible rather than right (a 128px tile, four times
        the seams, already drifts to 0.67).
        """
        ae = _build_autoencoder()
        z = torch.randn(1, 16, 96, 96)
        with torch.no_grad():
            untiled = ae.decode(z)
            ae.enable_tiling()
            tiled = ae.decode(z)
        assert 1e-3 < (untiled - tiled).abs().max() < 0.3

    def test_geometry_is_exact_without_the_global_operators(self):
        ae = _build_autoencoder()
        _make_purely_convolutional(ae)
        z = torch.randn(1, 16, 96, 96)
        with torch.no_grad():
            untiled = ae.decode(z)
            ae.enable_tiling()
            tiled = ae.decode(z)
        # Purely convolutional: the slicing, the coordinate scale-up and the linear blending must
        # reproduce the single-pass decode to float32 precision, seams included.
        assert torch.allclose(untiled, tiled, atol=1e-6)

    @pytest.mark.parametrize(
        "latent_hw",
        [
            (96, 96),  # tiles do not divide the image evenly
            (128, 128),  # 2x2 tiles, evenly divided
            (100, 77),  # odd on both axes
            (64, 160),  # tiling on one axis only
            # One axis exactly as small as the latent overlap (128px / 8 = 16). `calc_tiles_min_
            # overlap` clamps the tile down to the image there and then divides by
            # `tile - min_overlap`, which used to raise ZeroDivisionError -- including on the OOM
            # retry, where it replaced the out-of-memory error with a division by zero.
            (16, 96),
            (96, 16),
            # Same clamp, but the long axis now lands on a 15-latent (120px) tile overlap rather
            # than a comfortable 32-latent one. That is *below* the configured 128px overlap, so
            # the blend amount has to come from the clamped overlap; the configured one trips
            # `merge_tiles_with_linear_blending`'s `tile.overlap >= blend_amount` assertion.
            (16, 113),
            # A 1-latent axis leaves no overlap at all once clamped, so the layout is degenerate
            # and the decode falls back to a single pass.
            (1, 96),
        ],
    )
    def test_shape_and_dtype_survive_every_layout(self, latent_hw):
        ae = _build_autoencoder()
        h, w = latent_hw
        z = torch.randn(1, 16, h, w)
        with torch.no_grad():
            untiled = ae.decode(z)
            ae.enable_tiling()
            tiled = ae.decode(z)
        assert tiled.shape == untiled.shape == (1, 3, h * 8, w * 8)
        assert tiled.dtype == untiled.dtype == z.dtype
        assert tiled.device == z.device

    def test_an_image_smaller_than_one_tile_is_decoded_in_a_single_pass(self):
        ae = _build_autoencoder()
        z = torch.randn(1, 16, 32, 32)  # 256px, well under the 512px tile
        with torch.no_grad():
            untiled = ae.decode(z)
            ae.enable_tiling()
            tiled = ae.decode(z)
        # Not merely close: there is nothing to tile, so it must be the same computation.
        assert torch.equal(untiled, tiled)

    def test_batches_are_decoded_independently(self):
        ae = _build_autoencoder()
        _make_purely_convolutional(ae)
        z = torch.randn(2, 16, 96, 96)
        with torch.no_grad():
            ae.enable_tiling()
            batched = ae.decode(z)
            singles = torch.cat([ae.decode(z[i : i + 1]) for i in range(2)])
        assert batched.shape == (2, 3, 768, 768)
        assert torch.allclose(batched, singles, atol=1e-6)

    def test_the_shipped_geometry_is_the_accurate_one(self):
        """Smaller tiles are less accurate, not more -- measured, and the reason for the default.

        Halving the tile at a fixed image size multiplies the seams, and the blend bands then sit
        closer to each tile's own zero-padded border. On this fixture, purely convolutional, at
        96x96 latents: 512px tiles reproduce the single-pass decode to 1.0e-07, while 256px tiles
        with the same 128px overlap drift to 4.4e-03 -- four orders of magnitude worse.
        """
        ae = _build_autoencoder()
        _make_purely_convolutional(ae)
        z = torch.randn(1, 16, 96, 96)
        with torch.no_grad():
            untiled = ae.decode(z)
            ae.enable_tiling(tile_sample_min_size=DEFAULT_TILE_SAMPLE_MIN_SIZE)
            shipped = ae.decode(z)
            ae.enable_tiling(tile_sample_min_size=256)
            smaller = ae.decode(z)

        assert shipped.shape == smaller.shape == untiled.shape
        assert (untiled - shipped).abs().max() < 1e-6
        assert (untiled - shipped).abs().max() < (untiled - smaller).abs().max()

    def test_a_tile_too_small_for_the_default_overlap_shrinks_it_instead_of_raising(self):
        # The workflow UI lets a user type any multiple of 8 into `tile_size`; a value under the
        # default 128px overlap must not turn into a failed generation.
        ae = _build_autoencoder()
        ae.enable_tiling(tile_sample_min_size=128)
        assert ae.tile_overlap == 64
        assert ae.tile_overlap % ae.spatial_compression == 0
        with torch.no_grad():
            assert ae.decode(torch.randn(1, 16, 96, 96)).shape == (1, 3, 768, 768)

    def test_every_tile_reaches_the_merge_as_a_host_array(self):
        """What tiling bounds and what it does not.

        A tile leaves the decode device as soon as it is decoded, which is what bounds *device*
        memory to one tile. Host memory is a different story: the merge runs after the loop, so it
        receives all of them at once and the host holds the whole image in tiles. The decoder's
        docstring has to say both, and this is the observation behind it.
        """
        ae = _build_autoencoder()
        seen: list[tuple[list[type], int]] = []

        import invokeai.backend.flux.modules.autoencoder as autoencoder_module

        real_merge = autoencoder_module.merge_tiles_with_linear_blending

        def spy(dst_image, tiles, tile_images, blend_amount):
            seen.append(([type(t) for t in tile_images], blend_amount))
            return real_merge(dst_image, tiles, tile_images, blend_amount)

        autoencoder_module.merge_tiles_with_linear_blending = spy
        try:
            ae.enable_tiling()
            with torch.no_grad():
                ae.decode(torch.randn(1, 16, 96, 96))
        finally:
            autoencoder_module.merge_tiles_with_linear_blending = real_merge

        # 96 latents against a 64-latent tile with a 16-latent minimum overlap needs two tiles per
        # axis, so four in total -- and the merge is handed all four in one call. The blend band is
        # the configured overlap here, because nothing about this layout forces the clamp.
        assert seen == [([np.ndarray] * 4, DEFAULT_TILE_OVERLAP)]

    def test_a_clamped_overlap_shrinks_the_blend_band_with_it(self):
        """The blend band has to come from the overlap the layout was built with.

        On a 128x904 image the clamp drops the latent overlap from 16 to 15, and the tiler then
        lays the two columns out with exactly 15 latents (120px) of overlap. The configured 128px
        would exceed that, and `merge_tiles_with_linear_blending` asserts every non-edge overlap is
        at least the blend amount -- so passing `self.tile_overlap` here is an AssertionError deep
        in the tiling utility, not a seam.
        """
        ae = _build_autoencoder()
        seen: list[int] = []

        import invokeai.backend.flux.modules.autoencoder as autoencoder_module

        real_merge = autoencoder_module.merge_tiles_with_linear_blending

        def spy(dst_image, tiles, tile_images, blend_amount):
            seen.append(blend_amount)
            return real_merge(dst_image, tiles, tile_images, blend_amount)

        autoencoder_module.merge_tiles_with_linear_blending = spy
        try:
            ae.enable_tiling()
            with torch.no_grad():
                decoded = ae.decode(torch.randn(1, 16, 16, 113))
        finally:
            autoencoder_module.merge_tiles_with_linear_blending = real_merge

        assert seen == [120]
        assert decoded.shape == (1, 3, 128, 904)
