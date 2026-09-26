from __future__ import annotations

import json
import logging
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from invokeai.app.invocations.remote_worker.remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError
from invokeai.app.services.board_records.board_records_common import BoardVisibility
from invokeai.app.services.image_records.image_records_common import ImageCategory, ResourceOrigin
from invokeai.app.services.session_processor.session_processor_common import ProgressImage
from invokeai.app.util.video_thumbnails import probe_video_with_codec

_BRIDGE_LOCK = threading.Lock()
# Keep remote imports alive through short primary-to-worker network outages.
_BRIDGE_NETWORK_GRACE_SECONDS = 10 * 60
_REMOTE_CANCEL_REQUEST_TIMEOUT_SECONDS = 2.5
_CANCEL_LOG = logging.getLogger("InvokeAI")


@dataclass
class _TransferTask:
    owner_id: str
    local_queue_item_id: str
    local_backend_item_id: int
    source_origin: str
    remote_url: str
    model_hash: str
    cancel_requested: threading.Event = field(default_factory=threading.Event)
    shared_lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class _BridgeTask:
    owner_id: str
    local_queue_item_id: str
    local_backend_item_id: int
    source_origin: str
    remote_url: str
    remote_item_id: int
    remote_queue_id: str
    remote_slot: int
    result_destination: str
    cancel_requested: threading.Event = field(default_factory=threading.Event)
    import_lock: threading.Lock = field(default_factory=threading.Lock)
    latest_progress: dict[str, Any] | None = None


class RemoteBridgeCancelled(Exception):
    """The owner canceled the local generation and its dispatched remote work."""


_BRIDGE_TASKS: dict[int, _BridgeTask] = {}
_TRANSFER_TASKS: dict[int, _TransferTask] = {}
_TRANSFER_SEQUENCE = 0


def register_model_transfer(queue_item: Any, remote_url: str, model_hash: str) -> tuple[int, _TransferTask]:
    """Register before a remote install exists, closing the pre-bridge cancel race."""
    global _TRANSFER_SEQUENCE
    task = _TransferTask(
        owner_id=str(queue_item.user_id),
        local_queue_item_id=_webv2_queue_item_id(getattr(queue_item, "origin", None)),
        local_backend_item_id=int(queue_item.item_id),
        source_origin=str(getattr(queue_item, "origin", None) or ""),
        remote_url=remote_url,
        model_hash=model_hash,
    )
    with _BRIDGE_LOCK:
        task.shared_lock = next(
            (
                active.shared_lock
                for active in _TRANSFER_TASKS.values()
                if active.remote_url == remote_url and active.model_hash == model_hash
            ),
            task.shared_lock,
        )
        _TRANSFER_SEQUENCE += 1
        transfer_id = _TRANSFER_SEQUENCE
        _TRANSFER_TASKS[transfer_id] = task
        since_uuid = (
            _CANCELLED_RUNS.get((task.owner_id, task.local_queue_item_id)) if task.local_queue_item_id else None
        )
        since_backend = _CANCELLED_BACKEND_ITEMS.get((task.owner_id, task.local_backend_item_id))
        if any(since is not None and time.monotonic() - since <= 600 for since in (since_uuid, since_backend)):
            task.cancel_requested.set()
    return transfer_id, task


def unregister_model_transfer(transfer_id: int) -> None:
    with _BRIDGE_LOCK:
        _TRANSFER_TASKS.pop(transfer_id, None)


def another_generation_needs_model(task: _TransferTask) -> bool:
    """Preserve a shared install while another generation still requires it."""
    with _BRIDGE_LOCK:
        return any(
            other is not task
            and not other.cancel_requested.is_set()
            and other.remote_url == task.remote_url
            and other.model_hash == task.model_hash
            for other in _TRANSFER_TASKS.values()
        )


# A cancel may race with the mirror invocation between remote enqueue and
# bridge registration. Tombstones close that window without guessing item IDs.
_CANCELLED_RUNS: dict[tuple[str, str], float] = {}
_CANCELLED_BACKEND_ITEMS: dict[tuple[str, int], float] = {}
_BRIDGE_SEQUENCE = 0
_REMOTE_MESSAGE_PREFIX = "[[IRW_REMOTE|"


def _remote_queue_item_not_found(exc: Exception) -> bool:
    """A worker 404 after cancellation may mean the bridge already deleted its stopped item."""
    return isinstance(exc, RemoteInvokeError) and "HTTP 404 for /api/v1/queue/" in str(exc)


