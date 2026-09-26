"""What the released MXFP8 Krea-2 build actually contains, and whether the synthetic payload matches.

The MXFP8 decode is built on four assumptions about the file: the scale is `uint8`, it carries one
entry per 32 weight elements, it is a whole number of cuBLAS tiles, and the layer says `mxfp8`
somewhere. Until this capture all four rested on the same synthetic construction that the tests
build, so the tests and the decode agreed without either being checked against a producer.

This is the one reachable MXFP8 file, and its weights cannot be checked in (`license: other`), so the
captured header is the reference and `mxfp8_tensors` is measured against it.
"""

import torch

from invokeai.backend.quantization.block_scale_tiles import check_tile_layout
from invokeai.backend.quantization.fp8_scaled import MXFP8_FORMAT, extract_fp8_scaled_layers
from tests.backend.model_manager.load.state_dicts import krea2_turbo_mxfp8_keys as fixture
from tests.fixtures.quantized_payloads import MX_BLOCK_SIZE, mxfp8_tensors

KEYS = fixture.state_dict_keys
QUANTIZED = sorted(
    key[: -len(".weight")] for key, (_shape, dtype) in KEYS.items() if dtype == "F8_E4M3" and key.endswith(".weight")
)


def test_every_grid_is_one_uint8_entry_per_thirty_two_weight_elements() -> None:
    """The block width the decode derives from the shapes. A build that changed it would be decoded
    at the wrong granularity -- and `expand_weight_scale` would still widen the grid to the weight,
    so it would load and generate noise rather than raise."""
    assert QUANTIZED
    for path in QUANTIZED:
        (rows, columns), _dtype = KEYS[f"{path}.weight"]
        (scale_rows, blocks), scale_dtype = KEYS[f"{path}.weight_scale"]

        assert scale_dtype == "U8", path
        assert scale_rows == rows, path
        assert columns == blocks * MX_BLOCK_SIZE, path


def test_every_grid_is_a_whole_number_of_cublas_tiles() -> None:
    """`check_tile_layout` is what the de-swizzle requires, and off-tile it cannot be expressed --
    so this is the property that decides whether the released file is decodable at all."""
    for path in QUANTIZED:
        (rows, _columns), _dtype = KEYS[f"{path}.weight"]
        (_scale_rows, blocks), _scale_dtype = KEYS[f"{path}.weight_scale"]

        check_tile_layout(rows, blocks)


def test_the_header_names_every_quantized_layer_and_no_marker_does() -> None:
    """One transport, not two: the header names them and there is no `.comfy_quant` in the file.

    The decode refuses a `uint8` grid that nothing names, so for this build the header *is* the
    evidence -- a re-upload that dropped `_quantization_metadata` would make the file unloadable
    rather than mis-loaded, and this is the cell that would say why.
    """
    assert set(fixture.layer_hints) == set(QUANTIZED)
    assert {hint["format"] for hint in fixture.layer_hints.values()} == {MXFP8_FORMAT}
    assert not any(key.endswith(".comfy_quant") for key in KEYS)


def test_no_hint_carries_a_block_size() -> None:
    """Which is why the decode reads the width from the shapes and lets the marker only cross-check
    it. A decode that required the field would refuse this build outright."""
    assert not any("block_size" in hint for hint in fixture.layer_hints.values())


def test_the_synthetic_payload_has_the_released_layouts_shape_relationship() -> None:
    """The synthetic builder is what every MXFP8 cell drives; this is the one place it is held
    against a producer.

    Same relationship, not the same size: one real layer here is 6144x6144 with a 6144x192 grid, and
    building that costs 36M elements to assert a ratio. So the ratio, the dtypes and the tile
    condition are checked on a small layer, and the real numbers are read from the capture.
    """
    # One tile, all exponents 127. The released layers are 6144 wide with a 6144x192 grid; building
    # that would cost 36M elements to assert a ratio the capture already records exactly.
    tensors, expected = mxfp8_tensors("lin", torch.full((128, 4), 127))
    weight, scale = tensors["lin.weight"], tensors["lin.weight_scale"]

    assert weight.dtype is torch.float8_e4m3fn
    assert scale.dtype is torch.uint8
    assert weight.shape[1] == scale.shape[1] * MX_BLOCK_SIZE
    assert weight.shape[0] == scale.shape[0]
    # 127 is `2**0`: the value that makes a fold-as-multiplier off by ~127x instead of by nothing.
    assert torch.equal(expected, torch.ones_like(expected))

    layers = extract_fp8_scaled_layers(dict(tensors), layer_hints={"lin": {"format": MXFP8_FORMAT}})

    assert torch.equal(layers["lin"].weight_scale, expected)
