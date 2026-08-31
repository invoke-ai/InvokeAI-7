"""Tests for the VRAM budget arithmetic behind lock()/partial loads.

`_get_vram_available` must count every byte this process can actually obtain: driver-free memory
PLUS the torch caching allocator's reserved-but-unused blocks (the allocator reuses those
directly, and `empty_cache()` returns whole unoccupied segments to the driver). Budgeting on
driver-free alone under-reported by whatever earlier stages freed without an `empty_cache()`
— observed in the wild as a fully-evictable multi-GB reserve pushing a 20 GB transformer down
to 0% VRAM residency while the allocator happily reused the "missing" memory for activations.
"""

import logging
from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.model_manager.load.model_cache.model_cache import ModelCache

GB = 1024**3
MB = 1024**2

requires_cuda = pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA.")


class BigModule(torch.nn.Module):
    """A module whose single parameter is `mb` MiB of fp32."""

    def __init__(self, mb: int):
        super().__init__()
        self.weight = torch.nn.Parameter(torch.zeros(mb * MB // 4, dtype=torch.float32))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x


def _make_cache(logger: logging.Logger | MagicMock | None = None) -> ModelCache:
    if logger is None:
        logger = MagicMock()
        logger.getEffectiveLevel.return_value = logging.INFO
    return ModelCache(
        execution_device_working_mem_gb=0.1,
        enable_partial_loading=True,
        keep_ram_copy_of_weights=True,
        execution_device="cuda:0",
        storage_device="cpu",
        logger=logger,
        shared_cpu_weights=None,
    )


@requires_cuda
def test_lock_offloads_unlocked_models_under_working_memory_pressure():
    """A big working-memory reservation must evict resident-but-unlocked models so the locked
    model still loads fully (the freed bytes become budget via the allocator-reserve credit and
    the post-offload empty_cache)."""
    torch.cuda.empty_cache()
    cache = _make_cache()
    cache.put("A", BigModule(512))
    rec_a = cache.get("A")
    cache.lock(rec_a, None)
    cache.unlock(rec_a)
    assert rec_a.cached_model.cur_vram_bytes() >= 512 * MB

    free, _total = torch.cuda.mem_get_info(torch.device("cuda:0"))
    # Without offloading A there is only 128 MB of budget — far less than B needs.
    working = free - 128 * MB

    cache.put("B", BigModule(256))
    rec_b = cache.get("B")
    cache.lock(rec_b, working)
    try:
        assert rec_a.cached_model.cur_vram_bytes() == 0, "unlocked resident model was not offloaded"
        assert rec_b.cached_model.cur_vram_bytes() == rec_b.cached_model.total_bytes()
    finally:
        cache.unlock(rec_b)


@requires_cuda
def test_get_vram_available_credits_reserved_but_free_allocator_blocks():
    """Freed-but-not-empty_cache'd allocator blocks are reclaimable and must count as available."""
    torch.cuda.empty_cache()
    cache = _make_cache()

    # Simulate a previous pipeline stage's freed activations: 1 GiB allocated then dropped, with
    # no empty_cache — the bytes stay in the allocator's reserve, invisible to mem_get_info.
    junk = torch.empty(1 * GB, dtype=torch.uint8, device="cuda:0")
    del junk

    free, _total = torch.cuda.mem_get_info(torch.device("cuda:0"))
    working = free - 128 * MB
    available = cache._get_vram_available(working)

    # Driver-free alone would report ~128 MB; the credited reserve must dominate. The margin
    # tolerates concurrent allocations by other processes on a shared dev GPU.
    assert available >= 900 * MB, f"reserved-but-free blocks not credited (available={available / MB:.0f}MB)"

    torch.cuda.empty_cache()


@requires_cuda
def test_negative_budget_warns_and_names_locked_residents():
    """When the budget stays short after offloading, the first-pass warning must name what is
    still occupying the device — locked entries especially, since the offload cannot touch them."""
    torch.cuda.empty_cache()
    logger = MagicMock()
    logger.getEffectiveLevel.return_value = logging.INFO
    cache = _make_cache(logger)

    cache.put("stuck", BigModule(256))
    rec_stuck = cache.get("stuck")
    cache.lock(rec_stuck, None)  # deliberately left locked

    free, _total = torch.cuda.mem_get_info(torch.device("cuda:0"))
    impossible_working = free + 10 * GB

    cache.put("victim", BigModule(64))
    rec_victim = cache.get("victim")
    cache.lock(rec_victim, impossible_working)
    try:
        # ModelCache wraps its logger in a PrefixedLoggerAdapter, so adapter.warning() reaches
        # the underlying (mock) logger as .log(WARNING, msg).
        warnings = [str(call.args[0]) for call in logger.warning.call_args_list]
        warnings += [
            str(call.args[1])
            for call in logger.log.call_args_list
            if call.args and call.args[0] == logging.WARNING and len(call.args) > 1
        ]
        budget_warnings = [message for message in warnings if "VRAM budget for 'victim' is short by" in message]

        assert budget_warnings, f"no budget-short warning emitted; warnings: {warnings}"
        assert "stuck=" in budget_warnings[0]
        assert "[locked]" in budget_warnings[0]
    finally:
        cache.unlock(rec_victim)
        cache.unlock(rec_stuck)
        torch.cuda.empty_cache()