def _cancel_remote_tasks(tasks: list[_BridgeTask]) -> dict[str, int]:
    """Cancel all selected items, then give the bridge cleanup a short chance to win races."""
    canceled = 0
    already_finished = 0
    pending: list[tuple[_BridgeTask, RemoteInvokeClient, Exception, str]] = []

    # Send every cancellation before checking statuses; do not block other GPUs
    # behind the status check of one worker.
    for task in tasks:
        client = _remote_client(
            task.remote_url,
            task.owner_id,
            request_timeout_seconds=_REMOTE_CANCEL_REQUEST_TIMEOUT_SECONDS,
        )
        try:
            client.cancel_queue_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
            canceled += 1
        except Exception as exc:
            pending.append((task, client, exc, "not checked"))

    # The bridge thread may issue its own cancellation and delete the finished
    # queue record while the foreground request is still in flight. A single GET
    # can therefore see the old running status or a 404 after successful cleanup.
    deadline = time.monotonic() + 2.0
    while pending:
        outstanding: list[tuple[_BridgeTask, RemoteInvokeClient, Exception, str]] = []
        for task, client, cancel_error, _ in pending:
            try:
                item = client.get_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
            except Exception as check_error:
                if _remote_queue_item_not_found(check_error):
                    already_finished += 1
                    continue
                last_status = f"status check failed: {check_error}"
            else:
                status = str(item.get("status", "")).lower()
                if status in {"completed", "failed", "canceled", "cancelled"}:
                    already_finished += 1
                    continue
                last_status = f"worker status: {status or 'unknown'}"
            outstanding.append((task, client, cancel_error, last_status))

        pending = outstanding
        remaining = deadline - time.monotonic()
        if not pending or remaining <= 0:
            break
        time.sleep(min(0.25, remaining))

    for task, _client, cancel_error, last_status in pending:
        _CANCEL_LOG.warning(
            "Remote bridge R%s item %s at %s: cancellation could not be confirmed (%s); request error: %s",
            task.remote_slot,
            task.remote_item_id,
            task.remote_url,
            last_status,
            cancel_error,
        )
    return {
        "matched": len(tasks),
        "canceled": canceled,
        "already_finished": already_finished,
        "failed": len(pending),
    }


def _remember_cancel(
    registry: dict[Any, float],
    key: Any,
    *,
    now: float,
) -> None:
    """Keep a bounded ten-minute tombstone window for registration races."""
    for stale_key, since in list(registry.items()):
        if now - since > 600:
            registry.pop(stale_key, None)
    if key not in registry and len(registry) >= 256:
        registry.pop(next(iter(registry)))
    registry[key] = now


def _finish_cancellation(bridges: list[_BridgeTask], transfers: list[_TransferTask]) -> dict[str, int]:
    """Signal imports first, then cancel matching worker queue items."""
    for bridge in bridges:
        with bridge.import_lock:
            bridge.cancel_requested.set()

    result = _cancel_remote_tasks(bridges)
    result["matched"] += len(transfers)
    result["transfers_signaled"] = len(transfers)
    return result


def cancel_remote_bridges(*, user_id: str, local_queue_item_id: str) -> dict[str, int]:
    """Cancel ONLY matching in-memory bridge jobs for the authenticated owner.

    Signal all jobs before remote HTTP calls, so one slow worker cannot allow
    another worker to import a result while cancellation is in progress.
    """
    with _BRIDGE_LOCK:
        _remember_cancel(_CANCELLED_RUNS, (user_id, local_queue_item_id), now=time.monotonic())
        bridges = [
            task
            for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id and task.local_queue_item_id == local_queue_item_id
        ]
        transfers = [
            transfer
            for transfer in _TRANSFER_TASKS.values()
            if transfer.owner_id == user_id and transfer.local_queue_item_id == local_queue_item_id
        ]
        for transfer in transfers:
            transfer.cancel_requested.set()
    return _finish_cancellation(bridges, transfers)


def cancel_remote_bridges_by_backend_item(*, user_id: str, backend_item_id: int) -> dict[str, int]:
    """Cancel by owner-verified native backend ID before a bridge or UUID exists."""
    with _BRIDGE_LOCK:
        _remember_cancel(_CANCELLED_BACKEND_ITEMS, (user_id, backend_item_id), now=time.monotonic())
        bridges = [
            task
            for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id and task.local_backend_item_id == backend_item_id
        ]
        transfers = [
            task
            for task in _TRANSFER_TASKS.values()
            if task.owner_id == user_id and task.local_backend_item_id == backend_item_id
        ]
        for transfer in transfers:
            transfer.cancel_requested.set()
    return _finish_cancellation(bridges, transfers)


