"""Regression tests: cancel queued remote installs before render-bridge registration."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from invokeai.app.api.routers import remote_workers
from invokeai.app.invocations.remote_worker import remote_bridge as bridge
from invokeai.app.invocations.remote_worker import remote_nodes as nodes


@pytest.fixture
def registry(monkeypatch):
    monkeypatch.setattr(bridge, "_BRIDGE_TASKS", {})
    monkeypatch.setattr(bridge, "_TRANSFER_TASKS", {})
    monkeypatch.setattr(bridge, "_CANCELLED_RUNS", {})
    monkeypatch.setattr(bridge, "_CANCELLED_BACKEND_ITEMS", {})
    monkeypatch.setattr(bridge, "_TRANSFER_SEQUENCE", 0)


def item(item_id: int, user: str = "alice", origin: str = "manual:render") -> SimpleNamespace:
    return SimpleNamespace(item_id=item_id, user_id=user, queue_id="default", origin=origin)


def test_remote_cancel_uses_short_request_timeout(registry, monkeypatch):
    timeouts = []

    class Client:
        def __init__(self, _config, request_timeout_seconds=30.0):
            timeouts.append(request_timeout_seconds)

        def cancel_queue_item(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(bridge, "RemoteInvokeClient", Client)
    task = bridge._BridgeTask(
        owner_id="alice",
        local_queue_item_id="queue-id",
        local_backend_item_id=298108,
        source_origin="webv2:project:q:queue-id",
        remote_url="http://worker2",
        remote_item_id=51,
        remote_queue_id="default",
        remote_slot=1,
        result_destination="gallery",
    )

    result = bridge._cancel_remote_tasks([task])

    assert result["canceled"] == 1
    assert result["failed"] == 0
    assert timeouts == [bridge._REMOTE_CANCEL_REQUEST_TIMEOUT_SECONDS]


def test_x_signals_prebridge_transfer_by_backend_id(registry, monkeypatch):
    queue_item = item(298108)
    _, transfer = bridge.register_model_transfer(queue_item, "http://worker2", "hash")
    monkeypatch.setattr(
        remote_workers.ApiDependencies,
        "invoker",
        SimpleNamespace(services=SimpleNamespace(session_queue=SimpleNamespace(get_queue_item=lambda _: queue_item))),
        raising=False,
    )
    result = remote_workers.cancel_remote_worker_backend_item(
        SimpleNamespace(user_id="alice"), remote_workers.RemoteWorkerCancelByBackendItemRequest(item_id=298108)
    )
    assert (result.matched, result.transfers_signaled, result.failed) == (1, 1, 0)
    assert transfer.cancel_requested.is_set()


def test_owner_is_enforced(registry, monkeypatch):
    queue_item = item(298108, user="bob")
    _, transfer = bridge.register_model_transfer(queue_item, "http://worker2", "hash")
    monkeypatch.setattr(
        remote_workers.ApiDependencies,
        "invoker",
        SimpleNamespace(services=SimpleNamespace(session_queue=SimpleNamespace(get_queue_item=lambda _: queue_item))),
        raising=False,
    )
    with pytest.raises(HTTPException) as exc:
        remote_workers.cancel_remote_worker_backend_item(
            SimpleNamespace(user_id="alice"), remote_workers.RemoteWorkerCancelByBackendItemRequest(item_id=298108)
        )
    assert exc.value.status_code == 403
    assert not transfer.cancel_requested.is_set()


def test_cancel_before_registration_and_requeue_is_independent(registry):
    result = bridge.cancel_remote_bridges_by_backend_item(user_id="alice", backend_item_id=298108)
    assert result["matched"] == 0
    _, late = bridge.register_model_transfer(item(298108), "http://worker2", "hash")
    _, next_queue = bridge.register_model_transfer(item(298109), "http://worker2", "hash")
    assert late.cancel_requested.is_set()
    assert not next_queue.cancel_requested.is_set()


def test_cancel_all_covers_uuidless_transfers_and_keeps_other_users(registry):
    _, first = bridge.register_model_transfer(item(298108), "http://worker2", "hash")
    _, other = bridge.register_model_transfer(item(298109, user="bob"), "http://worker2", "hash")
    result = bridge.cancel_remote_bridges_scoped(
        user_id="alice", origin_prefix="manual:", keep_current=False, queue_service=None
    )
    assert result["matched"] == result["transfers_signaled"] == 1
    assert first.cancel_requested.is_set()
    assert not other.cancel_requested.is_set()


def test_scoped_cancel_keeps_tombstone_registries_bounded(registry):
    for index in range(300):
        bridge.register_model_transfer(
            item(
                300_000 + index,
                origin=f"webv2:project:q:queue-{index}",
            ),
            "http://worker2",
            f"hash-{index}",
        )

    result = bridge.cancel_remote_bridges_scoped(
        user_id="alice",
        origin_prefix=None,
        keep_current=False,
        queue_service=None,
    )

    assert result["matched"] == result["transfers_signaled"] == 300
    assert len(bridge._CANCELLED_RUNS) == 256
    assert len(bridge._CANCELLED_BACKEND_ITEMS) == 256


def test_cancel_shared_model_only_signals_one_generation(registry):
    _, first = bridge.register_model_transfer(item(298108), "http://worker2", "same-hash")
    _, second = bridge.register_model_transfer(item(298109), "http://worker2", "same-hash")
    bridge.cancel_remote_bridges_by_backend_item(user_id="alice", backend_item_id=298108)
    assert first.cancel_requested.is_set()
    assert not second.cancel_requested.is_set()
    assert bridge.another_generation_needs_model(first)


@pytest.mark.parametrize("directory", [False, True])
def test_cancel_running_model_sends_worker_delete(registry, monkeypatch, tmp_path, directory):
    source = tmp_path / ("directory_model" if directory else "model.safetensors")
    if directory:
        source.mkdir()
        (source / "model_index.json").write_text("{}")
    else:
        source.write_bytes(b"checkpoint")
    model = SimpleNamespace(path=source, hash="hash", name="model")
    queue_item = item(298108)
    queue_item.status = "in_progress"
    services = SimpleNamespace(session_queue=SimpleNamespace(get_queue_item=lambda _: queue_item))
    context = SimpleNamespace(
        _data=SimpleNamespace(queue_item=queue_item),
        _services=services,
        logger=SimpleNamespace(warning=lambda *args: None, info=lambda *args: None),
    )
    events = []
    monkeypatch.setattr(nodes, "resolve_local_model_file", lambda *_: model)
    monkeypatch.setattr(nodes, "_emit_model_transfer_progress", lambda **kwargs: events.append(kwargs["phase"]))

    class TempServer:
        url = "http://primary/token/model.safetensors"

        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    class TempDirectoryServer(TempServer):
        def __init__(self, **kwargs):
            self.files = [SimpleNamespace(size=0)]

        def manifest(self, **kwargs):
            return {"name": "model"}

    monkeypatch.setattr(nodes, "TemporaryModelServer", TempServer)
    monkeypatch.setattr(nodes, "TemporaryDirectoryModelServer", TempDirectoryServer)

    class Client:
        config = SimpleNamespace(base_url="http://worker2")

        def __init__(self):
            self.deleted = []
            self.polls = 0

        def get_model_by_hash(self, _):
            return None

        def install_model_from_url(self, *_args, **_kwargs):
            return {"id": 14, "status": "downloading"}

        def install_directory_from_manifest(self, *_args, **_kwargs):
            return {"id": 14, "status": "downloading"}

        def get_directory_install_job(self, job_id):
            return self.get_model_install_job(job_id)

        def get_model_install_job(self, _):
            self.polls += 1
            if self.polls == 1:
                bridge.cancel_remote_bridges_by_backend_item(user_id="alice", backend_item_id=298108)
            return {"status": "cancelled" if self.deleted else "downloading"}

        def _request(self, method, path):
            self.deleted.append((method, path))

    client = Client()
    with pytest.raises(nodes.RemoteModelTransferCancelled):
        nodes._transfer_missing_model_to_remote(
            context=context,
            invocation=object(),
            remote_client=client,
            remote_index=2,
            identifier={"key": "key"},
            transfer_host="",
            timeout_seconds=60,
        )
    path = "/api/v1/remote_workers/diffusers/install/14" if directory else "/api/v2/models/install/14"
    assert client.deleted == [("DELETE", path)]
    assert events[-1] == "cancelled"
    assert bridge._TRANSFER_TASKS == {}
