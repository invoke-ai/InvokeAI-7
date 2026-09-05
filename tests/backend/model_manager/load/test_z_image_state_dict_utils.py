"""Unit tests for the Z-Image GGUF/ComfyUI -> diffusers state-dict converter."""

import json

import pytest
import torch

from invokeai.backend.model_manager.load.model_loaders.z_image import (
    _convert_z_image_gguf_to_diffusers,
    _split_qkv_sidechannel,
)
from invokeai.backend.quantization.int8_convrot import extract_int8_convrot_markers
from tests.backend.model_manager.load.state_dicts.utils import keys_to_mock_state_dict
from tests.backend.model_manager.load.state_dicts.z_image_transformer_comfyui_keys import (
    state_dict_keys as z_image_keys,
)


class TestConvertZImageGgufToDiffusers:
    def test_fused_qkv_split(self):
        sd = keys_to_mock_state_dict(z_image_keys)
        n_qkv = sum(1 for k in sd if k.endswith(".attention.qkv.weight"))
        assert n_qkv > 0

        out = _convert_z_image_gguf_to_diffusers(sd)

        # Each fused qkv weight becomes three separate projections.
        assert sum(1 for k in out if k.endswith(".attention.to_q.weight")) == n_qkv
        assert sum(1 for k in out if k.endswith(".attention.to_k.weight")) == n_qkv
        assert sum(1 for k in out if k.endswith(".attention.to_v.weight")) == n_qkv
        assert not any(".attention.qkv." in k for k in out)

    def test_key_renames(self):
        out = _convert_z_image_gguf_to_diffusers(keys_to_mock_state_dict(z_image_keys))
        # q_norm/k_norm -> norm_q/norm_k, attention.out -> attention.to_out.0
        assert any(k.endswith(".attention.norm_q.weight") for k in out)
        assert any(k.endswith(".attention.norm_k.weight") for k in out)
        assert any(k.endswith(".attention.to_out.0.weight") for k in out)
        assert not any(".q_norm." in k or ".k_norm." in k for k in out)
        assert not any(".attention.out." in k for k in out)

    def test_embedder_and_final_layer_renamed(self):
        out = _convert_z_image_gguf_to_diffusers(keys_to_mock_state_dict(z_image_keys))
        assert any(k.startswith("all_x_embedder.2-1.") for k in out)
        assert any(k.startswith("all_final_layer.2-1.") for k in out)
        assert not any(k.startswith("x_embedder.") or k.startswith("final_layer.") for k in out)

    def test_norm_final_is_dropped(self):
        # The diffusers model uses a non-learnable final LayerNorm, so norm_final.* is skipped.
        assert any(k.startswith("norm_final.") for k in z_image_keys)
        out = _convert_z_image_gguf_to_diffusers(keys_to_mock_state_dict(z_image_keys))
        assert not any(k.startswith("norm_final.") for k in out)

    def test_pad_tokens_are_2d_after_conversion(self):
        # The diffusers model expects a leading batch dim on the pad tokens. The checkpoint
        # already stores them 2D; GGUF ships them 1D (see the reshape test below).
        out = _convert_z_image_gguf_to_diffusers(keys_to_mock_state_dict(z_image_keys))
        for pad in ("x_pad_token", "cap_pad_token"):
            assert out[pad].dim() == 2
            assert out[pad].shape[0] == 1

    def test_1d_pad_token_gains_batch_dim(self):
        # GGUF stores pad tokens as [dim]; they must be reshaped to [1, dim].
        out = _convert_z_image_gguf_to_diffusers({"x_pad_token": torch.arange(4.0)})
        assert out["x_pad_token"].shape == (1, 4)

    def test_qkv_split_preserves_values(self):
        # A [6, 2] fused qkv splits into three [2, 2] chunks in order q, k, v.
        qkv = torch.arange(12, dtype=torch.float32).reshape(6, 2)
        out = _convert_z_image_gguf_to_diffusers({"blk.attention.qkv.weight": qkv})
        assert torch.allclose(out["blk.attention.to_q.weight"], qkv[0:2])
        assert torch.allclose(out["blk.attention.to_k.weight"], qkv[2:4])
        assert torch.allclose(out["blk.attention.to_v.weight"], qkv[4:6])