def cancel_remote_bridges_scoped(
    *, user_id: str, origin_prefix: str | None, keep_current: bool, queue_service: Any
) -> dict[str, int]:
    """Cancel the owner's live remote bridges within the queue UI's origin scope.

    Unlike looking up only pending/in-progress *local* queue items, this includes
    remote jobs whose corresponding local queue item has already completed.
    An except-current sweep preserves every in-progress item (multi-GPU), plus
    waiting items, matching the native queue's conservative processor semantics.
    """
    with _BRIDGE_LOCK:
        snapshot = [
            task
            for task in [*_BRIDGE_TASKS.values(), *_TRANSFER_TASKS.values()]
            if task.owner_id == user_id and (origin_prefix is None or task.source_origin.startswith(origin_prefix))
        ]

    if keep_current:
        protected: set[int] = set()
        for task in snapshot:
            if task.local_backend_item_id in protected:
                continue
            try:
                item = queue_service.get_queue_item(task.local_backend_item_id)
            except Exception:
                # Fail closed if queue history is unavailable; don't risk
                # canceling a worker whose local job is still current.
                protected.add(task.local_backend_item_id)
                continue
            if item.status in {"in_progress", "waiting"}:
                protected.add(task.local_backend_item_id)
        snapshot = [task for task in snapshot if task.local_backend_item_id not in protected]

    backend_ids = {task.local_backend_item_id for task in snapshot}
    if not backend_ids:
        return {"matched": 0, "canceled": 0, "already_finished": 0, "failed": 0, "transfers_signaled": 0}

    # Signal every matching bridge before performing any slow remote HTTP call.
    with _BRIDGE_LOCK:
        now = time.monotonic()
        for task in snapshot:
            if task.local_queue_item_id:
                _remember_cancel(_CANCELLED_RUNS, (user_id, task.local_queue_item_id), now=now)
            _remember_cancel(_CANCELLED_BACKEND_ITEMS, (user_id, task.local_backend_item_id), now=now)
        bridges = [
            task
            for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id
            and task.local_backend_item_id in backend_ids
            and (origin_prefix is None or task.source_origin.startswith(origin_prefix))
            and (not keep_current or task.local_backend_item_id not in protected)
        ]
        transfers = [
            task
            for task in _TRANSFER_TASKS.values()
            if task.owner_id == user_id
            and task.local_backend_item_id in backend_ids
            and (origin_prefix is None or task.source_origin.startswith(origin_prefix))
            and (not keep_current or task.local_backend_item_id not in protected)
        ]
        for transfer in transfers:
            transfer.cancel_requested.set()
    return _finish_cancellation(bridges, transfers)


def snapshot_active_remote_bridges(*, user_id: str) -> list[dict[str, Any]]:
    """Authenticated UI replay of live bridges. No remote URLs or credentials."""
    with _BRIDGE_LOCK:
        events = [
            dict(task.latest_progress)
            for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id
            and task.latest_progress is not None
            and not task.cancel_requested.is_set()
            and task.latest_progress["message"].startswith(
                f"{_REMOTE_MESSAGE_PREFIX}{task.local_queue_item_id}|{task.remote_slot}|running"
            )
        ]
    return sorted(events, key=lambda event: (event["item_id"], event["message"]))


def _remote_client(
    remote_url: str,
    user_id: str = "",
    request_timeout_seconds: float = 30.0,
) -> RemoteInvokeClient:
    return RemoteInvokeClient(
        RemoteConfig.from_environment(base_url=remote_url, verify_ssl=False, user_id=user_id),
        request_timeout_seconds=request_timeout_seconds,
    )


def _next_task_id() -> int:
    global _BRIDGE_SEQUENCE
    with _BRIDGE_LOCK:
        _BRIDGE_SEQUENCE += 1
        return 900_000_000 + _BRIDGE_SEQUENCE


def _webv2_queue_item_id(origin: Any) -> str:
    """Extract webv2's client-side queue item UUID from the queue origin string."""
    if not isinstance(origin, str) or not origin:
        return ""
    if ":q:" in origin:
        candidate = origin.rsplit(":q:", 1)[-1].strip()
        if candidate:
            return candidate
    if origin.startswith("webv2:"):
        candidate = origin[len("webv2:") :].strip()
        if candidate and ":" not in candidate:
            return candidate
    return ""


def _copy_model(value: Any) -> Any:
    try:
        return value.model_copy(deep=True)
    except Exception:
        return value


