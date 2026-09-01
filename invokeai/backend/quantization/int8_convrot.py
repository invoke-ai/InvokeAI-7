"""Runtime support for Comfy "int8_tensorwise + convrot" quantized linears.

``int8_tensorwise`` is a ComfyUI-wide scheme, not one architecture's format: the same
spelling appears on MiniMax H3 (the first consumer here), Krea-2, and whatever Comfy-Org
publishes next. It therefore lives beside the other schemes in ``backend/quantization``
rather than in an architecture package, so a second architecture costs a call site and not
a second copy of the mathematics.

A quantized linear stores its weight as symmetric per-output-channel int8:

- ``<layer>.weight``: int8 ``[out, in]``
- ``<layer>.weight_scale``: float32 ``[out, 1]``
- ``<layer>.comfy_quant``: a uint8 JSON marker, e.g.
  ``{"format": "int8_tensorwise", "convrot": true, "convrot_groupsize": 256}``

With ``convrot``, the weights were rotated along the input dimension before
quantization: ``W_rot = grouped_256(W) @ H^T`` where ``H`` is the normalized
REGULAR Hadamard matrix built from the 4x4 seed ``[[1,1,1,-1],[1,1,-1,1],
[1,-1,1,1],[-1,1,1,1]]`` by Kronecker powers (sizes are powers of 4) and scaled
by ``1/sqrt(size)``. This ``H`` is symmetric and orthonormal (``H == H.T``,
``H @ H == I``), so recovering the un-rotated weight is the SAME grouped matmul:
``W = grouped_256(W_rot) @ H``. (Semantics verified against
Comfy-Org/comfy-quants and comfy-kitchen ``tensor/int8_utils.py`` — reimplemented
here, not copied.)

Comfy's W8A8 kernels instead rotate activations at runtime and run int8 GEMMs.
We target bf16 compute with int8 *storage*: ``Int8ConvrotLinear`` keeps the int8
weight and scale resident (4.6x smaller than bf16) and materializes the
dequantized, derotated bf16 weight per forward call. The derotation is a
``[out, in/256, 256] @ [256, 256]`` matmul — a rounding error next to the
transformer forward itself — and the transient bf16 weight (<= ~310 MB for H3's
largest layer) has to fit inside the calling node's working-memory reservation.
"""

import json
from typing import Any

import torch
import torch.nn.functional as F

CONVROT_GROUP_SIZE = 256

_HADAMARD_SEED = ((1, 1, 1, -1), (1, 1, -1, 1), (1, -1, 1, 1), (-1, 1, 1, 1))

INT8_TENSORWISE_FORMAT = "int8_tensorwise"


def build_regular_hadamard(size: int, dtype: torch.dtype = torch.float32) -> torch.Tensor:
    """Normalized regular Hadamard matrix of a power-of-4 size (CPU tensor)."""
    if size < 4 or (size & (size - 1)) != 0 or (size.bit_length() - 1) % 2 != 0:
        raise ValueError(f"Regular Hadamard size must be a power of 4, got {size}")
    h4 = torch.tensor(_HADAMARD_SEED, dtype=torch.float64)
    h = h4
    while h.shape[0] < size:
        h = torch.kron(h, h4)
    return (h / (size**0.5)).to(dtype)


def parse_comfy_quant_marker(blob: torch.Tensor) -> dict:
    """Decode a ``<layer>.comfy_quant`` uint8 tensor into its JSON dict."""
    return json.loads(bytes(blob.cpu().numpy().tobytes()).decode("utf-8"))


