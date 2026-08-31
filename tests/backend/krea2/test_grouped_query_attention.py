"""Whether the K/V heads are expanded before SDPA, or passed through as grouped-query attention.

Krea-2 has 48 query heads over 12 K/V heads. `repeat_interleave` makes them match, which lets any
fused kernel take the call — at the price of allocating two tensors four times larger, every call.
Only some kernels serve the unexpanded shape, so the choice is made per call by asking the
dispatcher. Getting that answer wrong in the optimistic direction is not a slow path but a ~9 GB one:
the math backend materialises the full [heads, seq, seq] score matrix.
"""

from unittest.mock import MagicMock

import pytest
import torch
from diffusers.models.transformers.transformer_krea2 import Krea2Attention
from torch.nn.attention import SDPBackend

from invokeai.backend.krea2 import attention as attention_module
from invokeai.backend.krea2.attention import (
    Krea2MemoryEfficientAttnProcessor,
    Krea2RegionalPromptingState,
    Krea2SdpaBackends,
)

HQ, HKV, HEAD_DIM = 48, 12, 128


def _tensors(device: str, seq: int = 64, kv_heads: int = HKV, masked: bool = False):
    q = torch.randn(1, HQ, seq, HEAD_DIM, device=device, dtype=torch.bfloat16)
    kv = torch.randn(1, kv_heads, seq, HEAD_DIM, device=device, dtype=torch.bfloat16)
    mask = torch.zeros(1, 1, seq, seq, device=device, dtype=torch.bfloat16) if masked else None
    return q, kv, kv.clone(), mask


class TestTheDecisionIsConservative:
    def test_a_non_cuda_tensor_never_takes_the_gqa_path(self):
        """`SDPAParams` is CUDA-only, and no other backend offers a fused grouped-query path.
        Answering yes here would drop the call onto math."""
        proc = Krea2MemoryEfficientAttnProcessor()
        assert proc._serves_grouped_query_attention(*_tensors("cpu")) is False

    def test_it_answers_no_when_the_permitted_list_excludes_the_capable_kernels(self):
        """The trap: cuDNN may well serve the shape, but if this call is not permitted to reach it —
        which `INVOKE_KREA2_SDPA_BACKEND=efficient` does — then answering yes makes the call fail
        outright with `No available kernel`, because the memory-efficient kernel refuses GQA."""
        proc = Krea2MemoryEfficientAttnProcessor(
            sdpa_backends=Krea2SdpaBackends(backends=(SDPBackend.EFFICIENT_ATTENTION,), set_priority=False)
        )
        q, k, v, mask = _tensors("cpu")
        assert proc._serves_grouped_query_attention(q, k, v, mask) is False

    def test_a_torch_build_with_a_different_sdpaparams_answers_no(self, monkeypatch):
        # Falling back to the expansion is correct everywhere; it merely costs memory.
        proc = Krea2MemoryEfficientAttnProcessor()
        q, k, v, mask = _tensors("cpu")
        monkeypatch.setattr(type(q), "is_cuda", property(lambda self: True), raising=False)
        monkeypatch.setattr(torch.backends.cuda, "SDPAParams", MagicMock(side_effect=TypeError("signature changed")))
        assert proc._serves_grouped_query_attention(q, k, v, mask) is False


class TestTheAnswerIsCached:
    def test_the_dispatcher_is_asked_once_per_call_shape(self, monkeypatch):
        """Dozens of attention calls per step share one shape; querying every time would be waste."""
        proc = Krea2MemoryEfficientAttnProcessor()
        q, k, v, mask = _tensors("cpu")
        monkeypatch.setattr(type(q), "is_cuda", property(lambda self: True), raising=False)
        monkeypatch.setattr(torch.backends.cuda, "SDPAParams", MagicMock(return_value=object()))
        can_use = MagicMock(return_value=True)
        monkeypatch.setattr(torch.backends.cuda, "can_use_cudnn_attention", can_use)

        for _ in range(5):
            assert proc._serves_grouped_query_attention(q, k, v, mask) is True
        assert can_use.call_count == 1

    def test_a_different_mask_state_is_a_different_question(self, monkeypatch):
        """Flash takes the unmasked call and refuses the masked one, so the two cannot share an
        answer."""
        proc = Krea2MemoryEfficientAttnProcessor()
        monkeypatch.setattr(torch.Tensor, "is_cuda", property(lambda self: True), raising=False)
        monkeypatch.setattr(torch.backends.cuda, "SDPAParams", MagicMock(return_value=object()))
        can_use = MagicMock(return_value=True)
        monkeypatch.setattr(torch.backends.cuda, "can_use_cudnn_attention", can_use)

        proc._serves_grouped_query_attention(*_tensors("cpu", masked=False))
        proc._serves_grouped_query_attention(*_tensors("cpu", masked=True))
        assert can_use.call_count == 2


