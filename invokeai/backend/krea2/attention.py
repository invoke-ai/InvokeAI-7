"""Memory-efficient attention processor for the Krea-2 transformer.

The stock ``Krea2AttnProcessor`` calls ``scaled_dot_product_attention`` with ``enable_gqa=True`` (Krea-2 uses
grouped-query attention: 48 query heads, 12 key/value heads). PyTorch's fused flash / memory-efficient SDPA
kernels do **not** support ``enable_gqa``, so this forces the *math* backend, which materializes the full
``[heads, seq, seq]`` score matrix. At 1280x720 (3600 image tokens) that is ~5.7 GB **per attention**, and it
grows O(seq^2) — ~40 GB at 2560x1440 — so generation OOMs or the cache offloads the transformer to RAM.

This processor runs under a ranked list of fused SDPA backends instead, which are O(seq) in memory.
Measured: the same 3600-token attention drops from ~5.7 GB to ~0.19 GB.

The premise above has since become build-dependent. **cuDNN does serve grouped-query attention**, mask
included, so where it is available the K/V heads can stay at 12 and the expansion is pure waste --
``repeat_interleave`` allocates two tensors four times larger than the originals, every call. Where no
fused kernel takes GQA (the memory-efficient kernel refuses it outright, flash refuses the additive
mask, and ROCm has no cuDNN at all) the expansion is still the only thing standing between this
processor and the ~5.7 GB math path. So it is now conditional, decided per call shape by asking the
dispatcher rather than by assuming -- see ``_serves_grouped_query_attention``.

The math is otherwise identical to ``Krea2AttnProcessor`` (q/k RMSNorm, rotary embeddings, sigmoid output gate).
"""

import os
import re
from dataclasses import dataclass
from typing import Protocol

import torch
import torch.nn.functional as F
from diffusers.models.embeddings import apply_rotary_emb
from torch.nn.attention import SDPBackend, sdpa_kernel

from invokeai.backend.util.logging import InvokeAILogger

logger = InvokeAILogger.get_logger(__name__)

# Measured on the real Krea-2 attention shape ([1, 48, 4608, 128], bf16), per call:
#
#                     RTX 4090 / Windows      RTX 30-series / Linux
#   flash             not compiled in         19.74 ms
#   cudnn              3.72 ms                21.27 ms
#   efficient          5.92 ms                31.45 ms
#   math              51.23 ms               168.48 ms
#
# Two things follow, and the order below encodes both.
#
# **Flash first.** Where the build has it, flash is the fastest kernel and is *already* what runs
# today: without `set_priority` torch picks by its own order, in which flash outranks efficient. On
# the 30-series card an unprefixed call lands at 20.15 ms, i.e. on flash, not on efficient. Ranking
# cuDNN above it would therefore be a small regression on every flash-capable build.
#
# **cuDNN second, and it is not a formality.** Flash refuses the additive padding mask that the
# regional-prompting blocks pass, so on exactly those blocks it is skipped and cuDNN takes over --
# where it beats efficient by 1.6x-2.0x. Windows CUDA builds have no flash at all, so there cuDNN is
# what every block gets. Both are the cases the win comes from; flash-first does not give either up.
#
# Everything here is a fallback, never an exclusive choice: an unavailable backend is skipped by the
# dispatcher, so the list degrades on its own -- to efficient on ROCm, where cuDNN is absent and
# flash rejects the mask, and to efficient anywhere neither fused kernel can serve the call.
_KREA2_SDPA_BACKENDS = [
    SDPBackend.FLASH_ATTENTION,
    SDPBackend.CUDNN_ATTENTION,
    SDPBackend.EFFICIENT_ATTENTION,
    SDPBackend.MATH,
]

# Opt-in override, for measuring one backend against another and for support questions. Unset -- the
# only state a user ever sees by default -- is the ranked list above, unchanged.
KREA2_SDPA_BACKEND_ENV_VAR = "INVOKE_KREA2_SDPA_BACKEND"
_PRIORITY_CUDNN = "priority-cudnn"
_EXCLUSIVE_BACKENDS = {
    "cudnn": SDPBackend.CUDNN_ATTENTION,
    "efficient": SDPBackend.EFFICIENT_ATTENTION,
    "flash": SDPBackend.FLASH_ATTENTION,
    "math": SDPBackend.MATH,
}


@dataclass(frozen=True)
class Krea2SdpaBackends:
    """Which SDPA backends a Krea-2 attention call may use, and in what order."""

    backends: tuple[SDPBackend, ...]
    set_priority: bool
    override: str | None = None

    def describe(self) -> str:
        names = ", ".join(b.name for b in self.backends)
        return f"sdpa_kernel([{names}], set_priority={self.set_priority})"