def _marker_blob(marker: dict) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8)


MARKER = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}


class TestTheFusedQkvSplitCarriesQuantizationMetadata:
    """A quantized fused QKV travels as three keys, and all three have to reach the same three
    modules. The weight already split; the scale and the marker did not, and were left behind
    under a module name the model does not have."""

    def test_a_per_output_channel_scale_splits_with_its_weight(self) -> None:
        scale = torch.arange(3 * 4, dtype=torch.float32).reshape(3 * 4, 1)
        pieces = [_split_qkv_sidechannel(scale, "weight_scale", t) for t in ("to_q", "to_k", "to_v")]
        assert [tuple(p.shape) for p in pieces] == [(4, 1)] * 3
        assert torch.equal(torch.cat(pieces), scale)

    def test_a_marker_is_copied_whole_to_all_three(self) -> None:
        """The regression that motivated the suffix check: a 72-byte JSON blob is divisible by
        three, so a rule based on the tensor's shape cuts it into three fragments of broken JSON."""
        blob = _marker_blob(MARKER)
        assert len(blob) % 3 == 0, "the fixture has to reproduce the divisible-by-three trap"
        for target in ("to_q", "to_k", "to_v"):
            piece = _split_qkv_sidechannel(blob, "comfy_quant", target)
            assert torch.equal(piece, blob)
            assert json.loads(bytes(piece.numpy().tobytes()).decode()) == MARKER

    def test_a_per_tensor_scale_is_copied_rather_than_split(self) -> None:
        for scale in (torch.tensor(0.5), torch.tensor([0.5])):
            assert torch.equal(_split_qkv_sidechannel(scale, "weight_scale", "to_k"), scale)

    def test_weight_scale_and_marker_land_on_the_same_three_modules(self) -> None:
        prefix = "layers.0.attention"
        sd = {
            f"{prefix}.qkv.weight": torch.arange(3 * 4 * 8, dtype=torch.int8).reshape(3 * 4, 8),
            f"{prefix}.qkv.weight_scale": torch.arange(3 * 4, dtype=torch.float32).reshape(3 * 4, 1),
            f"{prefix}.qkv.comfy_quant": _marker_blob(MARKER),
            # `x_embedder.` is what makes the loader run this conversion at all.
            "x_embedder.weight": torch.zeros(2, 2),
        }
        out = _convert_z_image_gguf_to_diffusers(sd)

        for target in ("to_q", "to_k", "to_v"):
            assert f"{prefix}.{target}.weight" in out
            assert f"{prefix}.{target}.weight_scale" in out
            assert f"{prefix}.{target}.comfy_quant" in out
        assert not any(".qkv." in k for k in out), "the fused keys must not survive"

    def test_the_markers_are_readable_after_the_conversion(self) -> None:
        """Why Z-Image reads them after converting rather than before: unlike Krea-2's converter,
        this one carries `.comfy_quant` onto the final module names, so no re-keying is needed."""
        prefix = "layers.0.attention"
        sd = {
            f"{prefix}.qkv.weight": torch.zeros(3 * 4, 256, dtype=torch.int8),
            f"{prefix}.qkv.weight_scale": torch.ones(3 * 4, 1),
            f"{prefix}.qkv.comfy_quant": _marker_blob(MARKER),
            "x_embedder.weight": torch.zeros(2, 2),
        }
        markers = extract_int8_convrot_markers(_convert_z_image_gguf_to_diffusers(sd))
        assert set(markers) == {f"{prefix}.to_q", f"{prefix}.to_k", f"{prefix}.to_v"}
        assert all(m == MARKER for m in markers.values())

    def test_a_qkv_weight_that_does_not_divide_by_three_is_refused(self) -> None:
        sd = {"layers.0.attention.qkv.weight": torch.zeros(7, 8), "x_embedder.weight": torch.zeros(2, 2)}
        with pytest.raises(ValueError, match="not divisible by 3"):
            _convert_z_image_gguf_to_diffusers(sd)
