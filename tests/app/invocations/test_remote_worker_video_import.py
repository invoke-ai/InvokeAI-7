"""Remote Worker final video imports: primary-only, existing image previews untouched."""

import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.remote_worker.remote_bridge import _import_completed_remote
from invokeai.app.invocations.remote_worker.remote_client import RemoteInvokeClient


def test_extract_video_names_from_native_and_list_results():
    item = {
        "session": {
            "results": {
                "video": {"video": {"video_name": "one.mp4"}},
                "batch": {"videos": [{"video_name": "two.mp4"}, {"video_name": "one.mp4"}]},
                "image": {"image": {"image_name": "unrelated.png"}},
            }
        }
    }
    assert RemoteInvokeClient.extract_video_names(item) == ["one.mp4", "two.mp4"]
    assert RemoteInvokeClient.extract_image_names(item, allow_empty=True) == ["unrelated.png"]
    assert (
        RemoteInvokeClient.extract_image_names(
            {"session": {"results": {"video": {"video": {"video_name": "one.mp4"}}}}}, allow_empty=True
        )
        == []
    )


def test_gallery_filter_only_non_intermediate_videos():
    client = object.__new__(RemoteInvokeClient)
    client.get_video_dto = Mock(side_effect=[{"is_intermediate": True}, {"is_intermediate": False}])
    assert client.filter_gallery_video_names(["draft.mp4", "final.mp4"]) == ["final.mp4"]


@pytest.fixture
def environment(tmp_path, monkeypatch):
    # The native video service owns the actual move and thumbnail creation; here
    # we verify its inputs and the bridge's transfer/cleanup/cancellation contract.
    from invokeai.app.invocations.remote_worker import remote_bridge

    monkeypatch.setattr(remote_bridge, "probe_video_with_codec", lambda _path: (640, 480, 1.5, 24.0, "h264"))
    saved = []

    def create_video(**kwargs):
        saved.append((kwargs, Path(kwargs["source_path"]).read_bytes()))
        return SimpleNamespace(video_name="primary.mp4")

    services = SimpleNamespace(
        configuration=SimpleNamespace(multiuser=False, outputs_path=tmp_path),
        videos=SimpleNamespace(create=Mock(side_effect=create_video)),
        images=SimpleNamespace(create=Mock()),
        logger=SimpleNamespace(info=Mock(), warning=Mock()),
    )
    client = Mock()
    client.extract_image_names.return_value = []
    client.extract_video_names.return_value = ["remote.mp4"]
    client.filter_gallery_image_names.return_value = []
    client.filter_gallery_video_names.return_value = ["remote.mp4"]
    client.download_video.return_value = b"mp4 fixture bytes"
    client.get_image_metadata.return_value = None
    client.get_video_metadata.return_value = None
    task = SimpleNamespace(cancel_requested=threading.Event(), import_lock=threading.Lock())
    queue_item = SimpleNamespace(user_id="owner", workflow=None, session=None, session_id="session")
    invocation = SimpleNamespace(id="node")
    return services, client, task, queue_item, invocation, saved, tmp_path


def import_video(environment, *, keep=False):
    services, client, task, queue_item, invocation, *_ = environment
    return _import_completed_remote(
        services=services,
        queue_item=queue_item,
        invocation=invocation,
        client=client,
        completed_item={"session": {"results": {}}},
        local_board_id="board-1",
        result_destination="gallery",
        keep_remote_copies=keep,
        task=task,
    )


def test_video_only_import_uses_configured_outputs_and_native_service(environment):
    services, client, _task, _item, _invocation, saved, output_path = environment
    assert import_video(environment) == [SimpleNamespace(video_name="primary.mp4")]
    assert len(saved) == 1
    args, data = saved[0]
    assert data == b"mp4 fixture bytes"
    assert args["source_path"].parent == output_path / "videos"
    assert args["width"] == 640 and args["duration"] == 1.5 and args["fps"] == 24
    assert args["board_id"] == "board-1" and args["user_id"] == "owner"
    assert args["is_intermediate"] is False
    assert list((output_path / "videos").glob(".irw_remote_*")) == []
    client.delete_video.assert_called_once_with("remote.mp4")
    services.images.create.assert_not_called()


def test_keep_copies_preserves_remote_video(environment):
    _services, client, *_rest = environment
    import_video(environment, keep=True)
    client.delete_video.assert_not_called()


