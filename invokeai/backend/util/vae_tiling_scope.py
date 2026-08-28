"""Scoped VAE tiling state.

The VAE instances these helpers take belong to the model cache and are shared across invocations and
across *nodes*: the FLUX.1 autoencoder is reached by nine call sites, and a diffusers AutoencoderKL
loaded for Z-Image is reached by several more. Tiling is a property of one decode, not of the model,
so it has to be restored rather than merely turned off -- `disable_tiling()` clears the flag but
leaves the geometry, and most of the consumers never touch the flag at all.

Two siblings solve the same problem for their own classes: `patch_qwen_image_vae_tiling` for the
Qwen-Image VAE, and `stable_diffusion.vae_tiling.patch_vae_tiling_params` for SD's. Neither fits
here -- the SD one is typed to AutoencoderKL/AutoencoderTiny, patches three diffusers-specific
attributes the FLUX autoencoder does not have, and leaves `use_tiling` to the caller.
"""

from contextlib import contextmanager
from typing import Any, Iterator

from invokeai.backend.flux.modules.autoencoder import AutoEncoder, resolve_tile_size

# Attributes that carry tiling state, across the VAE classes that reach these nodes: InvokeAI's FLUX
# AutoEncoder and diffusers' AutoencoderKL. Read defensively -- a class that has none of them simply
# has nothing to restore.
_TILING_ATTRS = (
    "use_tiling",
    "tile_sample_min_size",
    "tile_overlap",
    "tile_latent_min_size",
    "tile_overlap_factor",
)

_MISSING = object()


@contextmanager
def scoped_vae_tiling(vae: Any, tile_size: int | None) -> Iterator[None]:
    """Set the VAE's tiling state for the duration of the block, then restore exactly what was there.

    `tile_size=None` decodes in a single pass; `0` means "the VAE's own default"; any other value is
    the tile size in output pixels.
    """
    original = {name: getattr(vae, name, _MISSING) for name in _TILING_ATTRS}
    try:
        if tile_size is None:
            vae.disable_tiling()
        elif _accepts_tile_size(vae):
            # resolve_tile_size owns the 0/negative sentinel and the cost floor, so every caller
            # gets the same answer for the same field value.
            vae.enable_tiling(tile_sample_min_size=resolve_tile_size(tile_size))
        else:
            # This class does not expose a settable size -- diffusers' AutoencoderKL.enable_tiling()
            # takes no arguments and uses its own geometry.
            vae.enable_tiling()
        yield
    finally:
        for name, value in original.items():
            if value is not _MISSING:
                setattr(vae, name, value)


def _accepts_tile_size(vae: Any) -> bool:
    """True if `enable_tiling` takes a tile size. Diffusers' AutoencoderKL takes no arguments."""
    return isinstance(vae, AutoEncoder)