def _model_json(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return value.model_dump_json()
    except Exception:
        try:
            return json.dumps(value, separators=(",", ":"))
        except Exception:
            return None


def _progress_image_from_remote(preview: dict[str, Any]) -> ProgressImage | None:
    raw = preview.get("image")
    if not isinstance(raw, dict):
        return None
    data_url = raw.get("dataURL")
    if not isinstance(data_url, str) or not data_url:
        return None
    try:
        return ProgressImage(
            width=int(raw.get("width")),
            height=int(raw.get("height")),
            dataURL=data_url,
        )
    except Exception:
        return None


def _emit_remote_progress(
    *,
    services: Any,
    queue_item: Any,
    invocation: Any,
    task: _BridgeTask,
    state: str,
    message: str,
    percentage: float | None = None,
    image: ProgressImage | None = None,
    revision: int | None = None,
) -> None:
    # Remote progress uses synthetic frontend sessions rather than local queue item IDs.
    if not task.local_queue_item_id:
        return
    safe_message = str(message or "").replace("\n", " ").strip()
    # A webv2 invoke can create several backend items (iterations). Include the
    # originating backend ID so each R1/R2 preview has an independent identity.
    source_backend_id = task.local_backend_item_id
    suffix = f"|{source_backend_id}" if source_backend_id > 0 else ""
    tagged = f"{_REMOTE_MESSAGE_PREFIX}{task.local_queue_item_id}|{task.remote_slot}|{state}{suffix}]] {safe_message}"
    # Retain the last UI event for owner-scoped replay after the local dispatch completes.
    preview = None
    if image is not None and len(image.dataURL) <= 512_000:
        preview = {"width": image.width, "height": image.height, "dataURL": image.dataURL}
    with _BRIDGE_LOCK:
        previous = task.latest_progress or {}
        task.latest_progress = {
            "queue_id": str(getattr(queue_item, "queue_id", "default")),
            "item_id": source_backend_id,
            "batch_id": str(getattr(queue_item, "batch_id", "")),
            "origin": task.source_origin,
            "destination": task.result_destination,
            "timestamp": time.time(),
            "user_id": task.owner_id,
            "session_id": str(getattr(queue_item, "session_id", "")),
            "invocation_source_id": str(getattr(invocation, "id", "")),
            "message": tagged,
            "percentage": percentage,
            "image": preview if preview is not None else previous.get("image"),
            "revision": revision,
            "device": None,
        }
    services.events.emit_invocation_progress(
        queue_item=queue_item,
        invocation=invocation,
        message=tagged,
        percentage=percentage,
        image=image,
        revision=revision,
    )


def _assert_background_save_access(services: Any, user_id: str | None, board_id: str | None) -> None:
    if not getattr(services.configuration, "multiuser", False):
        return
    user = services.users.get(user_id)
    if user is None or not user.is_active:
        raise PermissionError("Queue user is not authorized to save returned remote images")
    if board_id:
        board = services.boards.get_dto(board_id)
        if not user.is_admin and board.user_id != user_id and board.board_visibility != BoardVisibility.Public:
            raise PermissionError("Queue user is not authorized to save returned remote images to this board")


def _save_local_image(
    *,
    services: Any,
    queue_item: Any,
    invocation: Any,
    image: Any,
    metadata: str | None,
    board_id: str,
    result_destination: str,
) -> Any:
    user_id = getattr(queue_item, "user_id", None)
    target_board_id = (board_id.strip() or None) if result_destination == "gallery" else None
    _assert_background_save_access(services, user_id, target_board_id)

    workflow_json = _model_json(getattr(queue_item, "workflow", None))
    session = getattr(queue_item, "session", None)
    graph_json = _model_json(getattr(session, "graph", None))

    return services.images.create(
        image=image,
        is_intermediate=False,
        # Canvas candidates are durable, but not normal Gallery entries.
        image_category=ImageCategory.OTHER if result_destination == "canvas" else ImageCategory.GENERAL,
        board_id=target_board_id,
        metadata=metadata,
        image_origin=ResourceOrigin.INTERNAL,
        workflow=workflow_json,
        graph=graph_json,
        session_id=getattr(queue_item, "session_id", None),
        node_id=getattr(invocation, "id", None),
        user_id=user_id,
    )


def _save_local_video(
    *,
    services: Any,
    queue_item: Any,
    invocation: Any,
    video_bytes: bytes,
    metadata: str | None,
    board_id: str,
    result_destination: str,
) -> Any:
    """Stage one MP4 alongside outputs/videos; the native service moves it into storage."""
    user_id = getattr(queue_item, "user_id", None)
    target_board_id = (board_id.strip() or None) if result_destination == "gallery" else None
    _assert_background_save_access(services, user_id, target_board_id)

    # Using the configured output path avoids hard-coded Windows/POSIX paths and
    # normally lets the native video service move rather than copy across disks.
    outputs_path = services.configuration.outputs_path
    if outputs_path is None:
        raise RemoteInvokeError("Primary InvokeAI has no configured outputs path for video import")
    stage_dir = Path(outputs_path) / "videos"
    stage_dir.mkdir(parents=True, exist_ok=True)
    stage_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".irw_remote_", suffix=".mp4", dir=stage_dir, delete=False) as file:
            stage_path = Path(file.name)
            file.write(video_bytes)
        # The file is closed before probing/moving: required by Windows.
        width, height, duration, fps, _codec = probe_video_with_codec(stage_path)
        workflow_json = _model_json(getattr(queue_item, "workflow", None))
        session = getattr(queue_item, "session", None)
        graph_json = _model_json(getattr(session, "graph", None))
        return services.videos.create(
            source_path=stage_path,
            width=width,
            height=height,
            duration=duration,
            fps=fps,
            video_origin=ResourceOrigin.INTERNAL,
            video_category=ImageCategory.OTHER if result_destination == "canvas" else ImageCategory.GENERAL,
            board_id=target_board_id,
            is_intermediate=False,
            metadata=metadata,
            workflow=workflow_json,
            graph=graph_json,
            session_id=getattr(queue_item, "session_id", None),
            node_id=getattr(invocation, "id", None),
            user_id=user_id,
        )
    finally:
        # The native video service moves the source on success. On error (including
        # failed validation), never leave partial/staged files behind.
        if stage_path is not None:
            stage_path.unlink(missing_ok=True)