def resolve_krea2_sdpa_backends(raw_override: str | None = None) -> Krea2SdpaBackends:
    """Resolve the SDPA backend list, honouring KREA2_SDPA_BACKEND_ENV_VAR.

    The exclusive modes are the point of the override: a run that completes proves that kernel was
    actually used, because an unavailable backend raises visibly instead of quietly degrading to math.
    """
    raw = os.environ.get(KREA2_SDPA_BACKEND_ENV_VAR) if raw_override is None else raw_override
    if raw is None or not raw.strip():
        return Krea2SdpaBackends(backends=tuple(_KREA2_SDPA_BACKENDS), set_priority=True)

    value = raw.strip().lower()
    if value == _PRIORITY_CUDNN:
        return Krea2SdpaBackends(backends=tuple(_KREA2_SDPA_BACKENDS), set_priority=True, override=value)
    if value in _EXCLUSIVE_BACKENDS:
        return Krea2SdpaBackends(backends=(_EXCLUSIVE_BACKENDS[value],), set_priority=False, override=value)

    valid = ", ".join([*sorted(_EXCLUSIVE_BACKENDS), _PRIORITY_CUDNN])
    raise ValueError(f"{KREA2_SDPA_BACKEND_ENV_VAR}={raw!r} is not a valid value. Valid values: {valid}.")


@dataclass
class Krea2RegionalPromptingState:
    """Mutable per-forward regional attention state shared by Krea-2 transformer-block processors."""

    attention_mask: torch.Tensor | None = None

    def set_attention_mask(self, attention_mask: torch.Tensor | None) -> None:
        self.attention_mask = attention_mask


