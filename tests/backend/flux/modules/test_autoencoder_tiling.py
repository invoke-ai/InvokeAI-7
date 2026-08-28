"""Tiled decode for InvokeAI's FLUX.1 autoencoder.

The reference numbers for tiled-vs-untiled agreement come from measurement, not taste: diffusers'
own tiling of this VAE gives max 0.082 / mean 0.0022 per pixel at 1536px on a +/-1 image. A tiled
decode of this architecture can never be exact, because the decoder's GroupNorms normalise over the
whole spatial extent and its mid-block attention is global -- both see a different input when the
image arrives in tiles. What *is* exact is the tile geometry, and `test_geometry_is_exact_without_
the_global_operators` pins it by removing those two operators and demanding equality.
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
        ],
    )
    def test_geometry_that_cannot_be_sliced_is_rejected(self, kwargs, message):
        # A tile edge that is not a multiple of the compression factor has no exact latent slice,
        # and an overlap at least as large as the tile makes the layout degenerate.
        with pytest.raises(ValueError, match=message):
            _build_autoencoder().enable_tiling(**kwargs)


class TestTiledDecode:
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

    def test_finished_tiles_do_not_stay_on_the_decode_device(self):
        # Bounding the peak is the entire point: a tile is moved off the device as soon as it is
        # decoded, so what the merge sees is numpy on the host.
        ae = _build_autoencoder()
        seen: list[type] = []
        real_merge = None

        import invokeai.backend.flux.modules.autoencoder as autoencoder_module

        real_merge = autoencoder_module.merge_tiles_with_linear_blending

        def spy(dst_image, tiles, tile_images, blend_amount):
            seen.extend(type(t) for t in tile_images)
            return real_merge(dst_image, tiles, tile_images, blend_amount)

        autoencoder_module.merge_tiles_with_linear_blending = spy
        try:
            ae.enable_tiling()
            with torch.no_grad():
                ae.decode(torch.randn(1, 16, 96, 96))
        finally:
            autoencoder_module.merge_tiles_with_linear_blending = real_merge

        assert seen and all(t is np.ndarray for t in seen)