def _cleanup_remote_media(
    *,
    client: RemoteInvokeClient,
    image_names: list[str],
    video_names: list[str],
    services: Any,
    reason: str,
) -> None:
    """Best-effort cleanup after the primary no longer needs worker media."""
    deleted_images = 0
    deleted_videos = 0
    for remote_name in image_names:
        try:
            client.delete_image(remote_name)
            deleted_images += 1
        except Exception as exc:
            services.logger.warning(f"Remote bridge: {reason}; remote image cleanup failed for {remote_name}: {exc}")
    for remote_name in video_names:
        try:
            client.delete_video(remote_name)
            deleted_videos += 1
        except Exception as exc:
            services.logger.warning(f"Remote bridge: {reason}; remote video cleanup failed for {remote_name}: {exc}")
    services.logger.info(
        f"Remote bridge: remote cleanup deleted {deleted_images}/{len(image_names)} image(s), "
        f"{deleted_videos}/{len(video_names)} video(s)"
    )


def _import_completed_remote(
    *,
    services: Any,
    queue_item: Any,
    invocation: Any,
    client: RemoteInvokeClient,
    completed_item: dict[str, Any],
    local_board_id: str,
    result_destination: str,
    keep_remote_copies: bool,
    task: _BridgeTask,
) -> list[Any]:
    all_remote_names = client.extract_image_names(completed_item, non_intermediate_only=False, allow_empty=True)
    all_video_names = client.extract_video_names(completed_item)
    remote_names = client.filter_gallery_image_names(all_remote_names)
    remote_video_names = client.filter_gallery_video_names(all_video_names)
    if result_destination == "canvas":
        # Canvas may fall back to the final output even when it is intermediate.
        if not remote_names:
            remote_names = [all_remote_names[-1]] if all_remote_names else []
        if not remote_video_names:
            remote_video_names = [all_video_names[-1]] if all_video_names else []
    if not remote_names and not remote_video_names:
        raise RemoteInvokeError("Remote render completed, but no image or video outputs are marked Save to Gallery")

    imported: list[Any] = []
    for remote_name in remote_names:
        if task.cancel_requested.is_set():
            raise RemoteBridgeCancelled()
        image_metadata = client.get_image_metadata(remote_name)
        image = client.download_image(remote_name)
        # Serialize the actual local save against the cancellation flag. Once
        # Cancel is acknowledged, a late download cannot create a local image.
        with task.import_lock:
            if task.cancel_requested.is_set():
                raise RemoteBridgeCancelled()
            dto = _save_local_image(
                services=services,
                queue_item=queue_item,
                invocation=invocation,
                image=image,
                metadata=image_metadata,
                board_id=local_board_id,
                result_destination=result_destination,
            )
        imported.append(dto)
        services.logger.info(
            f"Remote bridge: imported {remote_name} as {dto.image_name}"
            + (f" on board {local_board_id}" if local_board_id else "")
        )

    for remote_name in remote_video_names:
        if task.cancel_requested.is_set():
            raise RemoteBridgeCancelled()
        video_metadata = client.get_video_metadata(remote_name)
        video_bytes = client.download_video(remote_name)
        # Honor cancellation before the local video becomes visible in Gallery.
        with task.import_lock:
            if task.cancel_requested.is_set():
                raise RemoteBridgeCancelled()
            dto = _save_local_video(
                services=services,
                queue_item=queue_item,
                invocation=invocation,
                video_bytes=video_bytes,
                metadata=video_metadata,
                board_id=local_board_id,
                result_destination=result_destination,
            )
        imported.append(dto)
        services.logger.info(
            f"Remote bridge: imported video {remote_name} as {dto.video_name}"
            + (f" on board {local_board_id}" if local_board_id else "")
        )

    if task.cancel_requested.is_set():
        raise RemoteBridgeCancelled()
    # Do not remove ANY remote results unless the complete requested import succeeded.
    if not keep_remote_copies:
        _cleanup_remote_media(
            client=client,
            image_names=all_remote_names,
            video_names=all_video_names,
            services=services,
            reason="local import succeeded",
        )

    return imported


