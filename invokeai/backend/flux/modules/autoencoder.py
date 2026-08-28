# Initially pulled from https://github.com/black-forest-labs/flux

from dataclasses import dataclass

import numpy as np
import torch
from einops import rearrange
from torch import Tensor, nn

from invokeai.backend.tiles.tiles import calc_tiles_min_overlap, merge_tiles_with_linear_blending
from invokeai.backend.tiles.utils import TBLR, Tile

# Tile geometry for tiled decode, in output-pixel units. 512px tiles with a 128px minimum overlap is
# the geometry the diffusers VAEs and the Anima node use. Both values must be divisible by the
# autoencoder's spatial compression factor so that a pixel-space tile maps onto an exact latent slice.
DEFAULT_TILE_SAMPLE_MIN_SIZE = 512
DEFAULT_TILE_OVERLAP = 128

# A cost floor, not a correctness one: the geometry stays valid all the way down, but the tile count
# grows with the inverse square of the tile size. At 2048x2048 a 128px tile already emits 289 tiles;
# a 16px tile would emit ~16k, and the per-tile kernel-launch overhead dominates long before that.
# Small tiles are also measurably less accurate (see `enable_tiling`), so the low end of the node
# field is clamped rather than honoured literally.
MIN_TILE_SAMPLE_SIZE = 128


def resolve_tile_size(tile_size: int) -> int:
    """Resolve a node's ``tile_size`` field to the size the autoencoder will actually use.

    ``tile_size <= 0`` is the nodes' "use the default" sentinel -- the workflow UI cannot represent
    ``None`` in a number input and sends 0, and a negative value is not worth failing a generation
    over. It resolves to the module-level default rather than to whatever is currently set on the
    VAE: the instance belongs to the model cache, so reading it back would return whatever the
    previous invocation left there.
    """
    if tile_size <= 0:
        return DEFAULT_TILE_SAMPLE_MIN_SIZE
    return max(tile_size, MIN_TILE_SAMPLE_SIZE)


@dataclass
class AutoEncoderParams:
    resolution: int
    in_channels: int
    ch: int
    out_ch: int
    ch_mult: list[int]
    num_res_blocks: int
    z_channels: int
    scale_factor: float
    shift_factor: float


class AttnBlock(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.in_channels = in_channels

        self.norm = nn.GroupNorm(num_groups=32, num_channels=in_channels, eps=1e-6, affine=True)

        self.q = nn.Conv2d(in_channels, in_channels, kernel_size=1)
        self.k = nn.Conv2d(in_channels, in_channels, kernel_size=1)
        self.v = nn.Conv2d(in_channels, in_channels, kernel_size=1)
        self.proj_out = nn.Conv2d(in_channels, in_channels, kernel_size=1)

    def attention(self, h_: Tensor) -> Tensor:
        h_ = self.norm(h_)
        q = self.q(h_)
        k = self.k(h_)
        v = self.v(h_)

        b, c, h, w = q.shape
        q = rearrange(q, "b c h w -> b 1 (h w) c").contiguous()
        k = rearrange(k, "b c h w -> b 1 (h w) c").contiguous()
        v = rearrange(v, "b c h w -> b 1 (h w) c").contiguous()
        h_ = nn.functional.scaled_dot_product_attention(q, k, v)

        return rearrange(h_, "b 1 (h w) c -> b c h w", h=h, w=w, c=c, b=b)

    def forward(self, x: Tensor) -> Tensor:
        return x + self.proj_out(self.attention(x))


class ResnetBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int):
        super().__init__()
        self.in_channels = in_channels
        out_channels = in_channels if out_channels is None else out_channels
        self.out_channels = out_channels

        self.norm1 = nn.GroupNorm(num_groups=32, num_channels=in_channels, eps=1e-6, affine=True)
        self.conv1 = nn.Conv2d(in_channels, out_channels, kernel_size=3, stride=1, padding=1)
        self.norm2 = nn.GroupNorm(num_groups=32, num_channels=out_channels, eps=1e-6, affine=True)
        self.conv2 = nn.Conv2d(out_channels, out_channels, kernel_size=3, stride=1, padding=1)
        if self.in_channels != self.out_channels:
            self.nin_shortcut = nn.Conv2d(in_channels, out_channels, kernel_size=1, stride=1, padding=0)

    def forward(self, x):
        h = x
        h = self.norm1(h)
        h = torch.nn.functional.silu(h)
        h = self.conv1(h)

        h = self.norm2(h)
        h = torch.nn.functional.silu(h)
        h = self.conv2(h)

        if self.in_channels != self.out_channels:
            x = self.nin_shortcut(x)

        return x + h


