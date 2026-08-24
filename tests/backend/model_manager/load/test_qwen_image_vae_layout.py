"""The Qwen-Image VAE loader picks its path from the checkpoint's key layout, not from its base.

Two layouts are in circulation for the same 16-channel autoencoder. Files exported from the
Qwen-Image repo carry diffusers keys (`decoder.conv_in.weight`); community redistributions carry the
original layout (`decoder.conv1.weight`) and need converting.

Only the first was handled, with `strict=True`, so a redistributed file failed with 194 missing keys
-- while the byte-identical checkpoint installed under `anima` loaded fine, because that path uses
`AutoencoderKLWan.from_single_file`, which converts. Whether a VAE worked came down to which base it
happened to be probed as.
"""

from unittest.mock import MagicMock, patch

import torch

from invokeai.backend.model_manager.load.model_loaders.vae import VAELoader


def _loader() -> VAELoader:
    loader = VAELoader.__new__(VAELoader)
    loader._torch_dtype = torch.float16  # type: ignore[attr-defined]
    loader._ram_cache = MagicMock()  # type: ignore[attr-defined]
    return loader


def _config(path: str = "vae.safetensors") -> MagicMock:
    config = MagicMock()
    config.path = path
    return config


def test_the_original_layout_is_converted_rather_than_rejected() -> None:
    state_dict = {"decoder.conv1.weight": torch.zeros(1), "encoder.conv1.weight": torch.zeros(1)}

    with (
        patch("safetensors.torch.load_file", return_value=state_dict),
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
        patch("invokeai.backend.wan.rocm_causal_conv3d.patch_wan_causal_conv3d_for_rocm"),
    ):
        result = _loader()._load_qwen_image_vae(_config())

    wan.from_single_file.assert_called_once()
    assert result is wan.from_single_file.return_value


def test_the_diffusers_layout_still_loads_directly() -> None:
    """`AutoencoderKLQwenImage` registers no single-file conversion, so this path stays."""
    state_dict = {"decoder.conv_in.weight": torch.zeros(1)}

    with (
        patch("safetensors.torch.load_file", return_value=state_dict),
        patch("accelerate.init_empty_weights"),
        patch("diffusers.models.autoencoders.autoencoder_kl_qwenimage.AutoencoderKLQwenImage") as qwen,
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
    ):
        result = _loader()._load_qwen_image_vae(_config())

    wan.from_single_file.assert_not_called()
    qwen.return_value.load_state_dict.assert_called_once()
    assert result is qwen.return_value
