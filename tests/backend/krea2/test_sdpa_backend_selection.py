"""Which SDPA backends the Krea-2 attention processors run under, and the opt-in override.

The ranking is a measurement, not a preference: cuDNN is ~1.6x the memory-efficient kernel on the
Krea-2 attention shape at identical peak memory, worth 4-8% per generation and growing with
resolution. These tests pin the two things that make that reachable at all -- cuDNN being first, and
`set_priority=True` -- because without either the change is a silent no-op.
"""

from unittest.mock import MagicMock

import pytest
from torch.nn.attention import SDPBackend

from invokeai.backend.krea2.attention import (
    KREA2_SDPA_BACKEND_ENV_VAR,
    Krea2MemoryEfficientAttnProcessor,
    Krea2RegionalPromptingState,
    build_krea2_attention_processors,
    resolve_krea2_sdpa_backends,
)


class TestTheDefaultRanking:
    def test_cudnn_is_ranked_first(self):
        choice = resolve_krea2_sdpa_backends(raw_override=None)
        assert choice.backends[0] is SDPBackend.CUDNN_ATTENTION

    def test_priority_is_set(self):
        """Load-bearing: without set_priority the list only *permits* backends and torch picks by
        its own order, in which cuDNN ranks last and would never be chosen. The ranking would be a
        no-op."""
        assert resolve_krea2_sdpa_backends(raw_override=None).set_priority is True

    def test_the_fallbacks_are_all_still_there(self):
        # A ranked list, never an exclusive backend: an unavailable entry is skipped by the
        # dispatcher, so the list degrades to today's behaviour on its own.
        assert set(resolve_krea2_sdpa_backends(raw_override=None).backends) == {
            SDPBackend.CUDNN_ATTENTION,
            SDPBackend.EFFICIENT_ATTENTION,
            SDPBackend.FLASH_ATTENTION,
            SDPBackend.MATH,
        }

    def test_flash_is_kept_even_though_a_probe_would_call_it_dead_on_cuda(self):
        """Dropping FLASH statically would be actively wrong on ROCm, where flash is available and
        cuDNN is not. A dead entry in a ranked list costs nothing; a missing one costs a platform."""
        assert SDPBackend.FLASH_ATTENTION in resolve_krea2_sdpa_backends(raw_override=None).backends

    def test_no_override_is_recorded_by_default(self):
        # `override is None` is what keeps the benchmark instrumentation, and its synchronize()
        # calls, entirely off the default path.
        assert resolve_krea2_sdpa_backends(raw_override=None).override is None

    @pytest.mark.parametrize("blank", ["", "   ", "\t"])
    def test_a_blank_value_is_the_default_not_an_error(self, blank):
        assert resolve_krea2_sdpa_backends(raw_override=blank).override is None


class TestTheOverride:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("cudnn", SDPBackend.CUDNN_ATTENTION),
            ("efficient", SDPBackend.EFFICIENT_ATTENTION),
            ("flash", SDPBackend.FLASH_ATTENTION),
            ("math", SDPBackend.MATH),
        ],
    )
    def test_a_named_backend_is_exclusive_with_no_fallback(self, value, expected):
        """The point of the exclusive modes: a run that completes proves that kernel was used,
        because an unavailable backend raises visibly instead of degrading to math unnoticed."""
        choice = resolve_krea2_sdpa_backends(raw_override=value)
        assert choice.backends == (expected,)
        assert choice.set_priority is False
        assert choice.override == value

    def test_priority_cudnn_reproduces_the_default_list(self):
        # This is the value the sm_86 pre-merge check runs with, so it must be the shipped list.
        explicit = resolve_krea2_sdpa_backends(raw_override="priority-cudnn")
        default = resolve_krea2_sdpa_backends(raw_override=None)
        assert explicit.backends == default.backends
        assert explicit.set_priority == default.set_priority
        assert explicit.override == "priority-cudnn"

    @pytest.mark.parametrize("value", ["  CUDNN  ", "Priority-CuDNN", "EFFICIENT"])
    def test_values_are_stripped_and_lowercased(self, value):
        assert resolve_krea2_sdpa_backends(raw_override=value).override == value.strip().lower()

    def test_an_unknown_value_raises_and_names_the_valid_ones(self):
        with pytest.raises(ValueError) as excinfo:
            resolve_krea2_sdpa_backends(raw_override="cudnn-attention")
        message = str(excinfo.value)
        assert KREA2_SDPA_BACKEND_ENV_VAR in message
        for valid in ("cudnn", "efficient", "flash", "math", "priority-cudnn"):
            assert valid in message

    def test_the_environment_is_read_when_no_value_is_passed(self, monkeypatch):
        monkeypatch.setenv(KREA2_SDPA_BACKEND_ENV_VAR, "math")
        assert resolve_krea2_sdpa_backends().backends == (SDPBackend.MATH,)
        monkeypatch.delenv(KREA2_SDPA_BACKEND_ENV_VAR)
        assert resolve_krea2_sdpa_backends().override is None


class TestProcessorsCarryTheChoice:
    def test_every_processor_gets_the_same_resolved_choice(self):
        """Resolved once per generation and handed down -- not re-read per attention call, of which
        there are dozens per step."""
        transformer = MagicMock()
        transformer.attn_processors = {
            "transformer_blocks.0.attn.processor": object(),
            "transformer_blocks.1.attn.processor": object(),
            "single_transformer_blocks.0.attn.processor": object(),
        }

        processors = build_krea2_attention_processors(transformer, Krea2RegionalPromptingState())

        choices = {id(p.sdpa_backends) for p in processors.values()}
        assert len(choices) == 1
        assert next(iter(processors.values())).sdpa_backends.backends[0] is SDPBackend.CUDNN_ATTENTION

    def test_a_standalone_processor_resolves_for_itself(self):
        # Constructed directly in tests and by custom code; it must not depend on the builder.
        assert Krea2MemoryEfficientAttnProcessor().sdpa_backends.backends[0] is SDPBackend.CUDNN_ATTENTION