def _remove_canceled_worker_queue_item(
    *,
    client: RemoteInvokeClient,
    remote_item_id: int,
    remote_queue_id: str,
    services: Any,
    task_id: int,
    keep_remote_copies: bool,
) -> None:
    """Remove only this item after confirming it is no longer rendering.

    The cancellation API already sends a cancel request for owner-owned jobs.
    Repeating it here covers registration races and worker-side cancellation.
    This is a background thread; never delay a user-facing HTTP cancellation.
    """
    try:
        client.cancel_queue_item(item_id=remote_item_id, queue_id=remote_queue_id)
    except Exception as exc:
        services.logger.warning(f"Remote bridge #{task_id}: worker cancellation request: {exc}")

    for attempt in range(61):
        try:
            item = client.get_item(item_id=remote_item_id, queue_id=remote_queue_id)
        except Exception as exc:
            services.logger.warning(
                f"Remote bridge #{task_id}: could not confirm worker item {remote_item_id} stopped: {exc}"
            )
            return
        status = str(item.get("status", "")).lower()
        if status in {"completed", "canceled", "cancelled"}:
            if not keep_remote_copies:
                try:
                    image_names = client.extract_image_names(
                        item,
                        non_intermediate_only=False,
                        allow_empty=True,
                    )
                except Exception as exc:
                    image_names = []
                    services.logger.debug(
                        f"Remote bridge #{task_id}: could not inspect canceled worker images for cleanup: {exc}"
                    )
                try:
                    video_names = client.extract_video_names(item)
                except Exception as exc:
                    video_names = []
                    services.logger.debug(
                        f"Remote bridge #{task_id}: could not inspect canceled worker videos for cleanup: {exc}"
                    )
                _cleanup_remote_media(
                    client=client,
                    image_names=image_names,
                    video_names=video_names,
                    services=services,
                    reason=f"worker item {remote_item_id} was canceled",
                )
            try:
                client.delete_queue_item(item_id=remote_item_id, queue_id=remote_queue_id)
            except Exception as exc:
                services.logger.warning(
                    f"Remote bridge #{task_id}: could not remove canceled worker item {remote_item_id}: {exc}"
                )
            return
        if status == "failed":
            # Failed jobs remain for diagnosis, even if cancellation raced them.
            return
        if attempt < 60:
            time.sleep(0.5)
    services.logger.warning(
        f"Remote bridge #{task_id}: worker item {remote_item_id} did not stop in time; leaving its queue record"
    )


def _bridge_timeout_state(
    *,
    status: str,
    now: float,
    queued_started: float,
    rendering_started: float | None,
    timeout_seconds: int,
) -> tuple[float | None, str | None]:
    """Give queueing and rendering independent deadlines; terminal states always win."""
    if status in {"completed", "failed", "canceled", "cancelled"}:
        return rendering_started, None
    if rendering_started is None and status in {"in_progress", "running"}:
        rendering_started = now
    phase_started = rendering_started if rendering_started is not None else queued_started
    if now - phase_started > float(timeout_seconds):
        return rendering_started, "rendering" if rendering_started is not None else "queued"
    return rendering_started, None


