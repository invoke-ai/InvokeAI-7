"""Remote Worker pool cleanup for successful, failed and canceled worker jobs."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.remote_worker import worker_pool
from invokeai.app.invocations.remote_worker.remote_client import RemoteInvokeClient, RemoteInvokeError


def test_delete_queue_item_uses_authenticated_transport_and_empty_response():
    client = object.__new__(RemoteInvokeClient)
    client._request = Mock(return_value=b"")
    client.delete_queue_item(42, "worker queue")
    client._request.assert_called_once_with("DELETE", "/api/v1/queue/worker%20queue/i/42")


@pytest.fixture
def pool_environment(monkeypatch):
    client = Mock()
    client.get_item.return_value = {"status": "completed"}
    client.delete_queue_item = Mock()

    queue_item = SimpleNamespace(item_id=321)
    invocation = SimpleNamespace(id="dispatch")
    services = SimpleNamespace(
        session_queue=SimpleNamespace(complete_queue_item=Mock()),
        logger=SimpleNamespace(info=Mock(), warning=Mock(), error=Mock(), debug=Mock()),
    )
    settings = worker_pool.PoolSettings(
        mode="Distributed",
        workers=(),
        result_destination="gallery",
        local_gallery_board_id="",
        keep_remote_copies=False,
        auto_transfer_missing_models=False,
        model_transfer_host="",
        model_transfer_timeout_seconds=7200,
        poll_interval_seconds=0.25,
        timeout_seconds=60,
    )
    worker = worker_pool.WorkerSpec(url="http://worker.test", name="Remote 2", slot=2)
    local_status = ["in_progress"]

    monkeypatch.setattr(worker_pool, "_helper_for_queue_item", lambda _item: invocation)
    monkeypatch.setattr(worker_pool, "_dispatch_remote", lambda *_args, **_kwargs: (client, 42, "my-board"))
    monkeypatch.setattr(worker_pool, "_emit_started", lambda *_args, **_kwargs: queue_item)
    monkeypatch.setattr(worker_pool, "_emit_progress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(worker_pool, "_emit_result", lambda *_args, **_kwargs: None)
    importer = Mock(return_value=([], []))
    monkeypatch.setattr(worker_pool, "_import_completed", importer)
    monkeypatch.setattr(worker_pool, "_status", lambda *_args, **_kwargs: local_status[0])

    def run():
        return worker_pool._run_remote_job(
            services,
            queue_item,
            settings,
            worker,
            complete_local=True,
        )

    return SimpleNamespace(
        run=run,
        client=client,
        importer=importer,
        local_status=local_status,
        queue_item=queue_item,
        services=services,
        worker=worker,
    )


def test_success_imports_then_deletes_exact_remote_queue_item(pool_environment):
    env = pool_environment
    assert env.run() == "completed"
    env.importer.assert_called_once()
    env.client.delete_queue_item.assert_called_once_with(42, "default")
    env.services.session_queue.complete_queue_item.assert_called_once_with(321)


def test_failed_import_keeps_remote_queue_record(pool_environment):
    env = pool_environment
    env.importer.side_effect = RuntimeError("disk full")
    with pytest.raises(RuntimeError, match="disk full"):
        env.run()
    env.client.delete_queue_item.assert_not_called()
    env.services.session_queue.complete_queue_item.assert_not_called()


def test_failed_worker_item_keeps_remote_queue_record(pool_environment):
    env = pool_environment
    env.client.get_item.return_value = {"status": "failed", "session": {"errors": {"node": "oops"}}}
    with pytest.raises(RemoteInvokeError, match="failed"):
        env.run()
    env.importer.assert_not_called()
    env.client.delete_queue_item.assert_not_called()


def test_queue_delete_error_does_not_change_completed_result(pool_environment):
    env = pool_environment
    env.client.delete_queue_item.side_effect = RuntimeError("worker disconnected")
    assert env.run() == "completed"
    env.services.logger.warning.assert_called_once()
    assert "worker disconnected" in env.services.logger.warning.call_args.args[0]


def test_native_queue_cancellation_cancels_remote_job(pool_environment, monkeypatch):
    env = pool_environment
    env.local_status[0] = "canceled"
    cancel = Mock()
    monkeypatch.setattr(worker_pool, "_cancel_remote", cancel)

    assert env.run() == "canceled"
    cancel.assert_called_once_with(env.client, 42, env.services, env.worker)
    env.importer.assert_not_called()


def test_cancel_remote_deletes_confirmed_canceled_worker_item(monkeypatch):
    client = Mock()
    client.get_item.return_value = {"status": "canceled"}
    services = SimpleNamespace(logger=SimpleNamespace(warning=Mock()))
    worker = worker_pool.WorkerSpec(url="http://worker.test", name="Remote 1", slot=1)

    worker_pool._cancel_remote(client, 42, services, worker)

    client.cancel_queue_item.assert_called_once_with(42, "default")
    client.delete_queue_item.assert_called_once_with(42, "default")