def dequantize_convrot_weight(
    weight_q: torch.Tensor,
    weight_scale: torch.Tensor,
    convrot: bool,
    dtype: torch.dtype,
    group_size: int = CONVROT_GROUP_SIZE,
) -> torch.Tensor:
    """Recover the bf16/fp16 weight from int8 storage (and undo convrot if applied)."""
    w = weight_q.to(torch.float32) * weight_scale.to(torch.float32)
    if convrot:
        out_features, in_features = w.shape
        if in_features % group_size != 0:
            raise ValueError(f"convrot weight in_features {in_features} not divisible by {group_size}")
        h = build_regular_hadamard(group_size).to(device=w.device)
        w = (w.view(out_features, in_features // group_size, group_size) @ h).view(out_features, in_features)
    return w.to(dtype)


class Int8ConvrotLinear(torch.nn.Module):
    """A linear layer storing Comfy int8_tensorwise(+convrot) weights, dequantized per forward.

    The int8 weight and fp32 scale are registered as PERSISTENT buffers named ``weight`` and
    ``weight_scale`` — exactly the converted checkpoint's key names — so ``load_state_dict``
    consumes the quantized tensors directly and the model cache moves them between devices
    like any other weight. The Hadamard matrix is computed, not loaded (non-persistent).

    The model cache wraps this module as ``CustomInt8ConvrotLinear`` (see
    ``AUTOCAST_MODULE_TYPE_MAPPING``), which enables sidecar LoRA patches and lets a partial
    load leave some int8 buffers on the CPU — ``forward``'s per-call ``.to(device)`` then
    streams them (at half the bf16 byte count) instead of failing outright. Fully-resident
    operation remains the intended regime (~20 GiB free VRAM for H3's pruned transformer);
    streamed layers pay a per-forward PCIe cost, and an unquantized model is still the better
    citizen on small cards.
    """

    def __init__(
        self,
        weight: torch.Tensor,
        weight_scale: torch.Tensor,
        convrot: bool,
        bias: torch.Tensor | None = None,
        group_size: int = CONVROT_GROUP_SIZE,
    ) -> None:
        super().__init__()
        if weight.dtype != torch.int8:
            raise ValueError(f"expected int8 weight, got {weight.dtype}")
        self.out_features, self.in_features = weight.shape
        self.convrot = convrot
        self.group_size = group_size
        self.register_buffer("weight", weight)
        self.register_buffer("weight_scale", weight_scale.to(torch.float32))
        if convrot:
            if self.in_features % group_size != 0:
                raise ValueError(f"convrot weight in_features {self.in_features} not divisible by {group_size}")
            self.register_buffer("hadamard", build_regular_hadamard(group_size), persistent=False)
        else:
            self.hadamard = None
        if bias is not None:
            self.register_buffer("bias", bias)
        else:
            self.bias = None

    def _dequantized_weight(self, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
        # `.to(device)` is a no-op in the intended fully-resident regime; under partial load
        # the model cache may leave these buffers on the CPU, in which case this call streams
        # the int8 weight to the compute device per forward (see the class docstring).
        #
        # Dequant + derotation run directly in the compute dtype: int8 values are exact in
        # bf16/fp16, the scale multiply adds ~0.2% relative rounding vs the ~0.4-0.8% int8
        # quantization floor, and the matmul accumulates fp32 internally. This keeps the
        # per-call transient at ~two weight-sized tensors (~620 MB peak for the fused-SwiGLU
        # fc1 in bf16) instead of tripling through an fp32 intermediate (~1.5 GiB). An fp32
        # compute dtype still gets the exact fp32 path for free.
        w = self.weight.to(device=device, dtype=dtype) * self.weight_scale.to(device=device, dtype=dtype)
        if self.convrot:
            assert self.hadamard is not None
            w = (
                w.view(self.out_features, self.in_features // self.group_size, self.group_size)
                @ self.hadamard.to(device=device, dtype=dtype)
            ).view(self.out_features, self.in_features)
        return w

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weight = self._dequantized_weight(x.device, x.dtype)
        bias = self.bias.to(device=x.device, dtype=x.dtype) if self.bias is not None else None
        return F.linear(x, weight, bias)

    def extra_repr(self) -> str:
        return f"in_features={self.in_features}, out_features={self.out_features}, convrot={self.convrot}"


def extract_int8_convrot_markers(sd: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Pop every ``int8_tensorwise`` marker out of ``sd``, keyed by the layer path it names.

    Markers for other formats are left in place, together with their weights and scales: ComfyUI's
    fp8_scaled repacks share this key layout and belong to the fp8 path. Deciding per marker rather
    than per file is also what keeps mixed-precision checkpoints correct -- one Krea-2 build leaves
    40 weights in bf16 with no marker at all, and both Qwen3-VL encoders leave over 200.

    Use this when the loader intends to keep the weights int8 and swap in
    :class:`Int8ConvrotLinear`, which is what every loader here does.
    """
    markers = {}
    for key in [k for k in sd if isinstance(k, str) and k.endswith(".comfy_quant")]:
        marker = parse_comfy_quant_marker(sd[key])
        if marker.get("format") != INT8_TENSORWISE_FORMAT:
            continue
        markers[key[: -len(".comfy_quant")]] = marker
        del sd[key]
    return markers


def check_int8_scale_layout(path: str, weight: torch.Tensor, scale: torch.Tensor) -> None:
    """Refuse a scale granularity this decode does not implement.

    Two layouts are supported, because they are the two this dequantization is correct for:
    per-output-channel (``[out, 1]`` or ``[out]``) and per-tensor (a scalar). Some repacks emit a
    blockwise grid instead - a 6144x6144 weight with a ``[48, 48]`` scale is a 128x128 block grid -
    which needs a different multiply. Left to broadcasting that either raises somewhere less
    informative or, for an unlucky shape, silently scales the wrong axis.
    """
    rows = weight.shape[0] if weight.dim() else 1
    if scale.dim() == 0 or tuple(scale.shape) in {(1,), (1, 1)}:
        return
    if tuple(scale.shape) in {(rows,), (rows, 1)}:
        return
    raise ValueError(
        f"'{path}' has a {tuple(scale.shape)} scale for a {tuple(weight.shape)} weight, which is "
        "neither per-output-channel nor per-tensor. Blockwise scale grids are not implemented."
    )


def drop_unconsumed_quantization_sidecars(sd: dict[str, Any]) -> dict[str, Any]:
    """Remove quantization metadata no loader here consumes.

    - ``.comfy_quant`` markers whose format was handled elsewhere, or not at all.
    - ``.input_scale`` / ``.scale_input``: activation scales for W8A8 inference. This code
      dequantizes the weight and computes in bf16, so there is nothing to apply them to. (Both
      spellings appear in the wild; one Qwen3-VL repack ships 337 of the former.)

    `load_state_dict(strict=False)` would ignore them, but they are still cast and still counted
    against the RAM reservation - and a loader that later switches to strict would fail on them.
    """
    return {
        k: v
        for k, v in sd.items()
        if not (isinstance(k, str) and (k.endswith(".comfy_quant") or "input_scale" in k or "scale_input" in k))
    }


def resolve_quantized_module_paths(
    markers: dict[str, dict[str, Any]], key_map: dict[str, str]
) -> dict[str, dict[str, Any]]:
    """Re-key markers from the checkpoint's names to the built model's names.

    The markers are read in the checkpoint's key space, because that is the only place where a
    marker and its weight are reliably paired: the key conversions rename `.weight` (and, by
    substring, `.weight_scale`) but leave `.comfy_quant` behind on the old name. Following the
    weight's own rename is therefore the only mapping that cannot drift from the conversion.
    """
    resolved: dict[str, dict[str, Any]] = {}
    for path, marker in markers.items():
        weight_key = key_map.get(f"{path}.weight", f"{path}.weight")
        resolved[weight_key[: -len(".weight")]] = marker
    return resolved


def swap_in_int8_linears(model: torch.nn.Module, sd: dict[str, Any], quantized: dict[str, dict[str, Any]]) -> None:
    """Replace each quantized ``nn.Linear`` with an ``Int8ConvrotLinear`` sized from the state dict.

    The weights stay int8 and rotated as stored; the layer dequantizes and derotates per forward.
    That keeps a 12 GB checkpoint at 12 GB resident instead of the ~24 GB a dense decode would
    produce, on every platform and without the fp8-storage opt-in (which is off by default and
    unavailable outside CUDA/XPU).

    Its persistent buffers are named ``weight``/``weight_scale`` -- the checkpoint's own spelling --
    so the ``load_state_dict`` that follows assigns the quantized tensors straight into them.
    """
    for path, marker in quantized.items():
        weight, scale = sd.get(f"{path}.weight"), sd.get(f"{path}.weight_scale")
        if weight is None or scale is None:
            raise ValueError(
                f"'{path}' is marked int8_tensorwise but is missing its "
                f"{'weight' if weight is None else 'weight_scale'}."
            )
        check_int8_scale_layout(path, weight, scale)
        parent_path, _, attribute = path.rpartition(".")
        setattr(
            model.get_submodule(parent_path) if parent_path else model,
            attribute,
            Int8ConvrotLinear(
                weight=weight,
                weight_scale=scale,
                convrot=bool(marker.get("convrot", False)),
                bias=sd.get(f"{path}.bias"),
                group_size=int(marker.get("convrot_groupsize", CONVROT_GROUP_SIZE)),
            ),
        )


def cast_unquantized(sd: dict[str, Any], dtype: torch.dtype, quantized: dict[str, dict[str, Any]]) -> None:
    """Cast the dense tensors to the compute dtype, leaving the quantized payloads alone.

    An int8 weight cast to bf16 is no longer int8, and its float32 scale is what
    ``Int8ConvrotLinear`` multiplies by -- both have to reach ``load_state_dict`` as stored.
    """
    pinned = {key for path in quantized for key in (f"{path}.weight", f"{path}.weight_scale")}
    for key in sd:
        if key not in pinned:
            sd[key] = sd[key].to(dtype)
