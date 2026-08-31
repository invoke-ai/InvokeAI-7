"""Tests for make_room()'s eviction guards."""

import gc
import logging
import time
from unittest.mock import MagicMock

from invokeai.backend.model_manager.load.load_base import LoadedModelWithoutConfig
from invokeai.backend.model_manager.load.model_cache.model_cache import ModelCache
from tests.backend.model_manager.load.model_cache.cached_model.utils import DummyModule


def _make_cache() -> ModelCache:
    logger = MagicMock()
    logger.getEffectiveLevel.return_value = logging.INFO
    return ModelCache(
        execution_device_working_mem_gb=1.0,
        enable_partial_loading=False,
        keep_ram_copy_of_weights=True,
        execution_device="cpu",
        storage_device="cpu",
        logger=logger,
    )


def test_make_room_spares_entries_awaiting_first_use():
    """A just-admitted entry (put() done, first lock() pending) must survive make_room: the
    loader's handle keeps the model alive anyway — multi-model invocations load their whole set
    before locking any of it, so a sibling's cold-load make_room runs inside this window — and
    evicting it frees nothing while detaching the record from all cache accounting."""
    cache = _make_cache()
    cache.put("fresh", DummyModule())
    record = cache.get("fresh")

    # Precondition: the admission grace is armed (the deferred worker is running in-process).
    assert record.awaiting_first_use

    cache.make_room(10**15)
    assert "fresh" in cache._cached_models, "make_room evicted an entry still awaiting its first lock"

    # After the first lock/unlock cycle the grace is released and the entry is ordinary cache
    # content again.
    cache.lock(record, None)
    cache.unlock(record)
    assert not record.awaiting_first_use

    cache.make_room(10**15)
    assert "fresh" not in cache._cached_models


def test_make_room_still_evicts_ordinary_unlocked_entries():
    cache = _make_cache()
    cache.put("used", DummyModule())
    record = cache.get("used")
    cache.lock(record, None)
    cache.unlock(record)

    cache.make_room(10**15)
    assert "used" not in cache._cached_models


def test_make_room_never_evicts_locked_entries():
    cache = _make_cache()
    cache.put("held", DummyModule())
    record = cache.get("held")
    cache.lock(record, None)
    try:
        cache.make_room(10**15)
        assert "held" in cache._cached_models
    finally:
        cache.unlock(record)


def test_grace_survives_sibling_admissions_while_the_handle_lives():
    """Multi-model invocations load their whole set before locking any of it: an earlier
    sibling's grace must survive later puts (whose sweep previously cleared every grace) and the
    make_rooms they trigger, for as long as its LoadedModel handle is alive."""
    cache = _make_cache()
    cache.put("first", DummyModule())
    record = cache.get("first")
    handle = LoadedModelWithoutConfig(cache_record=record, cache=cache)

    # Two more siblings admitted — each put() runs the stale-grace sweep and a make_room.
    cache.put("second", DummyModule())
    cache.put("third", DummyModule())
    assert record.awaiting_first_use, "a sibling's put() swept a grace whose handle is alive"

    cache.make_room(10**15)
    assert "first" in cache._cached_models

    # The handle finally locks: grace released, ordinary cache content again.
    with handle:
        pass
    assert not record.awaiting_first_use
    cache.make_room(10**15)
    assert "first" not in cache._cached_models


def test_sweep_clears_orphaned_graces():
    """A grace with no registered handle (the load raised between put() and LoadedModel
    construction) — or whose handle died without its finalizer running (lost deferred worker) —
    is orphaned, and the next admission's sweep must clear it so the record cannot dodge budget
    reconciles indefinitely."""
    cache = _make_cache()

    # No handle ever registered.
    cache.put("orphan", DummyModule())
    orphan = cache.get("orphan")
    assert orphan.grace_holder is None
    cache.put("sibling", DummyModule())
    assert not orphan.awaiting_first_use

    # Handle registered, then dies with its finalizer disarmed (simulated lost worker).
    cache.put("undead", DummyModule())
    undead = cache.get("undead")
    handle = LoadedModelWithoutConfig(cache_record=undead, cache=cache)
    assert handle._first_use_finalizer is not None
    handle._first_use_finalizer.detach()
    del handle
    gc.collect()
    assert undead.grace_holder is not None and undead.grace_holder() is None
    cache.put("sibling-2", DummyModule())
    assert not undead.awaiting_first_use


def test_dropped_handle_releases_the_grace_through_its_finalizer():
    cache = _make_cache()
    cache.put("dropped", DummyModule())
    record = cache.get("dropped")
    handle = LoadedModelWithoutConfig(cache_record=record, cache=cache)

    del handle
    gc.collect()
    # The finalizer dispatches the release through the deferred worker; give it a moment.
    for _ in range(100):
        if not record.awaiting_first_use:
            break
        time.sleep(0.02)
    assert not record.awaiting_first_use


def test_explicit_clear_ignores_the_grace():
    """The clear-model-cache button path (spare_awaiting_first_use=False) evicts graced
    entries too — a user-requested full clear outranks the grace."""
    cache = _make_cache()
    cache.put("fresh", DummyModule())
    record = cache.get("fresh")
    assert record.awaiting_first_use

    result = cache.make_room(10**15, spare_awaiting_first_use=False)
    assert "fresh" not in cache._cached_models
    assert result.models_cleared == 1
