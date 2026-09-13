"""MiniMax H3's int8_tensorwise single-file path, driven through the loader over a real file.

H3 is where this scheme entered the codebase, and it kept its own copy of the call site: the
marker's ``convrot_groupsize`` was never read and the scale layout was never checked. Both are
things a checkpoint can vary and neither fails loudly, so they are pinned here against the loader
rather than against the shared helper they now go through.

The fixture is a real safetensors file because the loader reads the markers twice by two different
routes -- once from the header before committing to the tensor read, once from the tensors -- and
the header route is only exercised by an actual file.
"""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from safetensors.torch import save_file

from invokeai.backend.minimax_h3.transformer_minimax_h3 import MiniMaxH3AttnProcessor
from invokeai.backend.model_manager.configs.main import Main_Checkpoint_MiniMaxH3_Config
from invokeai.backend.model_manager.load.model_loaders.minimax_h3 import MiniMaxH3CheckpointModel
from invokeai.backend.model_manager.load.model_loaders.minimax_h3_state_dict_utils import read_comfy_quant_markers
from invokeai.backend.model_manager.taxonomy import MiniMaxH3VariantType
from invokeai.backend.quantization.int8_convrot import Int8ConvrotLinear, build_regular_hadamard


@pytest.fixture(autouse=True)
def _restore_attention_processor():
    """The loader installs H3's contiguous-QKV attention patch, which rebinds
    `MiniMaxH3AttnProcessor.__call__` for the whole process.

    `test_contiguous_attention.py` compares the patched call against the *unpatched* one, so a
    worker that ran this file first would have it comparing the patch to itself -- passing, and
    checking nothing. Under `--dist loadfile` which file a worker gets is arbitrary, so restore.
    """
    original = MiniMaxH3AttnProcessor.__call__
    was_marked = "_invokeai_contiguous_qkv" in vars(MiniMaxH3AttnProcessor)
    yield
    MiniMaxH3AttnProcessor.__call__ = original
    if not was_marked and "_invokeai_contiguous_qkv" in vars(MiniMaxH3AttnProcessor):
        delattr(MiniMaxH3AttnProcessor, "_invokeai_contiguous_qkv")


# Hidden/inner/ffn all 64 so every quantized in_features is divisible by the 64-wide group the
# marker below declares. Curve grid 5 x 3, one block and one refiner block: the AdaLN-pruned
# layout, whose converted keys are known to match the model exactly.
HIDDEN = INNER = FFN = 64
HEAD_DIM = 32
CURVE_DIM = 3
GROUP_SIZE = 64

QUANTIZED_SOURCE_KEY = "blocks.0.attn.out_proj.weight"
QUANTIZED_MODULE_PATH = ("transformer_blocks", 0, "attn", "to_out", 0)


def _tiny_remote_code_state_dict() -> dict[str, torch.Tensor]:
    """A minimal AdaLN-pruned H3 checkpoint in MiniMax's remote-code key layout."""
    sd: dict[str, torch.Tensor] = {
        "video_patch_proj.weight": torch.randn(HIDDEN, 4),
        "video_patch_proj.bias": torch.randn(HIDDEN),
        "audio_patch_proj.weight": torch.randn(HIDDEN, 4),
        "audio_patch_proj.bias": torch.randn(HIDDEN),
        "condition_proj.weight": torch.randn(HIDDEN, 6),
        "condition_proj.bias": torch.randn(HIDDEN),
        "adaln_t_table": torch.randn(5, CURVE_DIM),
        "rope.inv_freq": torch.randn(2),
        "token_refiner.final_norm.weight": torch.randn(HIDDEN),
        "final_layer.norm.weight": torch.randn(HIDDEN),
        "final_layer.adaln_proj.linear.weight": torch.randn(2 * HIDDEN, CURVE_DIM),
        "final_layer.adaln_proj.linear.bias": torch.randn(2 * HIDDEN),
        "final_layer.video_out.weight": torch.randn(4, HIDDEN),
        "final_layer.video_out.bias": torch.randn(4),
        "final_layer.audio_out.weight": torch.randn(4, HIDDEN),
        "final_layer.audio_out.bias": torch.randn(4),
    }
    for prefix in ("token_refiner.blocks.0.", "blocks.0."):
        sd[prefix + "norm1.weight"] = torch.randn(HIDDEN)
        sd[prefix + "norm2.weight"] = torch.randn(HIDDEN)
        sd[prefix + "attn.qkv_proj.weight"] = torch.randn(3 * INNER, HIDDEN)
        sd[prefix + "attn.q_norm.weight"] = torch.randn(HEAD_DIM)
        sd[prefix + "attn.k_norm.weight"] = torch.randn(HEAD_DIM)
        sd[prefix + "attn.out_proj.weight"] = torch.randn(HIDDEN, INNER)
        sd[prefix + "mlp.fc1.weight"] = torch.randn(2 * FFN, HIDDEN)
        sd[prefix + "mlp.fc2.weight"] = torch.randn(HIDDEN, FFN)
    sd["blocks.0.adaln_proj.linear.weight"] = torch.randn(6 * HIDDEN * 3, CURVE_DIM)
    sd["blocks.0.adaln_proj.linear.bias"] = torch.randn(6 * HIDDEN * 3)
    return sd