def _bridge_worker(
    *,
    task_id: int,
    services: Any,
    queue_item: Any,
    invocation: Any,
    local_board_id: str,
    keep_remote_copies: bool,
    poll_interval_seconds: float,
    timeout_seconds: int,
    task: _BridgeTask,
) -> None:
    remote_url = task.remote_url
    remote_item_id = task.remote_item_id
    remote_queue_id = task.remote_queue_id
    remote_slot = task.remote_slot
    result_destination = task.result_destination
    client = _remote_client(remote_url, str(queue_item.user_id))
    queued_started = time.monotonic()
    rendering_started: float | None = None
    last_preview_signature: tuple[Any, Any, Any] | None = None
    transient_errors = 0
    network_failure_started: float | None = None
    rendering_announced = False

    services.logger.info(
        f"Remote bridge #{task_id}: watching {client.config.base_url} item {remote_item_id} as Remote {remote_slot}"
    )
    if not task.local_queue_item_id:
        services.logger.warning(
            f"Remote bridge #{task_id}: could not identify the webv2 queue item from origin "
            f"{getattr(queue_item, 'origin', None)!r}; live remote preview will be unavailable, "
            "but immediate final-image return will still run"
        )

    try:
        # Emit queued placeholders before the first remote progress frame.
        if result_destination in {"canvas", "gallery"}:
            _emit_remote_progress(
                services=services,
                queue_item=queue_item,
                invocation=invocation,
                task=task,
                state="running",
                message=f"Remote {remote_slot} queued",
            )
        while True:
            if task.cancel_requested.is_set():
                raise RemoteBridgeCancelled()
            try:
                item = client.get_item(item_id=remote_item_id, queue_id=remote_queue_id)
                if network_failure_started is not None:
                    services.logger.info(
                        f"Remote bridge #{task_id}: reconnected to item {remote_item_id} after "
                        f"{time.monotonic() - network_failure_started:.0f}s; resuming progress and import"
                    )
                network_failure_started = None
                transient_errors = 0
            except Exception as exc:
                transient_errors += 1
                # Only transport failures receive the longer grace; API/auth failures remain bounded.
                transport_error = isinstance(exc, (ConnectionError, TimeoutError)) or (
                    isinstance(exc, RemoteInvokeError) and "Could not reach remote InvokeAI at " in str(exc)
                )
                if transport_error:
                    now = time.monotonic()
                    if network_failure_started is None:
                        network_failure_started = now
                    offline_seconds = now - network_failure_started
                    if offline_seconds >= _BRIDGE_NETWORK_GRACE_SECONDS:
                        raise RemoteInvokeError(
                            f"Lost contact with remote item {remote_item_id} for "
                            f"{offline_seconds:.0f}s (network grace exceeded): {exc}"
                        ) from exc
                    if transient_errors == 1 or transient_errors % 10 == 0:
                        services.logger.warning(
                            f"Remote bridge #{task_id}: temporary network outage "
                            f"({offline_seconds:.0f}s/{_BRIDGE_NETWORK_GRACE_SECONDS}s grace; "
                            f"attempt {transient_errors}): {exc}"
                        )
                else:
                    network_failure_started = None
                    if transient_errors >= 8:
                        raise RemoteInvokeError(
                            f"Remote item {remote_item_id} status failed after {transient_errors} attempts: {exc}"
                        ) from exc
                    services.logger.warning(
                        f"Remote bridge #{task_id}: temporary status error ({transient_errors}/8): {exc}"
                    )
                if task.cancel_requested.wait(max(0.25, float(poll_interval_seconds))):
                    raise RemoteBridgeCancelled()
                continue

            if task.cancel_requested.is_set():
                raise RemoteBridgeCancelled()
            status = str(item.get("status", "")).lower()
            if status == "completed":
                imported = _import_completed_remote(
                    services=services,
                    queue_item=queue_item,
                    invocation=invocation,
                    client=client,
                    completed_item=item,
                    local_board_id=local_board_id,
                    result_destination=result_destination,
                    keep_remote_copies=keep_remote_copies,
                    task=task,
                )
                if task.cancel_requested.is_set():
                    raise RemoteBridgeCancelled()
                final_name = (
                    getattr(imported[-1], "image_name", None) or getattr(imported[-1], "video_name", "remote media")
                    if imported
                    else "remote media"
                )
                message = f"Remote {remote_slot} complete: {final_name}"
                if result_destination == "canvas":
                    # Canvas's staging marker is image-only; never pass video names as images.
                    names = [dto.image_name for dto in imported if getattr(dto, "image_name", None)]
                    if names:
                        message += " [[IRW_CANVAS_IMAGES|" + json.dumps(names, separators=(",", ":")) + "]]"
                _emit_remote_progress(
                    services=services,
                    queue_item=queue_item,
                    invocation=invocation,
                    task=task,
                    state="completed",
                    message=message,
                    percentage=1.0,
                    revision=None,
                )
                services.logger.info(
                    f"Remote bridge #{task_id}: item {remote_item_id} completed; imported {len(imported)} media output(s)"
                )
                # Remove only this successfully imported queue record; failed items stay for diagnosis.
                # Queue-record cleanup is independent of whether remote media copies are retained.
                try:
                    client.delete_queue_item(item_id=remote_item_id, queue_id=remote_queue_id)
                except Exception as exc:
                    # Cleanup failure must never turn a successfully imported generation
                    # into a reported failure or trigger a second remote transfer.
                    services.logger.warning(
                        f"Remote bridge #{task_id}: imported media, but could not remove "
                        f"remote queue item {remote_item_id}: {exc}"
                    )
                return

            if status in {"canceled", "cancelled"}:
                # Also handle cancellation directly from the worker UI.
                raise RemoteBridgeCancelled()

            if status == "failed":
                errors = item.get("session", {}).get("errors", {}) if isinstance(item.get("session"), dict) else {}
                raise RemoteInvokeError(
                    f"Remote queue item {remote_item_id} ended with status '{status}'. Errors: {json.dumps(errors)[:3000]}"
                )

            was_rendering = rendering_started is not None
            rendering_started, timed_out_phase = _bridge_timeout_state(
                status=status,
                now=time.monotonic(),
                queued_started=queued_started,
                rendering_started=rendering_started,
                timeout_seconds=timeout_seconds,
            )
            if not was_rendering and rendering_started is not None:
                services.logger.info(
                    f"Remote bridge #{task_id}: item {remote_item_id} began rendering "
                    f"after {rendering_started - queued_started:.0f}s queued"
                )
            if timed_out_phase is not None:
                raise RemoteInvokeError(
                    f"Remote queue item {remote_item_id} {timed_out_phase} timed out after {timeout_seconds:g} seconds"
                )

            if status not in {"in_progress", "running"}:
                # Keep queued placeholders out of Preview until the worker is actually rendering.
                if task.cancel_requested.wait(max(0.25, float(poll_interval_seconds))):
                    raise RemoteBridgeCancelled()
                continue

            if not rendering_announced:
                rendering_announced = True
                # This arrives at the actual worker state transition, even when
                # there is not yet a first denoising frame or percent update.
                _emit_remote_progress(
                    services=services,
                    queue_item=queue_item,
                    invocation=invocation,
                    task=task,
                    state="running",
                    message=f"Remote {remote_slot} rendering",
                )

            try:
                preview = client.get_progress_preview(item_id=remote_item_id, queue_id=remote_queue_id)
            except Exception as exc:
                # Retained previews are optional; status/final-result polling must continue without them.
                services.logger.debug(f"Remote bridge #{task_id}: progress preview unavailable: {exc}")
                preview = None

            if preview:
                revision = preview.get("revision")
                percentage = preview.get("percentage")
                message = str(preview.get("message") or f"Remote {remote_slot} rendering")
                signature = (revision, percentage, message)
                if signature != last_preview_signature:
                    try:
                        pct = float(percentage) if percentage is not None else None
                    except (TypeError, ValueError):
                        pct = None
                    try:
                        rev = int(revision) if revision is not None else None
                    except (TypeError, ValueError):
                        rev = None
                    _emit_remote_progress(
                        services=services,
                        queue_item=queue_item,
                        invocation=invocation,
                        task=task,
                        state="running",
                        message=message,
                        percentage=pct,
                        image=_progress_image_from_remote(preview),
                        revision=rev,
                    )
                    last_preview_signature = signature

            if task.cancel_requested.wait(max(0.25, float(poll_interval_seconds))):
                raise RemoteBridgeCancelled()

    except RemoteBridgeCancelled:
        services.logger.info(f"Remote bridge #{task_id}: cancelled")
        _remove_canceled_worker_queue_item(
            client=client,
            remote_item_id=remote_item_id,
            remote_queue_id=remote_queue_id,
            services=services,
            task_id=task_id,
            keep_remote_copies=keep_remote_copies,
        )
        _emit_remote_progress(
            services=services,
            queue_item=queue_item,
            invocation=invocation,
            task=task,
            state="failed",
            message=f"Remote {remote_slot} cancelled",
        )
    except Exception as exc:
        services.logger.error(f"Remote bridge #{task_id}: {exc}")
        try:
            _emit_remote_progress(
                services=services,
                queue_item=queue_item,
                invocation=invocation,
                task=task,
                state="failed",
                message=str(exc),
                percentage=None,
                revision=None,
            )
        except Exception as emit_exc:
            services.logger.debug(f"Remote bridge #{task_id}: could not emit failure marker: {emit_exc}")
    finally:
        with _BRIDGE_LOCK:
            _BRIDGE_TASKS.pop(task_id, None)