class TestTheExpansionStillHappensWhenItMust:
    @pytest.mark.parametrize("masked", [False, True])
    def test_cpu_output_matches_the_stock_processor(self, masked):
        """On CPU the answer is always no, so this is the expansion path — and it must stay exactly
        what it was before the grouped-query option existed."""
        torch.manual_seed(0)
        attn = Krea2Attention(hidden_size=256, num_heads=8, num_kv_heads=2, eps=1e-5).eval()
        hidden = torch.randn(1, 16, 256)
        state = Krea2RegionalPromptingState(attention_mask=torch.ones(16, 16, dtype=torch.bool)) if masked else None

        with torch.no_grad():
            attn.set_processor(Krea2MemoryEfficientAttnProcessor(regional_prompting_state=state))
            ours = attn(hidden, attention_mask=None, image_rotary_emb=None)
            from diffusers.models.transformers.transformer_krea2 import Krea2AttnProcessor

            attn.set_processor(Krea2AttnProcessor())
            stock = attn(hidden, attention_mask=None, image_rotary_emb=None)

        assert torch.allclose(ours, stock, atol=1e-5)


@pytest.mark.skipif(not torch.cuda.is_available(), reason="CUDA is required to reach a fused GQA kernel")
class TestTheTwoPathsAgreeOnCuda:
    @pytest.mark.parametrize("masked", [False, True])
    def test_grouped_query_output_matches_the_expanded_one(self, masked, monkeypatch):
        """The saving is only worth having if the result is the same. Anything else would be a
        silent change to every Krea-2 image."""
        torch.manual_seed(0)
        attn = (
            Krea2Attention(hidden_size=HQ * HEAD_DIM, num_heads=HQ, num_kv_heads=HKV, eps=1e-5)
            .eval()
            .to("cuda", torch.bfloat16)
        )
        hidden = torch.randn(1, 256, HQ * HEAD_DIM, device="cuda", dtype=torch.bfloat16)
        state = None
        if masked:
            m = torch.zeros(256, 256, device="cuda", dtype=torch.bool)
            m[:128, :128] = True
            m[128:, 128:] = True
            state = Krea2RegionalPromptingState(attention_mask=m)

        # Record the K/V head count that actually reaches SDPA. Without this the test would pass
        # just as happily if both runs expanded, which is exactly what it is meant to rule out.
        real_sdpa = torch.nn.functional.scaled_dot_product_attention
        seen: list[int] = []

        def spy(q, k, v, attn_mask=None, enable_gqa=False, **kwargs):
            seen.append(k.shape[1])
            return real_sdpa(q, k, v, attn_mask=attn_mask, enable_gqa=enable_gqa, **kwargs)

        def run(force_expand: bool) -> torch.Tensor:
            proc = Krea2MemoryEfficientAttnProcessor(regional_prompting_state=state)
            if force_expand:
                proc._serves_grouped_query_attention = lambda *a, **k: False
            attn.set_processor(proc)
            monkeypatch.setattr(attention_module.F, "scaled_dot_product_attention", spy)
            with torch.no_grad():
                out = attn(hidden, attention_mask=None, image_rotary_emb=None).float()
            monkeypatch.undo()
            return out

        expanded = run(True)
        grouped = run(False)

        assert seen[0] == HQ, "the forced run should have expanded the K/V heads"
        if seen[1] != HKV:
            pytest.skip("no fused kernel on this device serves grouped-query attention for this shape")

        # bf16 kernels differ in accumulation order, so the two are close rather than identical. The
        # bound is the one used for the backend comparison elsewhere.
        corr = torch.corrcoef(torch.stack([expanded.flatten(), grouped.flatten()]))[0, 1]
        assert corr > 0.9999, f"correlation {corr}"
        assert (expanded - grouped).abs().max() < 0.05
