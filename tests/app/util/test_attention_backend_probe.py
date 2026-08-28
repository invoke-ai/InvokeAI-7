"""The startup SDPA availability probe.

It exists to answer support questions from a log line instead of a probe script, so the properties
that matter are: it never breaks boot, it says nothing where the question does not apply, and what
it does say is specific enough to act on.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest
import torch

from invokeai.app.util.startup_utils import log_attention_backends, probe_attention_backends


class TestProbe:
    @pytest.mark.parametrize("device_type", ["cpu", "mps"])
    def test_a_non_cuda_device_is_not_probed(self, device_type):
        # There are no fused SDPA backends to report, and can_use_* would raise.
        assert probe_attention_backends(torch.device(device_type)) is None

    def test_a_probe_failure_does_not_propagate(self):
        # A diagnostic must never be the reason the server does not start.
        with patch.object(torch, "empty", side_effect=RuntimeError("no CUDA driver")):
            assert probe_attention_backends(torch.device("cuda")) is None

    def test_math_is_reported_as_always_available(self):
        # It is the unfused fallback, not a kernel that can be missing -- so it is never probed for.
        with (
            patch.object(torch, "empty", return_value=MagicMock()),
            patch.object(torch.backends.cuda, "SDPAParams", return_value=MagicMock()),
            patch.object(torch.backends.cuda, "can_use_cudnn_attention", return_value=False),
            patch.object(torch.backends.cuda, "can_use_flash_attention", return_value=False),
            patch.object(torch.backends.cuda, "can_use_efficient_attention", return_value=False),
            patch.object(torch.cuda, "empty_cache"),
        ):
            available = probe_attention_backends(torch.device("cuda"))
        assert available == {"cudnn": False, "flash": False, "efficient": False, "math": True}

    def test_the_probe_tensor_is_not_left_in_the_allocator(self):
        with (
            patch.object(torch, "empty", return_value=MagicMock()),
            patch.object(torch.backends.cuda, "SDPAParams", return_value=MagicMock()),
            patch.object(torch.backends.cuda, "can_use_cudnn_attention", return_value=True),
            patch.object(torch.backends.cuda, "can_use_flash_attention", return_value=True),
            patch.object(torch.backends.cuda, "can_use_efficient_attention", return_value=True),
            patch.object(torch.cuda, "empty_cache") as empty_cache,
        ):
            probe_attention_backends(torch.device("cuda"))
        empty_cache.assert_called_once()


class TestLogLine:
    def test_nothing_is_logged_where_the_question_does_not_apply(self, caplog):
        logger = logging.getLogger("test_probe_silent")
        with caplog.at_level(logging.INFO, logger=logger.name):
            log_attention_backends(logger, torch.device("cpu"))
        assert caplog.records == []

    def test_the_line_names_every_backend_and_its_answer(self, caplog):
        logger = logging.getLogger("test_probe_line")
        with patch(
            "invokeai.app.util.startup_utils.probe_attention_backends",
            return_value={"cudnn": True, "flash": False, "efficient": True, "math": True},
        ):
            with caplog.at_level(logging.INFO, logger=logger.name):
                log_attention_backends(logger, torch.device("cuda"))

        message = caplog.records[0].message
        assert "cudnn=yes" in message
        assert "flash=no" in message
        assert "efficient=yes" in message
        # The shape is part of the answer: availability depends on it, so a line without it would be
        # unactionable.
        assert "head_dim 128" in message
        # And the caveat that keeps it from being read as a dispatch table.
        assert "no mask" in message
