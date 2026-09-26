"""Fast-lane scheduling for automatic Remote Worker dispatch."""

import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest

from invokeai.app.invocations.remote_worker import early_dispatch


def test_schedule_early_remote_dispatch_deduplicates_queued_or_running_item(monkeypatch):
    pending = SimpleNamespace(put=Mock())
    services = object()

    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_PENDING", pending)
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_SCHEDULED", set())
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_WORKERS_STARTED", True)

    early_dispatch.schedule_early_remote_dispatch(123, services)
    early_dispatch.schedule_early_remote_dispatch(123, services)

    pending.put.assert_called_once_with((123, services))


def test_schedule_early_remote_dispatch_allows_item_after_worker_releases_slot(monkeypatch):
    pending = SimpleNamespace(put=Mock())
    services = object()
    scheduled: set[int] = set()

    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_PENDING", pending)
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_SCHEDULED", scheduled)
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_WORKERS_STARTED", True)

    early_dispatch.schedule_early_remote_dispatch(123, services)
    scheduled.discard(123)
    early_dispatch.schedule_early_remote_dispatch(123, services)

    assert pending.put.call_count == 2


def test_dispatch_once_shares_one_inflight_result_between_callers(monkeypatch):
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_RESULTS", {})

    started = threading.Event()
    release = threading.Event()
    sentinel = object()
    calls = 0
    calls_lock = threading.Lock()

    def dispatch():
        nonlocal calls
        with calls_lock:
            calls += 1
        started.set()
        assert release.wait(timeout=2)
        return sentinel

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(early_dispatch.dispatch_remote_once, 123, dispatch) for _ in range(4)]
        assert started.wait(timeout=2)
        release.set()
        results = [future.result(timeout=2) for future in futures]

    assert calls == 1
    assert all(result is sentinel for result in results)


def test_dispatch_once_shares_one_inflight_failure_between_callers(monkeypatch):
    monkeypatch.setattr(early_dispatch, "_IRW_EARLY_RESULTS", {})

    started = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def dispatch():
        nonlocal calls
        with calls_lock:
            calls += 1
        started.set()
        assert release.wait(timeout=2)
        raise RuntimeError("remote dispatch failed")

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(early_dispatch.dispatch_remote_once, 456, dispatch) for _ in range(4)]
        assert started.wait(timeout=2)
        release.set()
        for future in futures:
            with pytest.raises(RuntimeError, match="remote dispatch failed"):
                future.result(timeout=2)

    assert calls == 1


def test_schedule_automatic_remote_dispatches_schedules_all_enqueued_items(monkeypatch):
    schedule = Mock()
    services = object()
    helper = SimpleNamespace(get_type=lambda: early_dispatch.AUTOMATIC_MIRROR_NODE_TYPE)
    batch = SimpleNamespace(graph=SimpleNamespace(nodes={early_dispatch.AUTOMATIC_MIRROR_NODE_ID: helper}))
    monkeypatch.setattr(early_dispatch, "schedule_early_remote_dispatch", schedule)

    scheduled = early_dispatch.schedule_automatic_remote_dispatches(
        batch=batch,
        item_ids=[11, 12],
        services=services,
    )

    assert scheduled is True
    assert schedule.call_args_list == [call(11, services), call(12, services)]


def test_schedule_automatic_remote_dispatches_ignores_normal_batches(monkeypatch):
    schedule = Mock()
    services = object()
    batch = SimpleNamespace(graph=SimpleNamespace(nodes={}))
    monkeypatch.setattr(early_dispatch, "schedule_early_remote_dispatch", schedule)

    scheduled = early_dispatch.schedule_automatic_remote_dispatches(
        batch=batch,
        item_ids=[11],
        services=services,
    )

    assert scheduled is False
    schedule.assert_not_called()
