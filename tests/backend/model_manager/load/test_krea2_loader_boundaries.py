from types import SimpleNamespace
from unittest.mock import MagicMock

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

    checkpoint_path = tmp_path / "krea2_int8_convrot.safetensors"
    checkpoint_path.touch()
    config = Main_Checkpoint_Krea2_Config.model_construct(
        path=str(checkpoint_path), variant=Krea2VariantType.Turbo, fp8_storage=None
    )
    loader = object.__new__(Krea2CheckpointModel)
    loader._ram_cache = SimpleNamespace(make_room=MagicMock())
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
