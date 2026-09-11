"""Loader-level tests for the Z-Image single-file path.

The state-dict helpers are covered elsewhere. What is pinned here is that the loader *calls*
them: deleting the swap would leave every unit test green while the loader produced a model that
loads cleanly and generates noise. These drive `_load_from_singlefile` itself and check what
reaches the module.
"""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.model_manager.configs.main import Main_Checkpoint_ZImage_Config
from invokeai.backend.model_manager.load.model_loaders.z_image import ZImageCheckpointModel
from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, Int8ConvrotLinear, build_regular_hadamard

MARKER = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE}


def _marker_blob(marker: dict) -> torch.Tensor:
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8)


def _quantize_convrot(weight: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Mirror of comfy-quants: rotate along the input dim, then per-output-channel int8."""
    out_f, in_f = weight.shape
    h = build_regular_hadamard(CONVROT_GROUP_SIZE, dtype=weight.dtype)
    rotated = (weight.view(out_f, in_f // CONVROT_GROUP_SIZE, CONVROT_GROUP_SIZE) @ h.T).view(out_f, in_f)
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    return torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8), scale.to(torch.float32)


class _TinyBlock(torch.nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)


class _TinyZImage(torch.nn.Module):
    """Stands in for ZImageTransformer2DModel. `layers.` is one of the loader's valid prefixes,
    so the state dict survives its filter."""

    def __init__(self, **_kwargs) -> None:
        super().__init__()
        self.layers = torch.nn.ModuleList([_TinyBlock()])


def _driver(monkeypatch, tmp_path, state_dict: dict) -> tuple[ZImageCheckpointModel, Main_Checkpoint_ZImage_Config]:
    import diffusers
    from safetensors import torch as safetensors_torch

    checkpoint = tmp_path / "z_image_int8_convrot.safetensors"
    checkpoint.touch()
    config = Main_Checkpoint_ZImage_Config.model_construct(path=str(checkpoint), name="z-image")

    loader = object.__new__(ZImageCheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._logger = MagicMock()
    loader._torch_device = torch.device("cpu")
    loader._torch_dtype = torch.float32
    loader._apply_fp8_layerwise_casting = lambda model, _config, _submodel: model

    monkeypatch.setattr(diffusers, "ZImageTransformer2DModel", _TinyZImage, raising=False)
    monkeypatch.setattr(safetensors_torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.z_image.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.z_image.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )
    return loader, config


def test_an_int8_checkpoint_loads_int8_resident_and_un_rotated(monkeypatch, tmp_path) -> None:
    torch.manual_seed(0)
    original = torch.randn(4, CONVROT_GROUP_SIZE)
    quantized, scale = _quantize_convrot(original)
    state_dict = {
        "layers.0.proj.weight": quantized,
        "layers.0.proj.weight_scale": scale,
        "layers.0.proj.comfy_quant": _marker_blob(MARKER),
    }
    loader, config = _driver(monkeypatch, tmp_path, state_dict)

    model = loader._load_from_singlefile(config)

    # Resident, not decoded: that is what keeps a 5.8 GB checkpoint at 5.8 GB.
    assert isinstance(model.layers[0].proj, Int8ConvrotLinear)
    assert model.layers[0].proj.weight.dtype is torch.int8

    dequantized = model.layers[0].proj._dequantized_weight(torch.device("cpu"), torch.float32).flatten()
    assert torch.corrcoef(torch.stack([dequantized, original.flatten()]))[0, 1] > 0.999
    # And specifically not the scaled-but-still-rotated weight, which is what a loader that only
    # applied the scale would produce -- silently.
    rotated = (quantized.float() * scale).flatten()
    assert torch.corrcoef(torch.stack([rotated, original.flatten()]))[0, 1].abs() < 0.2


def test_an_int8_weight_without_a_marker_is_refused(monkeypatch, tmp_path) -> None:
    """A quantized weight the loader does not recognise would be handed to a float Linear and only
    fail at forward time, if at all. Refuse at load, and say which layers."""
    torch.manual_seed(1)
    quantized, scale = _quantize_convrot(torch.randn(4, CONVROT_GROUP_SIZE))
    state_dict = {"layers.0.proj.weight": quantized, "layers.0.proj.weight_scale": scale}
    loader, config = _driver(monkeypatch, tmp_path, state_dict)

    with pytest.raises(ValueError, match=r"int8 weight\(s\) with no `comfy_quant` marker"):
        loader._load_from_singlefile(config)


def test_an_unquantized_checkpoint_is_unaffected(monkeypatch, tmp_path) -> None:
    torch.manual_seed(2)
    weight = torch.randn(4, CONVROT_GROUP_SIZE)
    loader, config = _driver(monkeypatch, tmp_path, {"layers.0.proj.weight": weight})

    model = loader._load_from_singlefile(config)

    assert isinstance(model.layers[0].proj, torch.nn.Linear)
    assert not isinstance(model.layers[0].proj, Int8ConvrotLinear)
    assert torch.equal(model.layers[0].proj.weight, weight)


class _TinyTimestepEmbedder(torch.nn.Module):
    """Z-Image's `t_embedder` in miniature. Its real forward reads `self.mlp[0].weight.dtype` to
    pick the dtype it casts its activations to, which is why the model declares it
    precision-sensitive -- and why an `Int8ConvrotLinear` there (weight dtype `torch.int8`,
    `is_floating_point()` False, no `compute_dtype` attribute) sends that branch somewhere the
    model was never meant to run."""

    def __init__(self) -> None:
        super().__init__()
        self.mlp = torch.nn.ModuleList([torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)])


class _TinyZImageWithTimestepEmbedder(_TinyZImage):
    _skip_layerwise_casting_patterns = ["t_embedder", "cap_embedder"]

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.t_embedder = _TinyTimestepEmbedder()


def test_a_precision_sensitive_layer_is_not_left_int8(monkeypatch, tmp_path) -> None:
    """The model's own `_skip_layerwise_casting_patterns` has to be honored on the int8 branch too.
    The fp8 branch always read it; the int8 branch did not, so Z-Image's timestep embedder stayed
    quantized and its forward picked its activation dtype off a `torch.int8` weight."""
    torch.manual_seed(3)
    sensitive = torch.randn(4, CONVROT_GROUP_SIZE)
    ordinary = torch.randn(4, CONVROT_GROUP_SIZE)
    sensitive_q, sensitive_scale = _quantize_convrot(sensitive)
    ordinary_q, ordinary_scale = _quantize_convrot(ordinary)
    state_dict = {
        "t_embedder.mlp.0.weight": sensitive_q,
        "t_embedder.mlp.0.weight_scale": sensitive_scale,
        "t_embedder.mlp.0.comfy_quant": _marker_blob(MARKER),
        "layers.0.proj.weight": ordinary_q,
        "layers.0.proj.weight_scale": ordinary_scale,
        "layers.0.proj.comfy_quant": _marker_blob(MARKER),
    }
    loader, config = _driver(monkeypatch, tmp_path, state_dict)
    import diffusers

    monkeypatch.setattr(diffusers, "ZImageTransformer2DModel", _TinyZImageWithTimestepEmbedder, raising=False)

    model = loader._load_from_singlefile(config)

    embedder_linear = model.t_embedder.mlp[0]
    assert not isinstance(embedder_linear, Int8ConvrotLinear)
    assert embedder_linear.weight.dtype is torch.float32
    # Dequantized *with* its scale and derotation, not merely cast: the whole point of widening it
    # here rather than dropping the marker.
    assert torch.corrcoef(torch.stack([embedder_linear.weight.flatten(), sensitive.flatten()]))[0, 1] > 0.999

    # Everything else still pays the one byte per weight this scheme exists for.
    assert isinstance(model.layers[0].proj, Int8ConvrotLinear)
    assert model.layers[0].proj.weight.dtype is torch.int8

    # And the reservation covers the widened layer at its post-split width, not at one byte.
    (reserved,), _ = loader._ram_cache.make_room.call_args
    assert reserved >= sensitive.nelement() * 4 + ordinary_q.nelement()
