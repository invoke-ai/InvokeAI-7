"""Focused regression coverage for pre-bridge remote model-transfer cancellation."""

import threading
from types import SimpleNamespace

import pytest

from invokeai.app.invocations.remote_worker import diffusers_transfer as receiver
from invokeai.app.invocations.remote_worker import remote_bridge as bridge


@pytest.fixture
def transfer_registry(monkeypatch):
    monkeypatch.setattr(bridge, "_BRIDGE_TASKS", {})
    monkeypatch.setattr(bridge, "_TRANSFER_TASKS", {})
    monkeypatch.setattr(bridge, "_CANCELLED_RUNS", {})
    monkeypatch.setattr(bridge, "_TRANSFER_SEQUENCE", 0)


def _queue(item_id: int, user: str, local_id: str) -> SimpleNamespace:
    return SimpleNamespace(item_id=item_id, user_id=user, origin=f"webv2:{local_id}")


def test_cancel_all_signals_pre_bridge_transfer_and_only_its_owner(transfer_registry):
    first_id, first = bridge.register_model_transfer(_queue(15, "alice", "firstqueue"), "http://worker", "hash")
    other_id, other = bridge.register_model_transfer(_queue(16, "bob", "otherqueue"), "http://worker", "hash")
    result = bridge.cancel_remote_bridges(user_id="alice", local_queue_item_id="firstqueue")
    assert result["failed"] == 0
    assert first.cancel_requested.is_set()
    assert not other.cancel_requested.is_set()
    bridge.unregister_model_transfer(first_id)
    bridge.unregister_model_transfer(other_id)


def test_cancel_before_registration_is_remembered(transfer_registry):
    bridge.cancel_remote_bridges(user_id="alice", local_queue_item_id="firstqueue")
    transfer_id, task = bridge.register_model_transfer(_queue(15, "alice", "firstqueue"), "http://worker", "hash")
    assert task.cancel_requested.is_set()
    bridge.unregister_model_transfer(transfer_id)


def test_scoped_cancel_includes_transfers_without_remote_queue_items(transfer_registry):
    _, task = bridge.register_model_transfer(_queue(15, "alice", "firstqueue"), "http://worker", "hash")
    result = bridge.cancel_remote_bridges_scoped(
        user_id="alice", origin_prefix="webv2:", keep_current=False, queue_service=None
    )
    assert result["failed"] == 0
    assert task.cancel_requested.is_set()


def test_other_generation_keeps_shared_directory_alive(transfer_registry):
    first_id, first = bridge.register_model_transfer(_queue(15, "alice", "firstqueue"), "http://worker", "hash")
    second_id, second = bridge.register_model_transfer(_queue(16, "alice", "secondqueue"), "http://worker", "hash")
    first.cancel_requested.set()
    assert bridge.another_generation_needs_model(first)
    second.cancel_requested.set()
    assert not bridge.another_generation_needs_model(first)
    bridge.unregister_model_transfer(first_id)
    bridge.unregister_model_transfer(second_id)


def test_other_generation_keeps_shared_preparation_alive(transfer_registry):
    first_id, first = bridge.register_model_transfer(_queue(15, "alice", "firstqueue"), "http://worker", "hash")
    second_id, second = bridge.register_model_transfer(_queue(16, "alice", "secondqueue"), "http://worker", "hash")
    first.cancel_requested.set()

    assert not (first.cancel_requested.is_set() and not bridge.another_generation_needs_model(first))

    second.cancel_requested.set()
    assert first.cancel_requested.is_set() and not bridge.another_generation_needs_model(first)

    bridge.unregister_model_transfer(first_id)
    bridge.unregister_model_transfer(second_id)


def test_receiver_cancel_signals_only_live_job(monkeypatch):
    monkeypatch.setattr(
        receiver, "_JOBS", {12: {"id": 12, "status": "downloading"}, 13: {"id": 13, "status": "completed"}}
    )
    events = {12: threading.Event(), 13: threading.Event()}
    monkeypatch.setattr(receiver, "_CANCEL_EVENTS", events)
    assert receiver.cancel_directory_install_job(12)["status"] == "downloading"
    assert events[12].is_set()
    assert receiver.cancel_directory_install_job(13)["status"] == "completed"
    assert not events[13].is_set()
    assert receiver.cancel_directory_install_job(999) is None


def test_receiver_cancel_tolerates_cleanup_window_without_event(monkeypatch):
    monkeypatch.setattr(receiver, "_JOBS", {12: {"id": 12, "status": "downloading"}})
    monkeypatch.setattr(receiver, "_CANCEL_EVENTS", {})

    assert receiver.cancel_directory_install_job(12) == {"id": 12, "status": "downloading"}


def test_receiver_cancelled_job_finalization_releases_state_atomically(monkeypatch):
    job_id = 12
    model_hash = "hash"
    event = threading.Event()
    event.set()
    monkeypatch.setattr(
        receiver,
        "_JOBS",
        {job_id: {"id": job_id, "status": "waiting", "bytes": 0, "total_bytes": 1, "error": None}},
    )
    monkeypatch.setattr(receiver, "_CANCEL_EVENTS", {job_id: event})
    monkeypatch.setattr(receiver, "_ACTIVE_HASHES", {model_hash: job_id})

    services = SimpleNamespace(logger=SimpleNamespace(error=lambda *_args, **_kwargs: None))
    manifest = ("http://worker/token", "model", model_hash, [], 1)

    receiver._run_install(job_id, manifest, services)

    assert receiver._JOBS[job_id]["status"] == "cancelled"
    assert model_hash not in receiver._ACTIVE_HASHES
    assert job_id not in receiver._CANCEL_EVENTS
    assert receiver.cancel_directory_install_job(job_id)["status"] == "cancelled"


def test_receiver_refuses_to_reuse_cancelling_install(monkeypatch):
    monkeypatch.setattr(receiver, "_JOBS", {12: {"id": 12, "status": "downloading"}})
    monkeypatch.setattr(receiver, "_ACTIVE_HASHES", {"hash": 12})
    event = threading.Event()
    event.set()
    monkeypatch.setattr(receiver, "_CANCEL_EVENTS", {12: event})
    monkeypatch.setattr(receiver, "_validated_manifest", lambda _: ("http://worker/token", "model", "hash", [], 1))
    with pytest.raises(ValueError, match="cancellation is still being cleaned up"):
        receiver.start_directory_install({}, object())
