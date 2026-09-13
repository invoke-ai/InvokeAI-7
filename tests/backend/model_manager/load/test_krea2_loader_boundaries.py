from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.model_manager.configs.main import (
    Main_Checkpoint_Krea2_Config,
    Main_Diffusers_Krea2_Config,
    Main_GGUF_Krea2_Config,
)
from invokeai.backend.model_manager.configs.qwen3_vl_encoder import (
    Qwen3VLEncoder_Checkpoint_Config,
    Qwen3VLEncoder_Qwen3VLEncoder_Config,
)
from invokeai.backend.model_manager.load.model_loaders.krea2 import (
    Krea2CheckpointModel,
    Krea2DiffusersModel,
    Krea2GGUFCheckpointModel,
    Qwen3VLEncoderCheckpointLoader,
    Qwen3VLEncoderLoader,
)
from invokeai.backend.model_manager.taxonomy import Krea2VariantType, SubModelType
from invokeai.backend.quantization.int8_convrot import Int8ConvrotLinear


class _TinyKrea2Transformer(torch.nn.Module):
    def __init__(self, **_kwargs) -> None:
        super().__init__()
        self.weight = torch.nn.Parameter(torch.empty(2, 2))


def test_single_file_loader_constructs_and_materializes_model(monkeypatch, tmp_path) -> None:
    import diffusers
    import safetensors.torch

    checkpoint_path = tmp_path / "krea2.safetensors"
    checkpoint_path.touch()
    config = Main_Checkpoint_Krea2_Config.model_construct(
        path=str(checkpoint_path), variant=Krea2VariantType.Turbo, fp8_storage=None
    )
    ram_cache = SimpleNamespace(make_room=MagicMock())
    loader = object.__new__(Krea2CheckpointModel)
    loader._ram_cache = ram_cache
    # ModelLoader.__init__ always sets a logger; this test bypasses __init__, so supply one.
    loader._logger = MagicMock()
    loader._apply_fp8_layerwise_casting = lambda model, _config, _submodel: model

    monkeypatch.setattr(diffusers, "Krea2Transformer2DModel", _TinyKrea2Transformer, raising=False)
    monkeypatch.setattr(safetensors.torch, "load_file", lambda _path: {"weight": torch.ones(2, 2)})
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_from_singlefile(config)

    assert isinstance(model, _TinyKrea2Transformer)
    assert model.weight.device.type == "cpu"
    assert torch.equal(model.weight, torch.ones(2, 2))
    ram_cache.make_room.assert_called_once()


