"""The Qwen-Image VAE loader picks its path from the checkpoint's key layout, not from its base.

Two layouts are in circulation for the same 16-channel autoencoder. Files exported from the
Qwen-Image repo carry diffusers keys (`decoder.conv_in.weight`); community redistributions carry the
original Wan-family layout (`decoder.middle.0.residual.0.gamma`) and need converting.

Only the first was handled, with `strict=True`, so a redistributed file failed with 194 missing keys
-- while the byte-identical checkpoint installed under `anima` loaded fine, because that path
converts. Whether a VAE worked came down to which base it happened to be probed as.

Both branches are now keyed on a marker the layout must carry, and both registrations of the
Wan-family file land in one loader, so the dtype and strictness policy cannot diverge between them.
"""

from unittest.mock import MagicMock, patch

import pytest
import torch

from invokeai.backend.model_manager.configs.vae import VAE_Checkpoint_Anima_Config
from invokeai.backend.model_manager.load.model_loaders.vae import VAELoader

# One key from each rule the Wan converter implements, so the assertion below is over a real
# conversion rather than a renamed copy of its input.
_ORIGINAL_LAYOUT = {
    "conv1.weight": "quant_conv.weight",
    "conv2.weight": "post_quant_conv.weight",
    "encoder.conv1.weight": "encoder.conv_in.weight",
    "encoder.downsamples.0.residual.0.gamma": "encoder.down_blocks.0.norm1.gamma",
    "encoder.middle.1.to_qkv.weight": "encoder.mid_block.attentions.0.to_qkv.weight",
    "decoder.conv1.weight": "decoder.conv_in.weight",
    "decoder.middle.0.residual.0.gamma": "decoder.mid_block.resnets.0.norm1.gamma",
    "decoder.upsamples.0.residual.0.gamma": "decoder.up_blocks.0.resnets.0.norm1.gamma",
    "decoder.head.0.gamma": "decoder.norm_out.gamma",
}


def _loader() -> VAELoader:
    loader = VAELoader.__new__(VAELoader)
    # float16 on CUDA is what `precision: auto` resolves to, and what the Wan VAE is unstable in.
    loader._torch_dtype = torch.float16  # type: ignore[attr-defined]
    loader._ram_cache = MagicMock()  # type: ignore[attr-defined]
    loader._logger = MagicMock()  # type: ignore[attr-defined]
    return loader


def _config(path: str = "vae.safetensors") -> MagicMock:
    config = MagicMock()
    config.path = path
    return config


def test_the_original_layout_is_converted_and_loaded_in_bfloat16() -> None:
    """`from_single_file` would fetch the Wan config over HTTP at load time, and it would honour
    `self._torch_dtype` -- float16 on a default CUDA install, the dtype `_load_wan_vae` and
    `_load_wan_vae_diffusers` both refuse for this exact autoencoder."""
    state_dict = {key: torch.zeros(2, dtype=torch.float32) for key in _ORIGINAL_LAYOUT}

    with (
        patch(
            "invokeai.backend.model_manager.load.model_loaders.vae._checkpoint_keys",
            return_value=set(state_dict),
        ),
        patch("safetensors.torch.load_file", return_value=state_dict),
        patch("accelerate.init_empty_weights"),
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
        patch("invokeai.backend.wan.rocm_causal_conv3d.patch_wan_causal_conv3d_for_rocm"),
    ):
        wan.return_value.load_state_dict.return_value = ([], [])
        loader = _loader()
        result = loader._load_qwen_image_vae(_config())

    wan.from_single_file.assert_not_called()
    wan.assert_called_once_with(z_dim=16)

    (loaded,), kwargs = wan.return_value.load_state_dict.call_args
    assert kwargs == {"strict": False, "assign": True}
    assert set(loaded) == set(_ORIGINAL_LAYOUT.values())
    assert {tensor.dtype for tensor in loaded.values()} == {torch.bfloat16}

    loader._ram_cache.make_room.assert_called_once_with(  # type: ignore[attr-defined]
        sum(tensor.nelement() * tensor.element_size() for tensor in loaded.values())
    )
    assert result is wan.return_value


