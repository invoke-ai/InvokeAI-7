"""Primary-only cleanup of the exact successful remote worker queue item."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.remote_worker import remote_bridge
from invokeai.app.invocations.remote_worker.remote_client import RemoteInvokeClient


def test_delete_queue_item_uses_authenticated_transport_and_empty_response():
    client = object.__new__(RemoteInvokeClient)
    client._request = Mock(return_value=b"")
    client.delete_queue_item(42, "worker queue")
    client._request.assert_called_once_with("DELETE", "/api/v1/queue/worker%20queue/i/42")


@pytest.fixture
def bridge_environment(monkeypatch):
    events = []
    client = Mock()
    client.config.base_url = "http://worker.test"
    client.get_item.return_value = {"status": "completed"}
    client.extract_image_names.return_value = []
    client.extract_video_names.return_value = []
    client.delete_queue_item.side_effect = lambda **_kwargs: events.append("delete")
    services = SimpleNamespace(logger=SimpleNamespace(info=Mock(), warning=Mock(), error=Mock(), debug=Mock()))
    queue_item = SimpleNamespace(user_id="owner", origin="webv2:primary-job")
    task = remote_bridge._BridgeTask(
        owner_id="owner",
        local_queue_item_id="primary-job",
        local_backend_item_id=321,
        source_origin="webv2:primary-job",
        remote_url="http://worker.test",
        remote_item_id=42,
        remote_queue_id="worker queue",
        remote_slot=2,
        result_destination="gallery",
    )
    monkeypatch.setattr(remote_bridge, "_remote_client", lambda *_args: client)

    def import_media(**_kwargs):
        events.append("import")
        return [SimpleNamespace(video_name="local.mp4")]

    importer = Mock(side_effect=import_media)
    monkeypatch.setattr(remote_bridge, "_import_completed_remote", importer)

    def emit_progress(**kwargs):
        if kwargs["state"] == "completed":
            events.append("completed")

    notifier = Mock(side_effect=emit_progress)
    monkeypatch.setattr(remote_bridge, "_emit_remote_progress", notifier)

    def run(*, keep=False):
        remote_bridge._bridge_worker(
            task_id=900_000_321,
            services=services,
            queue_item=queue_item,
            invocation=SimpleNamespace(id="mirror"),
            local_board_id="my-board",
            keep_remote_copies=keep,
            poll_interval_seconds=0.25,
            timeout_seconds=60,
            task=task,
        )

    return SimpleNamespace(
        run=run,
        events=events,
        client=client,
        services=services,
        importer=importer,
        notifier=notifier,
        task=task,
    )


@pytest.mark.parametrize("keep", [False, True])
def test_success_only_deletes_exact_remote_queue_item_after_import_and_completion(bridge_environment, keep):
    env = bridge_environment
    env.run(keep=keep)
    assert env.events == ["import", "completed", "delete"]
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")
    assert env.importer.call_args.kwargs["keep_remote_copies"] is keep
    env.services.logger.error.assert_not_called()


def test_failed_import_keeps_queue_record_for_recovery(bridge_environment):
    env = bridge_environment
    env.importer.side_effect = RuntimeError("disk full")
    env.run()
    env.client.delete_queue_item.assert_not_called()
    env.services.logger.error.assert_called_once()
    assert "disk full" in env.services.logger.error.call_args.args[0]


def test_failed_worker_item_keeps_queue_record_for_diagnosis(bridge_environment):
    env = bridge_environment
    env.client.get_item.return_value = {"status": "failed", "session": {"errors": {"node": "oops"}}}
    env.run()
    env.importer.assert_not_called()
    env.client.delete_queue_item.assert_not_called()
    env.services.logger.error.assert_called_once()


def test_queue_delete_error_does_not_change_completed_to_failed(bridge_environment):
    env = bridge_environment
    env.client.delete_queue_item.side_effect = RuntimeError("worker disconnected")
    env.run()
    assert env.events == ["import", "completed"]
    env.services.logger.warning.assert_called_once()
    env.services.logger.error.assert_not_called()
    assert "worker disconnected" in env.services.logger.warning.call_args.args[0]


@pytest.mark.parametrize("worker_status", ["canceled", "cancelled", "completed"])
def test_owner_cancel_removes_only_confirmed_terminal_worker_item(bridge_environment, worker_status):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": worker_status}
    env.run()
    env.importer.assert_not_called()
    env.client.cancel_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")
    env.services.logger.error.assert_not_called()


def test_cancel_racing_completed_worker_cleans_remote_media_when_keep_copies_is_off(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "completed", "session": {"results": {}}}
    env.client.extract_image_names.return_value = ["remote.png"]
    env.client.extract_video_names.return_value = ["remote.mp4"]

    env.run(keep=False)

    env.importer.assert_not_called()
    env.client.delete_image.assert_called_once_with("remote.png")
    env.client.delete_video.assert_called_once_with("remote.mp4")
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")
    env.services.logger.error.assert_not_called()


def test_cancel_racing_completed_worker_preserves_remote_media_when_keep_copies_is_on(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "completed", "session": {"results": {}}}
    env.client.extract_image_names.return_value = ["remote.png"]
    env.client.extract_video_names.return_value = ["remote.mp4"]

    env.run(keep=True)

    env.importer.assert_not_called()
    env.client.delete_image.assert_not_called()
    env.client.delete_video.assert_not_called()
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")


def test_cancel_media_cleanup_failure_does_not_block_queue_cleanup(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "completed", "session": {"results": {}}}
    env.client.extract_image_names.return_value = ["remote.png"]
    env.client.extract_video_names.return_value = ["remote.mp4"]
    env.client.delete_image.side_effect = RuntimeError("image cleanup failed")
    env.client.delete_video.side_effect = RuntimeError("video cleanup failed")

    env.run(keep=False)

    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")
    env.services.logger.error.assert_not_called()
    assert env.services.logger.warning.call_count == 2


def test_worker_side_cancellation_is_cleaned_up(bridge_environment):
    env = bridge_environment
    env.client.get_item.return_value = {"status": "canceled"}
    env.run()
    env.importer.assert_not_called()
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")


def test_cancellation_waits_for_terminal_status(bridge_environment, monkeypatch):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.side_effect = [{"status": "in_progress"}, {"status": "canceled"}]
    monkeypatch.setattr(remote_bridge.time, "sleep", lambda _seconds: None)
    env.run()
    assert env.client.get_item.call_count == 2
    env.client.delete_queue_item.assert_called_once_with(item_id=42, queue_id="worker queue")


def test_unconfirmed_cancellation_does_not_delete_active_worker_job(bridge_environment, monkeypatch):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "in_progress"}
    monkeypatch.setattr(remote_bridge.time, "sleep", lambda _seconds: None)
    env.run()
    assert env.client.get_item.call_count == 61
    env.client.delete_queue_item.assert_not_called()
    env.services.logger.warning.assert_called_once()


def test_offline_worker_not_deleted_on_cancellation(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.cancel_queue_item.side_effect = RuntimeError("offline")
    env.client.get_item.side_effect = RuntimeError("offline")
    env.run()
    env.client.delete_queue_item.assert_not_called()
    assert env.services.logger.warning.call_count == 2


def test_failed_worker_after_cancel_stays_for_diagnosis(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "failed"}
    env.run()
    env.client.delete_queue_item.assert_not_called()


def test_canceled_worker_delete_error_does_not_report_render_failure(bridge_environment):
    env = bridge_environment
    env.task.cancel_requested.set()
    env.client.get_item.return_value = {"status": "canceled"}
    env.client.delete_queue_item.side_effect = RuntimeError("offline")
    env.run()
    env.services.logger.error.assert_not_called()
    assert "could not remove" in env.services.logger.warning.call_args.args[0]
