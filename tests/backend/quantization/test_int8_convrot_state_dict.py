"""Tests for the state-dict side of the int8_convrot scheme: which layers a loader picks up,
and which scale layouts it will act on.

The per-tensor mathematics is covered by ``test_int8_convrot.py``. What is pinned here is the
part a loader can get wrong without anything raising — every failure below would otherwise
surface as a model that loads cleanly and generates noise.
"""

import json

import pytest
import torch

from invokeai.backend.quantization.int8_convrot import (
    CONVROT_GROUP_SIZE,
    check_int8_scale_layout,
    extract_int8_convrot_markers,
)

MARKER = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE}


def _marker_blob(marker: dict) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8)


class TestWhichLayersAreClaimed:
    def test_an_int8_marker_is_claimed_and_removed(self) -> None:
        sd = {
            "blocks.0.attn.wq.weight": torch.zeros(4, CONVROT_GROUP_SIZE, dtype=torch.int8),
            "blocks.0.attn.wq.weight_scale": torch.ones(4, 1),
            "blocks.0.attn.wq.comfy_quant": _marker_blob(MARKER),
        }
        markers = extract_int8_convrot_markers(sd)

        assert markers == {"blocks.0.attn.wq": MARKER}
        # The marker is consumed; the weight and its scale stay for the loader to install.
        assert set(sd) == {"blocks.0.attn.wq.weight", "blocks.0.attn.wq.weight_scale"}

    def test_a_marker_for_another_format_is_left_untouched(self) -> None:
        """ComfyUI's fp8_scaled repacks share this key layout and belong to the fp8 path."""
        sd = {
            "layer.weight": torch.zeros(4, 4, dtype=torch.float8_e4m3fn),
            "layer.weight_scale": torch.ones(1),
            "layer.comfy_quant": _marker_blob({"format": "float8_e4m3fn"}),
        }
        assert extract_int8_convrot_markers(sd) == {}
        assert "layer.comfy_quant" in sd

    def test_unmarked_weights_are_not_claimed(self) -> None:
        """Mixed precision is the norm, not the exception: one Krea-2 build leaves 40 weights in
        bf16 with no marker, and the two Qwen3-VL encoders leave over 200 each. A decision made
        per file rather than per tensor would be wrong on all of them."""
        sd = {
            "txtfusion.0.weight": torch.zeros(8, 8, dtype=torch.bfloat16),
            "blocks.0.attn.wq.weight": torch.zeros(4, CONVROT_GROUP_SIZE, dtype=torch.int8),
            "blocks.0.attn.wq.weight_scale": torch.ones(4, 1),
            "blocks.0.attn.wq.comfy_quant": _marker_blob(MARKER),
        }
        assert set(extract_int8_convrot_markers(sd)) == {"blocks.0.attn.wq"}

    def test_a_state_dict_with_no_markers_is_unchanged(self) -> None:
        sd = {"a.weight": torch.zeros(2, 2)}
        assert extract_int8_convrot_markers(sd) == {}
        assert set(sd) == {"a.weight"}

    def test_the_group_size_travels_with_each_marker(self) -> None:
        """Every marker in the Krea-2 build says 256, but the flag is per tensor and another
        producer may vary it, so it is read rather than assumed."""
        sd = {"layer.comfy_quant": _marker_blob({"format": "int8_tensorwise", "convrot_groupsize": 64})}
        assert extract_int8_convrot_markers(sd)["layer"]["convrot_groupsize"] == 64


class TestTheScaleLayoutsSeenInRealCheckpoints:
    """Three appear across the checkpoints this was tested against, so none is hypothetical."""

    def test_per_output_channel(self) -> None:
        check_int8_scale_layout("layer", torch.zeros(64, 256, dtype=torch.int8), torch.ones(64, 1))

    def test_per_output_channel_without_the_trailing_axis(self) -> None:
        check_int8_scale_layout("layer", torch.zeros(64, 256, dtype=torch.int8), torch.ones(64))

    def test_a_scalar_scale(self) -> None:
        """One Qwen3-VL encoder stores every scale as a bare scalar, and Krea-2's
        `txtfusion.projector` does the same."""
        check_int8_scale_layout("layer", torch.zeros(1, 12, dtype=torch.int8), torch.tensor(0.01))

    def test_a_blockwise_grid_is_refused_by_name(self) -> None:
        """Also observed: a 6144x6144 weight with a [48, 48] scale, i.e. a 128x128 block grid.
        Broadcasting would either raise somewhere uninformative or, for an unlucky shape,
        silently scale the wrong axis."""
        with pytest.raises(ValueError, match=r"Blockwise scale grids"):
            check_int8_scale_layout("last.up", torch.zeros(512, 512, dtype=torch.int8), torch.ones(4, 4))

    def test_the_message_names_the_layer_and_both_shapes(self) -> None:
        with pytest.raises(ValueError, match=r"'last\.up' has a \(4, 4\) scale for a \(512, 512\) weight"):
            check_int8_scale_layout("last.up", torch.zeros(512, 512, dtype=torch.int8), torch.ones(4, 4))