def _quantize_convrot(weight: torch.Tensor, group_size: int) -> tuple[torch.Tensor, torch.Tensor]:
    """Mirror of comfy-quants: rotate along the input dim in groups, then per-output-channel int8."""
    out_features, in_features = weight.shape
    hadamard = build_regular_hadamard(group_size, dtype=weight.dtype)
    rotated = (weight.view(out_features, in_features // group_size, group_size) @ hadamard.T).view(
        out_features, in_features
    )
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    return torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8), scale.to(torch.float32)


def _marker_blob(marker: dict, *, pad: int = 0) -> torch.Tensor:
    """Comfy pads these to a fixed width with NUL bytes; `pad` reproduces that."""
    raw = json.dumps(marker).encode("utf-8") + b"\x00" * pad
    return torch.frombuffer(bytearray(raw), dtype=torch.uint8).clone()


def _write_checkpoint(
    tmp_path: Path, *, scale: torch.Tensor | None = None, marker: dict | None = None, pad: int = 16
) -> tuple[Path, torch.Tensor]:
    """A tiny pruned H3 checkpoint with `blocks.0.attn.out_proj` quantized; returns its true weight."""
    torch.manual_seed(0)
    sd = _tiny_remote_code_state_dict()
    original = sd[QUANTIZED_SOURCE_KEY]
    quantized, derived_scale = _quantize_convrot(original, GROUP_SIZE)
    sd[QUANTIZED_SOURCE_KEY] = quantized
    sd["blocks.0.attn.out_proj.weight_scale"] = derived_scale if scale is None else scale
    sd["blocks.0.attn.out_proj.comfy_quant"] = _marker_blob(
        marker or {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": GROUP_SIZE}, pad=pad
    )
    path = tmp_path / "minimax_h3_int8_convrot.safetensors"
    save_file(sd, str(path))
    return path, original


def _load(path: Path) -> torch.nn.Module:
    config = Main_Checkpoint_MiniMaxH3_Config.model_construct(
        path=str(path), variant=MiniMaxH3VariantType.FL2VA, pruned=True, name="h3"
    )
    loader = object.__new__(MiniMaxH3CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._logger = MagicMock()
    return loader._load_transformer_from_singlefile(config)


def _quantized_module(model: torch.nn.Module) -> torch.nn.Module:
    module: torch.nn.Module = model
    for step in QUANTIZED_MODULE_PATH:
        module = module[step] if isinstance(step, int) else getattr(module, step)
    return module


def test_the_marker_group_size_reaches_the_module(tmp_path) -> None:
    """The rotation width is per tensor, and H3 assumed it. A 64-wide repack derotated with a
    256-wide Hadamard is not a subtle error -- the shapes do not even divide -- but a producer
    varying it the other way (a wider group on a wide layer) would run and generate noise."""
    path, original = _write_checkpoint(tmp_path)

    model = _load(path)

    module = _quantized_module(model)
    assert isinstance(module, Int8ConvrotLinear)
    assert module.group_size == GROUP_SIZE
    # And the weight it computes is the un-rotated original, not the still-rotated one.
    dequantized = module._dequantized_weight(torch.device("cpu"), torch.float32).flatten()
    assert torch.corrcoef(torch.stack([dequantized, original.flatten()]))[0, 1] > 0.999


def test_a_blockwise_scale_grid_is_refused_by_name(tmp_path) -> None:
    """H3 constructed its modules without the scale-layout check, so a block grid broadcast
    against the weight instead of raising: for a square weight that is silent."""
    path, _ = _write_checkpoint(tmp_path, scale=torch.ones(HIDDEN // 8, INNER // 8))

    with pytest.raises(ValueError, match=r"Blockwise scale grids"):
        _load(path)


def test_a_nul_padded_header_marker_is_read(tmp_path) -> None:
    """The header reader runs before the tensor read, so its strict parse was what a padded marker
    actually hit -- a JSONDecodeError out of the middle of a load, naming neither file nor key.
    The tolerant parser the state-dict readers use was written for exactly this."""
    path, _ = _write_checkpoint(tmp_path, pad=16)

    markers = read_comfy_quant_markers(path)

    assert markers == {
        "blocks.0.attn.out_proj": {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": GROUP_SIZE}
    }
