"""The end-of-session warning when Windows keeps part of a worker's VRAM in shared system memory.

It must speak once per episode (again only after the paged amount grew by the threshold, re-armed once it fell below
it), say nothing where the answer is unknown, and never fail the worker.
"""

from types import SimpleNamespace

import pytest
import torch

import invokeai.app.services.session_processor.session_processor_default as processor_module
from invokeai.app.services.session_processor.session_processor_default import (
    _VRAM_PAGING_WARNING_BYTES,
    DefaultSessionProcessor,
    _SessionWorker,
)

MIB = 2**20
DEVICE = torch.device("cuda", 0)


class _Logger:
    def __init__(self) -> None:
        self.warnings: list[str] = []
        self.debugs: list[str] = []

    def warning(self, message: str, **kwargs) -> None:
        self.warnings.append(message)

    def debug(self, message: str, **kwargs) -> None:
        self.debugs.append(message)


@pytest.fixture
def processor() -> tuple[DefaultSessionProcessor, _Logger]:
    logger = _Logger()
    processor = DefaultSessionProcessor()
    processor._invoker = SimpleNamespace(services=SimpleNamespace(logger=logger))  # type: ignore[attr-defined]
    return processor, logger


def _warned_after_each_session(monkeypatch, processor, readings) -> list[bool]:
    """End one session per scripted `paged_bytes` reading on one worker; whether each one warned."""
    processor, logger = processor
    worker = _SessionWorker(DEVICE, runner=SimpleNamespace())  # type: ignore[arg-type]
    values = iter(readings)

    def paged_bytes(device):
        assert device == DEVICE, "the worker's own device is the one asked"
        return next(values)

    monkeypatch.setattr(processor_module, "paged_bytes", paged_bytes)
    warned = []
    for _ in readings:
        before = len(logger.warnings)
        processor._warn_if_vram_paged(worker)
        warned.append(len(logger.warnings) > before)
    return warned


def test_warns_once_per_episode_and_again_only_after_growth(monkeypatch, processor):
    threshold = _VRAM_PAGING_WARNING_BYTES
    readings = [
        6 * MIB,  # an idle process
        threshold + 100 * MIB,  # paged: warn
        threshold + 300 * MIB,  # grew by less than the threshold since the warning
        2 * threshold + 200 * MIB,  # grew by the threshold: warn again
        100 * MIB,  # recovered below the threshold: re-armed
        threshold,  # a new episode: warn
    ]

    assert _warned_after_each_session(monkeypatch, processor, readings) == [False, True, False, True, False, True]
    assert "cuda:0" in processor[1].warnings[0]


def test_silent_where_the_answer_is_unknown(monkeypatch, processor):
    assert _warned_after_each_session(monkeypatch, processor, [None, None]) == [False, False]


def test_a_failing_counter_is_logged_at_debug_and_does_not_fail_the_worker(monkeypatch, processor):
    processor_instance, logger = processor

    def broken(device):
        raise OSError("PDH query failed")

    monkeypatch.setattr(processor_module, "paged_bytes", broken)

    processor_instance._warn_if_vram_paged(_SessionWorker(DEVICE, runner=SimpleNamespace()))  # type: ignore[arg-type]

    assert logger.warnings == []
    assert len(logger.debugs) == 1
