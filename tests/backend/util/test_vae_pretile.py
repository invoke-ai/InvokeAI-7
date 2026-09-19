"""The decode nodes' up-front tiling rule: tile when an untiled decode would claim more than a share of the VAE's GPU.

Waiting for an out-of-memory error does not work where the driver pages into system memory instead of failing
(Windows ROCm always, NVIDIA's sysmem fallback by default), so the rule has to hold on the estimate alone.
"""

import math
from unittest.mock import MagicMock, patch

import pytest
import torch

from invokeai.backend.util.vae_working_memory import VAE_PRETILE_VRAM_FRACTION, should_pretile_vae_decode

TOTAL = 16 * 2**30


@pytest.mark.parametrize("fraction", [0.7, VAE_PRETILE_VRAM_FRACTION], ids=["anima", "image-and-video-vaes"])
def test_a_gpu_decode_flips_at_the_share_of_its_devices_memory(fraction):
    device = torch.device("cuda", 1)
    boundary = fraction * TOTAL
    with patch("torch.cuda.get_device_properties", return_value=MagicMock(total_memory=TOTAL)) as props:
        assert should_pretile_vae_decode(device, math.floor(boundary), fraction) is False
        assert should_pretile_vae_decode(device, math.ceil(boundary) + 1, fraction) is True
    props.assert_called_with(device)  # the VAE's own device, not whichever is current


@pytest.mark.parametrize("device_type", ["cpu", "mps"])
def test_a_decode_off_the_gpu_is_never_tiled_on_these_grounds(device_type):
    """A cpu_only VAE runs in system RAM, and MPS shares it: device totals are not the constraint there."""
    assert should_pretile_vae_decode(torch.device(device_type), 10**15, VAE_PRETILE_VRAM_FRACTION) is False


def test_1024px_stays_untiled_on_an_8gb_card_and_1536px_tiles_on_16gb():
    """The share is chosen so common sizes keep the exact single-pass decode: a Qwen-Image VAE decode at 1024px
    (~5.7 GiB) on an 8 GiB card stays untiled; a FLUX VAE decode at 1536px on ROCm (~15.8 GiB) tiles on 16 GiB."""
    with patch("torch.cuda.get_device_properties", return_value=MagicMock(total_memory=8 * 2**30)):
        assert not should_pretile_vae_decode(torch.device("cuda"), 1024 * 1024 * 2 * 2900, VAE_PRETILE_VRAM_FRACTION)
    with patch("torch.cuda.get_device_properties", return_value=MagicMock(total_memory=TOTAL)):
        assert should_pretile_vae_decode(torch.device("cuda"), 1536 * 1536 * 2 * 3600, VAE_PRETILE_VRAM_FRACTION)