def test_a_conversion_that_leaves_a_tensor_unset_is_an_error_not_a_warning() -> None:
    """`from_single_file` loads with `strict=False` and reports only *unexpected* keys, so a tensor
    the conversion never produced stays on the meta device and surfaces at the first decode --
    after the model has loaded and generation has begun."""
    state_dict = {key: torch.zeros(2, dtype=torch.float32) for key in _ORIGINAL_LAYOUT}

    with (
        patch(
            "invokeai.backend.model_manager.load.model_loaders.vae._checkpoint_keys",
            return_value=set(state_dict),
        ),
        patch("safetensors.torch.load_file", return_value=state_dict),
        patch("accelerate.init_empty_weights"),
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
        patch("invokeai.backend.wan.rocm_causal_conv3d.patch_wan_causal_conv3d_for_rocm"),
    ):
        wan.return_value.load_state_dict.return_value = (["decoder.conv_out.weight"], [])

        with pytest.raises(ValueError, match="does not convert to a complete Wan 2.1 VAE"):
            _loader()._load_qwen_image_vae(_config())


def test_the_anima_registration_takes_the_same_path() -> None:
    """The same checkpoint, registered for a different family. It used to be loaded by a separate
    branch that passed `self._torch_dtype`, so `anima` and `qwen-image` disagreed about the dtype
    of byte-identical weights."""
    loader = _loader()
    with patch.object(VAELoader, "_load_wan_family_vae") as load_wan_family:
        result = loader._load_model(VAE_Checkpoint_Anima_Config.model_construct(path="anima-vae.safetensors"))

    load_wan_family.assert_called_once_with("anima-vae.safetensors")
    assert result is load_wan_family.return_value


def test_the_diffusers_layout_still_loads_directly() -> None:
    """`AutoencoderKLQwenImage` registers no single-file conversion, so this path stays."""
    state_dict = {"decoder.conv_in.weight": torch.zeros(1)}

    with (
        patch(
            "invokeai.backend.model_manager.load.model_loaders.vae._checkpoint_keys",
            return_value=set(state_dict),
        ),
        patch("safetensors.torch.load_file", return_value=state_dict),
        patch("accelerate.init_empty_weights"),
        patch("diffusers.models.autoencoders.autoencoder_kl_qwenimage.AutoencoderKLQwenImage") as qwen,
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
    ):
        result = _loader()._load_qwen_image_vae(_config())

    wan.assert_not_called()
    qwen.return_value.load_state_dict.assert_called_once()
    assert result is qwen.return_value


def test_a_checkpoint_in_neither_layout_is_rejected() -> None:
    """The discriminator used to be a negation, so this file was assumed to be the Wan layout.

    `from_single_file` checks for keys it recognises, never for keys that are missing: an
    unrecognised file falls through to `model_type = "v1"`, fetches SD 1.5's `vae/config.json`, and
    returns an `AutoencoderKLWan` whose parameters are all still on the meta device -- a warning,
    not an error, and a failure that surfaces at the first decode instead of at install time.
    """
    state_dict = {"first_stage_model.decoder.conv_in.weight": torch.zeros(1)}

    with (
        patch(
            "invokeai.backend.model_manager.load.model_loaders.vae._checkpoint_keys",
            return_value=set(state_dict),
        ),
        patch("safetensors.torch.load_file", return_value=state_dict) as load_file,
        patch("diffusers.models.autoencoders.AutoencoderKLWan") as wan,
    ):
        with pytest.raises(ValueError, match="not a Qwen-Image VAE in either known layout"):
            _loader()._load_qwen_image_vae(_config())

    wan.assert_not_called()
    wan.from_single_file.assert_not_called()
    load_file.assert_not_called()