class Krea2MemoryEfficientAttnProcessor:
    """Drop-in replacement for ``Krea2AttnProcessor`` that avoids the ``enable_gqa`` math fallback."""

    def __init__(
        self,
        regional_prompting_state: Krea2RegionalPromptingState | None = None,
        sdpa_backends: Krea2SdpaBackends | None = None,
    ) -> None:
        self.regional_prompting_state = regional_prompting_state
        # Resolved once per generation and handed down, not read per attention call.
        self.sdpa_backends = sdpa_backends if sdpa_backends is not None else resolve_krea2_sdpa_backends()
        # Keyed by the call shape; see `_serves_grouped_query_attention`.
        self._gqa_support: dict[tuple, bool] = {}

    def __call__(
        self,
        attn,
        hidden_states: torch.Tensor,
        attention_mask: torch.Tensor | None = None,
        image_rotary_emb: tuple[torch.Tensor, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        if self.regional_prompting_state is not None and self.regional_prompting_state.attention_mask is not None:
            regional_attention_mask = self.regional_prompting_state.attention_mask
            if regional_attention_mask.shape != (hidden_states.shape[1], hidden_states.shape[1]):
                raise ValueError(
                    f"Krea-2 regional attention mask shape {tuple(regional_attention_mask.shape)} does not match "
                    f"the transformer sequence length {hidden_states.shape[1]}."
                )
            attention_mask = (
                regional_attention_mask if attention_mask is None else attention_mask & regional_attention_mask
            )

        query = attn.to_q(hidden_states).unflatten(-1, (attn.num_heads, attn.head_dim))
        key = attn.to_k(hidden_states).unflatten(-1, (attn.num_kv_heads, attn.head_dim))
        value = attn.to_v(hidden_states).unflatten(-1, (attn.num_kv_heads, attn.head_dim))
        gate = attn.to_gate(hidden_states)

        query = attn.norm_q(query)
        key = attn.norm_k(key)

        if image_rotary_emb is not None:
            query = apply_rotary_emb(query, image_rotary_emb, sequence_dim=1)
            key = apply_rotary_emb(key, image_rotary_emb, sequence_dim=1)

        # [B, S, H, D] -> [B, H, S, D] for scaled_dot_product_attention.
        query = query.transpose(1, 2)
        key = key.transpose(1, 2)
        value = value.transpose(1, 2)

        # Krea-2 has 48 query heads over 12 K/V heads. Passing them through as they are avoids
        # allocating two tensors four times larger, but only some kernels serve that shape -- so ask,
        # do not assume. Where the answer is no, expand as before: that is what keeps this off the
        # math path, which materialises the full [heads, seq, seq] score matrix.
        enable_gqa = attn.num_heads != attn.num_kv_heads and self._serves_grouped_query_attention(
            query, key, value, attention_mask
        )
        if attn.num_heads != attn.num_kv_heads and not enable_gqa:
            repeats = attn.num_heads // attn.num_kv_heads
            key = key.repeat_interleave(repeats, dim=1)
            value = value.repeat_interleave(repeats, dim=1)

        with sdpa_kernel(list(self.sdpa_backends.backends), set_priority=self.sdpa_backends.set_priority):
            hidden_states = F.scaled_dot_product_attention(
                query, key, value, attn_mask=attention_mask, enable_gqa=enable_gqa
            )

        # [B, H, S, D] -> [B, S, H, D] -> [B, S, H*D], matching Krea2AttnProcessor's output layout.
        hidden_states = hidden_states.transpose(1, 2).flatten(2, 3)
        hidden_states = hidden_states * torch.sigmoid(gate)
        return attn.to_out[0](hidden_states)

    def _serves_grouped_query_attention(
        self,
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
        attention_mask: torch.Tensor | None,
    ) -> bool:
        """Whether a fused kernel will take the unexpanded K/V heads for this exact call.

        Measured on the Krea-2 shape ([1, 48q/12kv, 4608, 128], bf16): cuDNN serves it, masked and
        unmasked alike; the memory-efficient kernel refuses grouped-query attention outright, and
        flash refuses the additive mask the regional-prompting blocks pass. On a build without cuDNN
        -- ROCm -- a masked call therefore has no fused kernel left, and answering "yes" there would
        drop it onto `math` at roughly 9 GB. That is the failure this whole processor exists to
        avoid, so the answer is asked of the dispatcher rather than inferred from the platform.

        The answer depends only on the shape, dtype, device, whether a mask is present, and which
        backends this processor permits -- all fixed for a given block within a generation -- so it is
        cached, and the query costs nothing after the first call of each kind.
        """
        if not query.is_cuda:
            # SDPAParams is a CUDA-only interface, and no other backend offers a fused GQA path.
            return False

        cache_key = (
            query.shape,
            key.shape,
            query.dtype,
            query.device,
            None if attention_mask is None else (attention_mask.shape, attention_mask.dtype),
            self.sdpa_backends.backends,
        )
        cached = self._gqa_support.get(cache_key)
        if cached is not None:
            return cached

        try:
            params = torch.backends.cuda.SDPAParams(query, key, value, attention_mask, 0.0, False, True)
            permitted = self.sdpa_backends.backends
            # Only the backends this call will actually permit count. Asking about cuDNN while the
            # resolved list excludes it -- which the `efficient` override does -- would answer for a
            # kernel the dispatcher is not allowed to reach, and the call would fail outright.
            supported = bool(
                (SDPBackend.CUDNN_ATTENTION in permitted and torch.backends.cuda.can_use_cudnn_attention(params))
                or (SDPBackend.FLASH_ATTENTION in permitted and torch.backends.cuda.can_use_flash_attention(params))
            )
        except Exception:  # noqa: BLE001
            # A torch build whose SDPAParams signature differs: fall back to the expansion, which is
            # correct everywhere and merely costs memory.
            supported = False

        self._gqa_support[cache_key] = supported
        return supported


class _Krea2AttentionProcessorContainer(Protocol):
    @property
    def attn_processors(self) -> dict[str, object]: ...


def build_krea2_attention_processors(
    transformer: _Krea2AttentionProcessorContainer,
    regional_prompting_state: Krea2RegionalPromptingState,
) -> dict[str, Krea2MemoryEfficientAttnProcessor]:
    """Build processors that apply regional masks to alternating main transformer blocks only."""

    sdpa_backends = resolve_krea2_sdpa_backends()
    if sdpa_backends.override is not None:
        # Once per generation, not once per attention call.
        logger.info(
            f"Krea-2 SDPA backend override active: {KREA2_SDPA_BACKEND_ENV_VAR}={sdpa_backends.override} "
            f"-> {sdpa_backends.describe()}"
        )

    processors: dict[str, Krea2MemoryEfficientAttnProcessor] = {}
    for name in transformer.attn_processors:
        match = re.fullmatch(r"transformer_blocks\.(\d+)\.attn\.processor", name)
        block_index = int(match.group(1)) if match is not None else None
        state = regional_prompting_state if block_index is not None and block_index % 2 == 0 else None
        processors[name] = Krea2MemoryEfficientAttnProcessor(
            regional_prompting_state=state, sdpa_backends=sdpa_backends
        )
    return processors