def test_mixed_image_video_import_retains_image_behavior(environment):
    services, client, *_rest = environment
    client.extract_image_names.return_value = ["remote.png"]
    client.filter_gallery_image_names.return_value = ["remote.png"]
    services.images.create.return_value = SimpleNamespace(image_name="primary.png")
    imported = import_video(environment)
    assert [getattr(dto, "image_name", None) or getattr(dto, "video_name", None) for dto in imported] == [
        "primary.png",
        "primary.mp4",
    ]
    services.images.create.assert_called_once()
    client.delete_image.assert_called_once_with("remote.png")
    client.delete_video.assert_called_once_with("remote.mp4")


def test_video_client_uses_existing_authenticated_transport():
    client = object.__new__(RemoteInvokeClient)
    client._request = Mock(return_value=b"mp4")
    client._request_json = Mock(return_value={"is_intermediate": False})
    assert client.download_video("a b.mp4") == b"mp4"
    client._request.assert_called_once_with("GET", "/api/v1/videos/i/a%20b.mp4/full")
    client.get_video_dto("a b.mp4")
    client._request_json.assert_called_with("GET", "/api/v1/videos/i/a%20b.mp4")
    client.delete_video("a b.mp4")
    client._request_json.assert_called_with("DELETE", "/api/v1/videos/i/a%20b.mp4")


def test_failed_import_keeps_remote_video_and_cleans_staging(environment):
    services, client, _task, _item, _invocation, _saved, output_path = environment
    services.videos.create.side_effect = RuntimeError("disk full")
    with pytest.raises(RuntimeError, match="disk full"):
        import_video(environment)
    client.delete_video.assert_not_called()
    assert list((output_path / "videos").glob(".irw_remote_*")) == []


def test_cancelled_import_does_not_download_or_delete(environment):
    _services, client, task, *_rest = environment
    task.cancel_requested.set()
    from invokeai.app.invocations.remote_worker.remote_bridge import RemoteBridgeCancelled

    with pytest.raises(RemoteBridgeCancelled):
        import_video(environment)
    client.download_video.assert_not_called()
    client.delete_video.assert_not_called()


def test_remote_metadata_client_preserves_json_objects_and_null():
    import json

    client = object.__new__(RemoteInvokeClient)
    client._request_json_value = Mock(
        side_effect=[
            {"prompt": "rabbit", "seed": 42, "unicode": "🐰"},
            {"prompt": "video", "fps": 24},
            None,
            None,
        ]
    )
    assert json.loads(client.get_image_metadata("a b.png")) == {"prompt": "rabbit", "seed": 42, "unicode": "🐰"}
    assert json.loads(client.get_video_metadata("x y.mp4")) == {"prompt": "video", "fps": 24}
    assert client.get_image_metadata("blank.png") is None
    assert client.get_video_metadata("blank.mp4") is None
    assert client._request_json_value.call_args_list[0].args == ("GET", "/api/v1/images/i/a%20b.png/metadata")
    assert client._request_json_value.call_args_list[1].args == ("GET", "/api/v1/videos/i/x%20y.mp4/metadata")


def test_remote_image_and_video_metadata_reaches_local_services(environment):
    import json

    services, client, *_ = environment
    client.extract_image_names.return_value = ["remote.png"]
    client.filter_gallery_image_names.return_value = ["remote.png"]
    services.images.create.return_value = SimpleNamespace(image_name="primary.png")
    client.get_image_metadata.return_value = json.dumps({"prompt": "image", "seed": 15})
    client.get_video_metadata.return_value = json.dumps({"prompt": "video", "seed": 27})
    import_video(environment, keep=True)
    assert json.loads(services.images.create.call_args.kwargs["metadata"]) == {"prompt": "image", "seed": 15}
    assert json.loads(services.videos.create.call_args.kwargs["metadata"]) == {"prompt": "video", "seed": 27}
    client.delete_image.assert_not_called()
    client.delete_video.assert_not_called()


def test_failed_metadata_lookup_does_not_delete_remote_media(environment):
    _services, client, *_ = environment
    client.get_video_metadata.side_effect = RuntimeError("metadata unavailable")
    with pytest.raises(RuntimeError, match="metadata unavailable"):
        import_video(environment)
    client.download_video.assert_not_called()
    client.delete_video.assert_not_called()