def test_single_file_loader_decodes_an_int8_convrot_checkpoint(monkeypatch, tmp_path) -> None:
    """The decode has to be *wired in*, not merely available.

    Every other test of this feature exercises the helpers directly, so deleting the call from
    `_load_from_singlefile` would leave them all green while the loader silently produced a
    scaled-but-still-rotated model. This one drives the loader itself and checks the weight that
    actually reaches the module.
    """
    import json

    import diffusers
    import safetensors.torch

    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, build_regular_hadamard

    torch.manual_seed(0)
    original = torch.randn(4, CONVROT_GROUP_SIZE)
    hadamard = build_regular_hadamard(CONVROT_GROUP_SIZE)
    rotated = (original.view(4, 1, CONVROT_GROUP_SIZE) @ hadamard.T).view(4, CONVROT_GROUP_SIZE)
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    marker = json.dumps({"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE})
    # A marker is always `<layer>.comfy_quant`; a quantized weight is a submodule's, never the
    # model's own, so the fixture mirrors that.
    state_dict = {
        "proj.weight": torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8),
        "proj.weight_scale": scale.to(torch.float32),
        "proj.comfy_quant": torch.frombuffer(bytearray(marker.encode("utf-8")), dtype=torch.uint8),
    }

    class _TinyInt8Krea2Transformer(torch.nn.Module):
        def __init__(self, **_kwargs) -> None:
            super().__init__()
            self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)
            self.dense = torch.nn.Linear(8, 4, bias=False)

    # An unquantized neighbour, stored narrower than the compute dtype, so the reservation below
    # has to get three widths right rather than one.
    state_dict["dense.weight"] = torch.ones(4, 8, dtype=torch.float16)

    checkpoint_path = tmp_path / "krea2_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Main_Checkpoint_Krea2_Config.model_construct(
        path=str(checkpoint_path), variant=Krea2VariantType.Turbo, fp8_storage=None
    )
    loader = object.__new__(Krea2CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._logger = MagicMock()
    loader._apply_fp8_layerwise_casting = lambda model, _config, _submodel: model

    monkeypatch.setattr(diffusers, "Krea2Transformer2DModel", _TinyInt8Krea2Transformer, raising=False)
    monkeypatch.setattr(safetensors.torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_from_singlefile(config)

    # The reservation must be what the load actually occupies, counted by hand rather than by the
    # function under test: the int8 weight at one byte (charging it the compute dtype's width asked
    # the cache to free twice what this load needs, evicting other models for room nobody used),
    # its scale at the fp32 it is pinned at, and the dense fp16 neighbour at the compute width it
    # is cast to. Summing `state_dict` instead would be summing the wrong object -- the loader
    # rebinds `sd` at `drop_unconsumed_quantization_sidecars` and mutates the copy.
    (reserved,), _ = loader._ram_cache.make_room.call_args
    assert reserved == 4 * CONVROT_GROUP_SIZE * 1 + 4 * 1 * 4 + 4 * 8 * torch.float32.itemsize

    # This is also what pins the one-or-the-other split in the loader: the fixture's int8 weight
    # carries a `.weight_scale`, which is exactly what an fp8 scaled layer looks like from outside.
    # Route it down the fp8 path and it is scaled but never un-rotated -- `load_state_dict` then
    # refuses the still-int8 tensor, and failing that the correlation below does. (Verified by
    # forcing the branch: the test fails.)
    #
    # The weight stays quantized: that is the whole point of the swap, and it is what keeps a
    # 12 GB checkpoint at 12 GB instead of the ~24 GB a dense decode would produce.
    assert isinstance(model.proj, Int8ConvrotLinear)
    assert model.proj.weight.dtype is torch.int8

    # And it still computes the un-rotated weight, which the fp8 path alone would never produce.
    dequantized = model.proj._dequantized_weight(torch.device("cpu"), torch.float32).flatten()
    assert torch.corrcoef(torch.stack([dequantized, original.flatten()]))[0, 1] > 0.999
    assert torch.corrcoef(torch.stack([dequantized, rotated.flatten()]))[0, 1].abs() < 0.2


def test_diffusers_loader_reaches_transformer_from_pretrained(monkeypatch, tmp_path) -> None:
    config = Main_Diffusers_Krea2_Config.model_construct(path=str(tmp_path), repo_variant=None)
    loader = object.__new__(Krea2DiffusersModel)
    loaded_model = object()
    load_class = SimpleNamespace(from_pretrained=MagicMock(return_value=loaded_model))
    loader.get_hf_load_class = lambda _path, _submodel: load_class
    loader._apply_fp8_layerwise_casting = lambda model, _config, _submodel: model
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_model(config, SubModelType.Transformer)

    assert model is loaded_model
    load_class.from_pretrained.assert_called_once_with(
        tmp_path / "transformer", torch_dtype=torch.float32, variant=None
    )


def test_gguf_loader_constructs_and_materializes_model(monkeypatch, tmp_path) -> None:
    import diffusers

    checkpoint_path = tmp_path / "krea2.gguf"
    checkpoint_path.touch()
    config = Main_GGUF_Krea2_Config.model_construct(path=str(checkpoint_path), variant=Krea2VariantType.Turbo)
    loader = object.__new__(Krea2GGUFCheckpointModel)

    monkeypatch.setattr(diffusers, "Krea2Transformer2DModel", _TinyKrea2Transformer, raising=False)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.gguf_sd_loader",
        lambda _path, *, compute_dtype: {"weight": torch.ones(2, 2, dtype=compute_dtype)},
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_from_gguf(config)

    assert isinstance(model, _TinyKrea2Transformer)
    assert model.weight.device.type == "cpu"
    assert torch.equal(model.weight, torch.ones(2, 2))


def test_checkpoint_encoder_loader_decodes_int8_and_does_not_call_it_fp8(monkeypatch, tmp_path) -> None:
    """The encoder path carries the same hazard as the transformer, plus one of its own.

    `source_is_fp8` answers yes to any `.weight_scale` key. Left to itself an int8 encoder would
    be scaled, never un-rotated, and then kept "fp8-resident" over weights that were never fp8.
    Decoding first removes the int8 scales, so the detection sees what it was written to see.
    """
    import json

    import transformers
    from safetensors import torch as safetensors_torch

    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, build_regular_hadamard

    torch.manual_seed(0)
    original = torch.randn(4, CONVROT_GROUP_SIZE)
    hadamard = build_regular_hadamard(CONVROT_GROUP_SIZE)
    rotated = (original.view(4, 1, CONVROT_GROUP_SIZE) @ hadamard.T).view(4, CONVROT_GROUP_SIZE)
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    marker = json.dumps({"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE})
    state_dict = {
        "proj.weight": torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8),
        "proj.weight_scale": scale.to(torch.float32),
        "proj.comfy_quant": torch.frombuffer(bytearray(marker.encode("utf-8")), dtype=torch.uint8),
    }

    class _TinyLanguageModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)

    class _TinyEncoder(torch.nn.Module):
        """`_remap_qwen3vl_singlefile_keys` routes bare keys under `language_model.`, so the
        fixture keeps the checkpoint's spelling and lets the remap do its job."""

        def __init__(self) -> None:
            super().__init__()
            self.language_model = _TinyLanguageModel()

        @classmethod
        def _from_config(cls, _config):
            return cls()

    checkpoint_path = tmp_path / "qwen3vl_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Qwen3VLEncoder_Checkpoint_Config.model_construct(path=str(checkpoint_path), name="encoder")

    fp8_calls: list = []
    loader = object.__new__(Qwen3VLEncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._torch_device = torch.device("cpu")
    loader._logger = MagicMock()
    loader._load_hf_config = lambda: SimpleNamespace()
    loader._apply_fp8_to_nn_module = lambda *a, **k: fp8_calls.append(a)

    monkeypatch.setattr(transformers, "Qwen3VLModel", _TinyEncoder, raising=False)
    monkeypatch.setattr(safetensors_torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2._device_supports_fp8_storage",
        lambda _device, _logger: True,
    )

    model = loader._load_text_encoder(config)

    assert isinstance(model.language_model.proj, Int8ConvrotLinear)
    assert model.language_model.proj.weight.dtype is torch.int8
    dequantized = model.language_model.proj._dequantized_weight(torch.device("cpu"), torch.float32).flatten()
    assert torch.corrcoef(torch.stack([dequantized, original.flatten()]))[0, 1] > 0.999
    assert fp8_calls == [], "an int8 encoder must not be treated as an fp8 one"


def test_directory_encoder_loader_reaches_transformers_from_pretrained(monkeypatch, tmp_path) -> None:
    import transformers

    (tmp_path / "config.json").write_text("{}")
    config = Qwen3VLEncoder_Qwen3VLEncoder_Config.model_construct(path=str(tmp_path))
    loader = object.__new__(Qwen3VLEncoderLoader)
    text_config = SimpleNamespace(rope_parameters={"rope_type": "default"}, rope_scaling=None)
    encoder_config = SimpleNamespace(text_config=text_config)
    loaded_model = object()
    from_pretrained = MagicMock(return_value=loaded_model)

    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.AutoConfig.from_pretrained",
        lambda *_args, **_kwargs: encoder_config,
    )
    monkeypatch.setattr(transformers.Qwen3VLModel, "from_pretrained", from_pretrained)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_model(config, SubModelType.TextEncoder)

    assert model is loaded_model
    assert text_config.rope_scaling == text_config.rope_parameters
    from_pretrained.assert_called_once_with(
        tmp_path,
        config=encoder_config,
        torch_dtype=torch.float32,
        low_cpu_mem_usage=True,
        local_files_only=True,
    )


def test_directory_encoder_loader_estimates_standalone_root_weights(tmp_path) -> None:
    (tmp_path / "config.json").write_text("{}")
    weight_size = 4096
    (tmp_path / "model.safetensors").write_bytes(b"\0" * weight_size)
    config = Qwen3VLEncoder_Qwen3VLEncoder_Config.model_construct(path=str(tmp_path))
    loader = object.__new__(Qwen3VLEncoderLoader)

    estimated_size = loader.get_size_fs(config, tmp_path, SubModelType.TextEncoder)

    assert estimated_size == weight_size


def test_an_int8_weight_without_a_marker_is_refused(monkeypatch, tmp_path) -> None:
    """A weight the markers do not claim would be cast to the compute dtype as raw int8 codes.

    Unscaled and un-derotated, into a model that loads clean and generates noise. Z-Image has always
    refused this; Krea-2 accepted it silently, and `parse_comfy_quant_marker` being tolerant makes
    the case reachable through a marker that merely fails to parse.
    """
    import json

    import diffusers
    import safetensors.torch

    class _TinyInt8Krea2Transformer(torch.nn.Module):
        def __init__(self, **_kwargs) -> None:
            super().__init__()
            self.marked = torch.nn.Linear(8, 8, bias=False)
            self.unmarked = torch.nn.Linear(8, 8, bias=False)

    marker = json.dumps({"format": "int8_tensorwise", "convrot": False})
    state_dict = {
        "marked.weight": torch.zeros(8, 8, dtype=torch.int8),
        "marked.weight_scale": torch.ones(8, 1, dtype=torch.float32),
        "marked.comfy_quant": torch.frombuffer(bytearray(marker.encode("utf-8")), dtype=torch.uint8),
        # No marker at all: the orphan.
        "unmarked.weight": torch.zeros(8, 8, dtype=torch.int8),
    }

    checkpoint_path = tmp_path / "krea2_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Main_Checkpoint_Krea2_Config.model_construct(
        path=str(checkpoint_path), variant=Krea2VariantType.Turbo, fp8_storage=None
    )
    loader = object.__new__(Krea2CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._logger = MagicMock()

    monkeypatch.setattr(diffusers, "Krea2Transformer2DModel", _TinyInt8Krea2Transformer, raising=False)
    monkeypatch.setattr(safetensors.torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    with pytest.raises(ValueError) as excinfo:
        loader._load_from_singlefile(config)

    assert "unmarked.weight" in str(excinfo.value)


def _int8_convrot_pair(weight: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Mirror of comfy-quants: rotate along the input dim, then per-output-channel int8."""
    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, build_regular_hadamard

    out_features, in_features = weight.shape
    hadamard = build_regular_hadamard(CONVROT_GROUP_SIZE, dtype=weight.dtype)
    rotated = (weight.view(out_features, in_features // CONVROT_GROUP_SIZE, CONVROT_GROUP_SIZE) @ hadamard.T).view(
        out_features, in_features
    )
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    return torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8), scale.to(torch.float32)


def _int8_marker_blob(**overrides) -> torch.Tensor:
    import json

    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE

    marker = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE, **overrides}
    return torch.frombuffer(bytearray(json.dumps(marker).encode("utf-8")), dtype=torch.uint8).clone()


def _int8_transformer_driver(monkeypatch, tmp_path, model_class, state_dict):
    import diffusers
    import safetensors.torch

    checkpoint_path = tmp_path / "krea2_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Main_Checkpoint_Krea2_Config.model_construct(
        path=str(checkpoint_path), variant=Krea2VariantType.Turbo, fp8_storage=None
    )
    loader = object.__new__(Krea2CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._logger = MagicMock()
    loader._apply_fp8_layerwise_casting = lambda model, _config, _submodel: model

    monkeypatch.setattr(diffusers, "Krea2Transformer2DModel", model_class, raising=False)
    monkeypatch.setattr(safetensors.torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )
    return loader, config


def test_a_precision_sensitive_layer_is_not_left_int8(monkeypatch, tmp_path) -> None:
    """Krea-2 declares `time_embed` (and the norms), and `time_embed.linear_1/linear_2` are
    ordinary quantized Linears in a ComfyUI export. The fp8 branch has always dequantized those;
    the int8 branch never consulted the list, so they stayed int8 and reported `torch.int8` as
    their weight dtype to anything that reads it."""
    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE

    class _TinyKrea2WithTimeEmbed(torch.nn.Module):
        _skip_layerwise_casting_patterns = ["time_embed", "norm"]

        def __init__(self, **_kwargs) -> None:
            super().__init__()
            self.time_embed = torch.nn.Module()
            self.time_embed.linear_1 = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)
            self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)

    torch.manual_seed(5)
    sensitive = torch.randn(4, CONVROT_GROUP_SIZE)
    sensitive_q, sensitive_scale = _int8_convrot_pair(sensitive)
    ordinary_q, ordinary_scale = _int8_convrot_pair(torch.randn(4, CONVROT_GROUP_SIZE))
    state_dict = {
        "time_embed.linear_1.weight": sensitive_q,
        "time_embed.linear_1.weight_scale": sensitive_scale,
        "time_embed.linear_1.comfy_quant": _int8_marker_blob(),
        "proj.weight": ordinary_q,
        "proj.weight_scale": ordinary_scale,
        "proj.comfy_quant": _int8_marker_blob(),
    }
    loader, config = _int8_transformer_driver(monkeypatch, tmp_path, _TinyKrea2WithTimeEmbed, state_dict)

    model = loader._load_from_singlefile(config)

    assert not isinstance(model.time_embed.linear_1, Int8ConvrotLinear)
    assert model.time_embed.linear_1.weight.dtype is torch.float32
    assert torch.corrcoef(torch.stack([model.time_embed.linear_1.weight.flatten(), sensitive.flatten()]))[0, 1] > 0.999
    assert isinstance(model.proj, Int8ConvrotLinear)
    assert model.proj.weight.dtype is torch.int8


def test_a_checkpoint_mixing_int8_and_fp8_is_refused(monkeypatch, tmp_path) -> None:
    """The int8 branch skips the whole fp8 pipeline, so a layer belonging to the other scheme is
    cast to the compute dtype without its scale while its orphaned `weight_scale` is swallowed by
    `strict=False`. With a scale of 4.0 that weight loads a factor 4 low, in silence. The
    "a checkpoint carries one format or the other" premise was documented and never enforced."""
    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE

    class _TinyMixedKrea2(torch.nn.Module):
        def __init__(self, **_kwargs) -> None:
            super().__init__()
            self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)
            self.fp8_proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)

    torch.manual_seed(6)
    quantized, scale = _int8_convrot_pair(torch.randn(4, CONVROT_GROUP_SIZE))
    state_dict = {
        "proj.weight": quantized,
        "proj.weight_scale": scale,
        "proj.comfy_quant": _int8_marker_blob(),
        "fp8_proj.weight": torch.ones(4, CONVROT_GROUP_SIZE).to(torch.float8_e4m3fn),
        "fp8_proj.weight_scale": torch.tensor(4.0),
        "fp8_proj.comfy_quant": torch.frombuffer(bytearray(b'{"format": "float8_e4m3fn"}'), dtype=torch.uint8).clone(),
    }
    loader, config = _int8_transformer_driver(monkeypatch, tmp_path, _TinyMixedKrea2, state_dict)

    with pytest.raises(ValueError, match=r"weight scale\(s\) that no `int8_tensorwise` marker claims"):
        loader._load_from_singlefile(config)


def test_the_encoder_names_itself_when_refusing_an_unmarked_int8_weight(monkeypatch, tmp_path) -> None:
    """The refusal quoted "Krea-2" and `model.layers.*` keys for an encoder file -- an architecture
    the message names and keys that do not exist in a transformer, pointing at the wrong file."""
    import transformers
    from safetensors import torch as safetensors_torch

    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE

    state_dict = {"model.layers.0.self_attn.q_proj.weight": torch.zeros(4, CONVROT_GROUP_SIZE, dtype=torch.int8)}

    class _TinyEncoder(torch.nn.Module):
        @classmethod
        def _from_config(cls, _config):
            return cls()

    checkpoint_path = tmp_path / "qwen3vl_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Qwen3VLEncoder_Checkpoint_Config.model_construct(path=str(checkpoint_path), name="encoder")

    loader = object.__new__(Qwen3VLEncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._torch_device = torch.device("cpu")
    loader._logger = MagicMock()
    loader._load_hf_config = lambda: SimpleNamespace()

    monkeypatch.setattr(transformers, "Qwen3VLModel", _TinyEncoder, raising=False)
    monkeypatch.setattr(safetensors_torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    with pytest.raises(ValueError, match=r"Qwen3-VL encoder checkpoint has 1 int8 weight\(s\)"):
        loader._load_text_encoder(config)


@pytest.mark.parametrize("bundled_dtype", [torch.bfloat16, torch.float8_e4m3fn], ids=["dense", "scaled-fp8"])
def test_a_merged_encoder_checkpoint_is_not_mistaken_for_a_mixed_format_one(
    monkeypatch, tmp_path, bundled_dtype
) -> None:
    """These loaders do not prefix-filter the state dict, so a merged single file's bundled
    submodel is in `sd` too and `strict=False` is what discards it. The mixed-format refusal has to
    key on a weight *this model consumes*, not on any stray key that ends in a scale.

    The `scaled-fp8` case is the one an all-in-one ComfyUI export actually produces: an int8
    transformer beside an fp8 text encoder. Those keys are never loaded, so they cannot load
    unscaled -- refusing them would fail a checkpoint that works."""
    import json

    import transformers
    from safetensors import torch as safetensors_torch

    from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, build_regular_hadamard

    torch.manual_seed(7)
    original = torch.randn(4, CONVROT_GROUP_SIZE)
    hadamard = build_regular_hadamard(CONVROT_GROUP_SIZE)
    rotated = (original.view(4, 1, CONVROT_GROUP_SIZE) @ hadamard.T).view(4, CONVROT_GROUP_SIZE)
    scale = rotated.abs().amax(dim=1, keepdim=True) / 127.0
    marker = json.dumps({"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": CONVROT_GROUP_SIZE})
    state_dict = {
        "proj.weight": torch.clamp(torch.round(rotated / scale), -128, 127).to(torch.int8),
        "proj.weight_scale": scale.to(torch.float32),
        "proj.comfy_quant": torch.frombuffer(bytearray(marker.encode("utf-8")), dtype=torch.uint8).clone(),
        # A bundled submodel: not this model's, discarded by `strict=False`, and not a reason to
        # refuse -- whether it is dense or carries a quantization scheme of its own.
        "bundled.block.weight": torch.ones(4, 4).to(bundled_dtype),
        "bundled.block.weight_scale": torch.ones(4, 1),
    }

    class _TinyLanguageModel(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 4, bias=False)

    class _TinyEncoder(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.language_model = _TinyLanguageModel()

        @classmethod
        def _from_config(cls, _config):
            return cls()

    checkpoint_path = tmp_path / "qwen3vl_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Qwen3VLEncoder_Checkpoint_Config.model_construct(path=str(checkpoint_path), name="encoder")

    loader = object.__new__(Qwen3VLEncoderCheckpointLoader)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
    loader._torch_device = torch.device("cpu")
    loader._logger = MagicMock()
    loader._load_hf_config = lambda: SimpleNamespace()
    loader._apply_fp8_to_nn_module = lambda *a, **k: None

    monkeypatch.setattr(transformers, "Qwen3VLModel", _TinyEncoder, raising=False)
    monkeypatch.setattr(safetensors_torch, "load_file", lambda _path: state_dict)
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_torch_device",
        lambda: torch.device("cpu"),
    )
    monkeypatch.setattr(
        "invokeai.backend.model_manager.load.model_loaders.krea2.TorchDevice.choose_bfloat16_safe_dtype",
        lambda _device: torch.float32,
    )

    model = loader._load_text_encoder(config)

    assert isinstance(model.language_model.proj, Int8ConvrotLinear)