def start_remote_bridge(
    *,
    services: Any,
    local_queue_item: Any,
    source_invocation: Any,
    remote_url: str,
    remote_item_id: int,
    remote_queue_id: str,
    local_board_id: str,
    result_destination: str,
    keep_remote_copies: bool,
    poll_interval_seconds: float,
    timeout_seconds: int,
    remote_slot: int,
) -> int:
    """Start a long-lived remote progress/final-image bridge without retaining InvocationContext."""
    task_id = _next_task_id()
    queue_item = _copy_model(local_queue_item)
    invocation = _copy_model(source_invocation)
    # Prepare the source mapping on the copied queue item, never the live queue record.
    queue_item.session.prepared_source_mapping.setdefault(invocation.id, invocation.id)
    task = _BridgeTask(
        owner_id=str(queue_item.user_id),
        local_queue_item_id=_webv2_queue_item_id(getattr(queue_item, "origin", None)),
        local_backend_item_id=int(queue_item.item_id),
        source_origin=str(getattr(queue_item, "origin", None) or ""),
        remote_url=remote_url,
        remote_item_id=int(remote_item_id),
        remote_queue_id=remote_queue_id,
        remote_slot=int(remote_slot),
        result_destination=result_destination,
    )

    thread = threading.Thread(
        target=_bridge_worker,
        kwargs={
            "task_id": task_id,
            "services": services,
            "queue_item": queue_item,
            "invocation": invocation,
            "local_board_id": local_board_id,
            "keep_remote_copies": bool(keep_remote_copies),
            "poll_interval_seconds": float(poll_interval_seconds),
            "timeout_seconds": int(timeout_seconds),
            "task": task,
        },
        name=f"invokeai-remote-bridge-{task_id}",
        daemon=True,
    )
    with _BRIDGE_LOCK:
        _BRIDGE_TASKS[task_id] = task
        since_uuid = (
            _CANCELLED_RUNS.get((task.owner_id, task.local_queue_item_id)) if task.local_queue_item_id else None
        )
        since_backend = _CANCELLED_BACKEND_ITEMS.get((task.owner_id, task.local_backend_item_id))
        canceled_while_registering = any(
            since is not None and time.monotonic() - since <= 600 for since in (since_uuid, since_backend)
        )
        if canceled_while_registering:
            task.cancel_requested.set()
    thread.start()
    if canceled_while_registering:
        try:
            _remote_client(remote_url, task.owner_id).cancel_queue_item(remote_item_id, remote_queue_id)
        except Exception as exc:
            services.logger.warning(f"Remote bridge #{task_id}: late-start cancellation failed: {exc}")
    return task_id