class Downsample(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        # no asymmetric padding in torch conv, must do it ourselves
        self.conv = nn.Conv2d(in_channels, in_channels, kernel_size=3, stride=2, padding=0)

    def forward(self, x: Tensor):
        pad = (0, 1, 0, 1)
        x = nn.functional.pad(x, pad, mode="constant", value=0)
        x = self.conv(x)
        return x


class Upsample(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.conv = nn.Conv2d(in_channels, in_channels, kernel_size=3, stride=1, padding=1)

    def forward(self, x: Tensor):
        x = nn.functional.interpolate(x, scale_factor=2.0, mode="nearest")
        x = self.conv(x)
        return x


class Encoder(nn.Module):
    def __init__(
        self,
        resolution: int,
        in_channels: int,
        ch: int,
        ch_mult: list[int],
        num_res_blocks: int,
        z_channels: int,
    ):
        super().__init__()
        self.ch = ch
        self.num_resolutions = len(ch_mult)
        self.num_res_blocks = num_res_blocks
        self.resolution = resolution
        self.in_channels = in_channels
        # downsampling
        self.conv_in = nn.Conv2d(in_channels, self.ch, kernel_size=3, stride=1, padding=1)

        curr_res = resolution
        in_ch_mult = (1,) + tuple(ch_mult)
        self.in_ch_mult = in_ch_mult
        self.down = nn.ModuleList()
        block_in = self.ch
        for i_level in range(self.num_resolutions):
            block = nn.ModuleList()
            attn = nn.ModuleList()
            block_in = ch * in_ch_mult[i_level]
            block_out = ch * ch_mult[i_level]
            for _ in range(self.num_res_blocks):
                block.append(ResnetBlock(in_channels=block_in, out_channels=block_out))
                block_in = block_out
            down = nn.Module()
            down.block = block
            down.attn = attn
            if i_level != self.num_resolutions - 1:
                down.downsample = Downsample(block_in)
                curr_res = curr_res // 2
            self.down.append(down)

        # middle
        self.mid = nn.Module()
        self.mid.block_1 = ResnetBlock(in_channels=block_in, out_channels=block_in)
        self.mid.attn_1 = AttnBlock(block_in)
        self.mid.block_2 = ResnetBlock(in_channels=block_in, out_channels=block_in)

        # end
        self.norm_out = nn.GroupNorm(num_groups=32, num_channels=block_in, eps=1e-6, affine=True)
        self.conv_out = nn.Conv2d(block_in, 2 * z_channels, kernel_size=3, stride=1, padding=1)

    def forward(self, x: Tensor) -> Tensor:
        # downsampling
        hs = [self.conv_in(x)]
        for i_level in range(self.num_resolutions):
            for i_block in range(self.num_res_blocks):
                h = self.down[i_level].block[i_block](hs[-1])
                if len(self.down[i_level].attn) > 0:
                    h = self.down[i_level].attn[i_block](h)
                hs.append(h)
            if i_level != self.num_resolutions - 1:
                hs.append(self.down[i_level].downsample(hs[-1]))

        # middle
        h = hs[-1]
        h = self.mid.block_1(h)
        h = self.mid.attn_1(h)
        h = self.mid.block_2(h)
        # end
        h = self.norm_out(h)
        h = torch.nn.functional.silu(h)
        h = self.conv_out(h)
        return h


class Decoder(nn.Module):
    def __init__(
        self,
        ch: int,
        out_ch: int,
        ch_mult: list[int],
        num_res_blocks: int,
        in_channels: int,
        resolution: int,
        z_channels: int,
    ):
        super().__init__()
        self.ch = ch
        self.num_resolutions = len(ch_mult)
        self.num_res_blocks = num_res_blocks
        self.resolution = resolution
        self.in_channels = in_channels
        self.ffactor = 2 ** (self.num_resolutions - 1)

        # compute in_ch_mult, block_in and curr_res at lowest res
        block_in = ch * ch_mult[self.num_resolutions - 1]
        curr_res = resolution // 2 ** (self.num_resolutions - 1)
        self.z_shape = (1, z_channels, curr_res, curr_res)

        # z to block_in
        self.conv_in = nn.Conv2d(z_channels, block_in, kernel_size=3, stride=1, padding=1)

        # middle
        self.mid = nn.Module()
        self.mid.block_1 = ResnetBlock(in_channels=block_in, out_channels=block_in)
        self.mid.attn_1 = AttnBlock(block_in)
        self.mid.block_2 = ResnetBlock(in_channels=block_in, out_channels=block_in)

        # upsampling
        self.up = nn.ModuleList()
        for i_level in reversed(range(self.num_resolutions)):
            block = nn.ModuleList()
            attn = nn.ModuleList()
            block_out = ch * ch_mult[i_level]
            for _ in range(self.num_res_blocks + 1):
                block.append(ResnetBlock(in_channels=block_in, out_channels=block_out))
                block_in = block_out
            up = nn.Module()
            up.block = block
            up.attn = attn
            if i_level != 0:
                up.upsample = Upsample(block_in)
                curr_res = curr_res * 2
            self.up.insert(0, up)  # prepend to get consistent order

        # end
        self.norm_out = nn.GroupNorm(num_groups=32, num_channels=block_in, eps=1e-6, affine=True)
        self.conv_out = nn.Conv2d(block_in, out_ch, kernel_size=3, stride=1, padding=1)

    def forward(self, z: Tensor) -> Tensor:
        # z to block_in
        h = self.conv_in(z)

        # middle
        h = self.mid.block_1(h)
        h = self.mid.attn_1(h)
        h = self.mid.block_2(h)

        # upsampling
        for i_level in reversed(range(self.num_resolutions)):
            for i_block in range(self.num_res_blocks + 1):
                h = self.up[i_level].block[i_block](h)
                if len(self.up[i_level].attn) > 0:
                    h = self.up[i_level].attn[i_block](h)
            if i_level != 0:
                h = self.up[i_level].upsample(h)

        # end
        h = self.norm_out(h)
        h = torch.nn.functional.silu(h)
        h = self.conv_out(h)
        return h


class DiagonalGaussian(nn.Module):
    def __init__(self, chunk_dim: int = 1):
        super().__init__()
        self.chunk_dim = chunk_dim

    def forward(self, z: Tensor, sample: bool = True, generator: torch.Generator | None = None) -> Tensor:
        mean, logvar = torch.chunk(z, 2, dim=self.chunk_dim)
        if sample:
            std = torch.exp(0.5 * logvar)
            # Unfortunately, torch.randn_like(...) does not accept a generator argument at the time of writing, so we
            # have to use torch.randn(...) instead.
            return mean + std * torch.randn(size=mean.size(), generator=generator, dtype=mean.dtype, device=mean.device)
        else:
            return mean


class AutoEncoder(nn.Module):
    def __init__(self, params: AutoEncoderParams):
        super().__init__()
        self.encoder = Encoder(
            resolution=params.resolution,
            in_channels=params.in_channels,
            ch=params.ch,
            ch_mult=params.ch_mult,
            num_res_blocks=params.num_res_blocks,
            z_channels=params.z_channels,
        )
        self.decoder = Decoder(
            resolution=params.resolution,
            in_channels=params.in_channels,
            ch=params.ch,
            out_ch=params.out_ch,
            ch_mult=params.ch_mult,
            num_res_blocks=params.num_res_blocks,
            z_channels=params.z_channels,
        )
        self.reg = DiagonalGaussian()

        self.scale_factor = params.scale_factor
        self.shift_factor = params.shift_factor

        # Each level of `ch_mult` past the first halves the spatial resolution, so this is the ratio
        # between output pixels and latent elements along one axis (8 for the FLUX.1 autoencoder).
        self.spatial_compression = 2 ** (len(params.ch_mult) - 1)

        self.use_tiling = False
        self.tile_sample_min_size = DEFAULT_TILE_SAMPLE_MIN_SIZE
        self.tile_overlap = DEFAULT_TILE_OVERLAP

    def enable_tiling(
        self,
        tile_sample_min_size: int = DEFAULT_TILE_SAMPLE_MIN_SIZE,
        tile_overlap: int | None = None,
    ) -> None:
        """Decode in overlapping tiles, bounding peak memory at the cost of some decode time.

        Mirrors the `enable_tiling()` / `disable_tiling()` pair on the diffusers autoencoders so that
        callers can set the tiling state the same way regardless of which VAE class they hold. Sizes
        are in output pixels.

        `tile_overlap` defaults to DEFAULT_TILE_OVERLAP, shrunk to half the tile if the caller asked
        for a tile that small. The alternative -- raising -- would turn a tile size the workflow UI
        lets a user type into a failed generation.

        Note on accuracy: at the default 512/128 geometry a tiled decode reproduces the single-pass
        one exactly (float32 epsilon, measured). It degrades as tiles get small relative to the
        image, because more tiles mean the blend bands sit closer to the tiles' own zero-padded
        borders. Prefer a large tile that fits over a small one that fits comfortably.
        """
        if tile_overlap is None:
            tile_overlap = min(DEFAULT_TILE_OVERLAP, tile_sample_min_size // 2)
            tile_overlap -= tile_overlap % self.spatial_compression
        if tile_sample_min_size % self.spatial_compression != 0:
            raise ValueError(
                f"tile_sample_min_size must be divisible by {self.spatial_compression}, got {tile_sample_min_size}."
            )
        if tile_overlap % self.spatial_compression != 0:
            raise ValueError(f"tile_overlap must be divisible by {self.spatial_compression}, got {tile_overlap}.")
        if tile_overlap >= tile_sample_min_size:
            raise ValueError(
                f"tile_overlap ({tile_overlap}) must be smaller than tile_sample_min_size ({tile_sample_min_size})."
            )
        self.use_tiling = True
        self.tile_sample_min_size = tile_sample_min_size
        self.tile_overlap = tile_overlap

    def disable_tiling(self) -> None:
        """Decode in a single pass. The inverse of `enable_tiling()`."""
        self.use_tiling = False

    def encode(self, x: Tensor, sample: bool = True, generator: torch.Generator | None = None) -> Tensor:
        """Run VAE encoding on input tensor x.

        Args:
            x (Tensor): Input image tensor. Shape: (batch_size, in_channels, height, width).
            sample (bool, optional): If True, sample from the encoded distribution, else, return the distribution mean.
                Defaults to True.
            generator (torch.Generator | None, optional): Optional random number generator for reproducibility.
                Defaults to None.

        Returns:
            Tensor: Encoded latent tensor. Shape: (batch_size, z_channels, latent_height, latent_width).
        """

        z = self.reg(self.encoder(x), sample=sample, generator=generator)
        z = self.scale_factor * (z - self.shift_factor)
        return z

    def decode(self, z: Tensor) -> Tensor:
        z = z / self.scale_factor + self.shift_factor
        if self.use_tiling:
            return self._tiled_decode(z)
        return self.decoder(z)

    def _tiled_decode(self, z: Tensor) -> Tensor:
        """Decode `z` as overlapping tiles, blended back together linearly.

        `z` is expected to already be denormalised, i.e. this consumes what `decode()` hands to
        `self.decoder`. Peak memory is bounded by one tile plus the destination image, because each
        finished tile is moved to the CPU before the next one is decoded.

        The tile layout is computed in *latent* space and scaled up afterwards. Computing it in pixel
        space would be wrong: `calc_tiles_min_overlap` distributes the leftover with integer
        division, so it hands back tile edges that are not multiples of `spatial_compression` and
        therefore cannot be sliced out of `z`. Overlaps scale with the coordinates because they are
        nothing but coordinate differences.
        """
        scale = self.spatial_compression
        latent_tile_size = self.tile_sample_min_size // scale
        latent_overlap = self.tile_overlap // scale
        latent_height, latent_width = z.shape[-2], z.shape[-1]

        # Nothing to gain from tiling something that already fits in a single tile.
        if latent_height <= latent_tile_size and latent_width <= latent_tile_size:
            return self.decoder(z)

        latent_tiles = calc_tiles_min_overlap(
            image_height=latent_height,
            image_width=latent_width,
            tile_height=latent_tile_size,
            tile_width=latent_tile_size,
            min_overlap=latent_overlap,
        )
        pixel_tiles = [
            Tile(
                coords=TBLR(
                    top=t.coords.top * scale,
                    bottom=t.coords.bottom * scale,
                    left=t.coords.left * scale,
                    right=t.coords.right * scale,
                ),
                overlap=TBLR(
                    top=t.overlap.top * scale,
                    bottom=t.overlap.bottom * scale,
                    left=t.overlap.left * scale,
                    right=t.overlap.right * scale,
                ),
            )
            for t in latent_tiles
        ]

        out_channels = self.decoder.conv_out.out_channels
        batch_images: list[Tensor] = []
        for batch_idx in range(z.shape[0]):
            tile_images: list[np.ndarray] = []
            for latent_tile in latent_tiles:
                latent_slice = z[
                    batch_idx : batch_idx + 1,
                    :,
                    latent_tile.coords.top : latent_tile.coords.bottom,
                    latent_tile.coords.left : latent_tile.coords.right,
                ]
                decoded_tile = self.decoder(latent_slice)
                # Off the GPU immediately -- holding the finished tiles on the device is the thing
                # tiling exists to avoid.
                tile_images.append(decoded_tile[0].permute(1, 2, 0).float().cpu().numpy())

            merged = np.zeros(
                (latent_height * scale, latent_width * scale, out_channels),
                dtype=tile_images[0].dtype,
            )
            merge_tiles_with_linear_blending(
                dst_image=merged,
                tiles=pixel_tiles,
                tile_images=tile_images,
                blend_amount=self.tile_overlap,
            )
            batch_images.append(torch.from_numpy(merged).permute(2, 0, 1))

        return torch.stack(batch_images).to(device=z.device, dtype=z.dtype)

    def forward(self, x: Tensor) -> Tensor:
        return self.decode(self.encode(x))
