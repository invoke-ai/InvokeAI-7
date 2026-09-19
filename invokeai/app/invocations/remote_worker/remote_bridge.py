from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from invokeai.app.services.board_records.board_records_common import BoardVisibility
from invokeai.app.services.image_records.image_records_common import ImageCategory, ResourceOrigin
from invokeai.app.services.session_processor.session_processor_common import ProgressImage

from .remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError


_BRIDGE_LOCK = threading.Lock()


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
    cancel_requested: threading.Event = field(default_factory=threading.Event)
    import_lock: threading.Lock = field(default_factory=threading.Lock)
    thread: threading.Thread | None = None


class RemoteBridgeCancelled(Exception):
    """The owner canceled the local generation and its dispatched remote work."""


_BRIDGE_TASKS: dict[int, _BridgeTask] = {}
# A cancel may race with the mirror invocation between remote enqueue and
# bridge registration. Tombstones close that window without guessing item IDs.
_CANCELLED_RUNS: dict[tuple[str, str], float] = {}
_BRIDGE_SEQUENCE = 0
_REMOTE_MESSAGE_PREFIX = "[[IRW_REMOTE|"


def cancel_remote_bridges(*, user_id: str, local_queue_item_id: str) -> dict[str, int]:
    """Cancel ONLY matching in-memory bridge jobs for the authenticated owner.

    Signal all jobs before remote HTTP calls, so one slow worker cannot allow
    another worker to import a result while cancellation is in progress.
    """
    with _BRIDGE_LOCK:
        now = time.monotonic()
        for key, since in list(_CANCELLED_RUNS.items()):
            if now - since > 600:
                _CANCELLED_RUNS.pop(key, None)
        if len(_CANCELLED_RUNS) >= 256:
            _CANCELLED_RUNS.pop(next(iter(_CANCELLED_RUNS)))
        _CANCELLED_RUNS[(user_id, local_queue_item_id)] = now
        tasks = [
            task
            for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id and task.local_queue_item_id == local_queue_item_id
        ]
    for task in tasks:
        with task.import_lock:
            task.cancel_requested.set()

    canceled = 0
    already_finished = 0
    failed = 0
    for task in tasks:
        client = _remote_client(task.remote_url, task.owner_id)
        try:
            client.cancel_queue_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
            canceled += 1
        except Exception:
            # A completion and cancellation can cross on the network. A finished
            # item cannot consume more GPU, but its result must still be suppressed.
            try:
                item = client.get_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
                if str(item.get("status", "")).lower() in {"completed", "failed", "canceled", "cancelled"}:
                    already_finished += 1
                    continue
            except Exception:
                pass
            failed += 1
    return {"matched": len(tasks), "canceled": canceled, "already_finished": already_finished, "failed": failed}


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
            task for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id
            and task.local_queue_item_id
            and (origin_prefix is None or task.source_origin.startswith(origin_prefix))
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

    local_ids = {task.local_queue_item_id for task in snapshot}
    if not local_ids:
        return {"matched": 0, "canceled": 0, "already_finished": 0, "failed": 0}

    # Signal every matching bridge before performing any slow remote HTTP call.
    with _BRIDGE_LOCK:
        now = time.monotonic()
        for key, since in list(_CANCELLED_RUNS.items()):
            if now - since > 600:
                _CANCELLED_RUNS.pop(key, None)
        for local_id in local_ids:
            _CANCELLED_RUNS[(user_id, local_id)] = now
        tasks = [
            task for task in _BRIDGE_TASKS.values()
            if task.owner_id == user_id
            and task.local_queue_item_id in local_ids
            and (origin_prefix is None or task.source_origin.startswith(origin_prefix))
            and (not keep_current or task.local_backend_item_id not in protected)
        ]
    for task in tasks:
        with task.import_lock:
            task.cancel_requested.set()

    canceled = already_finished = failed = 0
    for task in tasks:
        client = _remote_client(task.remote_url, task.owner_id)
        try:
            client.cancel_queue_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
            canceled += 1
        except Exception:
            try:
                item = client.get_item(item_id=task.remote_item_id, queue_id=task.remote_queue_id)
                if str(item.get("status", "")).lower() in {"completed", "failed", "canceled", "cancelled"}:
                    already_finished += 1
                    continue
            except Exception:
                pass
            failed += 1
    return {"matched": len(tasks), "canceled": canceled, "already_finished": already_finished, "failed": failed}


def _remote_client(remote_url: str, user_id: str = "") -> RemoteInvokeClient:
    return RemoteInvokeClient(RemoteConfig.from_environment(base_url=remote_url, verify_ssl=False, user_id=user_id))


def _next_task_id() -> int:
    global _BRIDGE_SEQUENCE
    with _BRIDGE_LOCK:
        _BRIDGE_SEQUENCE += 1
        # Keep IDs positive and easy to recognize in logs, while remaining valid Int outputs.
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
    local_queue_item_id: str,
    remote_slot: int,
    state: str,
    message: str,
    percentage: float | None = None,
    image: ProgressImage | None = None,
    revision: int | None = None,
) -> None:
    # The stock v7 UI ignores progress for unknown backend item IDs. The webv2 patch bundled
    # with v0.9.0 recognizes this marker before that check and routes it into the existing
    # multi-GPU progress stores as an extra live-preview slot.
    if not local_queue_item_id:
        return
    safe_message = str(message or "").replace("\n", " ").strip()
    tagged = f"{_REMOTE_MESSAGE_PREFIX}{local_queue_item_id}|{int(remote_slot)}|{state}]] {safe_message}"
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
        metadata=None,
        image_origin=ResourceOrigin.INTERNAL,
        workflow=workflow_json,
        graph=graph_json,
        session_id=getattr(queue_item, "session_id", None),
        node_id=getattr(invocation, "id", None),
        user_id=user_id,
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
    all_remote_names = client.extract_image_names(completed_item, non_intermediate_only=False)
    remote_names = client.filter_gallery_image_names(all_remote_names)
    if result_destination == "canvas" and not remote_names:
        # Canvas graphs may deliberately mark their results intermediate because
        # they are meant for staging, not Gallery. Choose the final output rather
        # than importing an entire denoise/temporary pipeline.
        remote_names = [all_remote_names[-1]] if all_remote_names else []
    if not remote_names:
        raise RemoteInvokeError("Remote render completed, but none of its image outputs are marked Save to Gallery")

    imported: list[Any] = []
    for remote_name in remote_names:
        if task.cancel_requested.is_set():
            raise RemoteBridgeCancelled()
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
                board_id=local_board_id,
                result_destination=result_destination,
            )
        imported.append(dto)
        services.logger.info(
            f"Remote bridge: imported {remote_name} as {dto.image_name}"
            + (f" on board {local_board_id}" if local_board_id else "")
        )

    if task.cancel_requested.is_set():
        raise RemoteBridgeCancelled()
    # Only remove remote files after every requested gallery image was safely stored locally.
    if not keep_remote_copies:
        deleted = 0
        for remote_name in all_remote_names:
            try:
                client.delete_image(remote_name)
                deleted += 1
            except Exception as exc:
                services.logger.warning(
                    f"Remote bridge: local import succeeded but remote cleanup failed for {remote_name}: {exc}"
                )
        services.logger.info(
            f"Remote bridge: remote cleanup deleted {deleted}/{len(all_remote_names)} image output(s)"
        )

    return imported


def _bridge_worker(
    *,
    task_id: int,
    services: Any,
    queue_item: Any,
    invocation: Any,
    remote_url: str,
    remote_item_id: int,
    remote_queue_id: str,
    local_board_id: str,
    result_destination: str,
    keep_remote_copies: bool,
    poll_interval_seconds: float,
    timeout_seconds: int,
    remote_slot: int,
    task: _BridgeTask,
) -> None:
    client = _remote_client(remote_url, str(queue_item.user_id))
    local_queue_item_id = _webv2_queue_item_id(getattr(queue_item, "origin", None))
    started = time.monotonic()
    last_preview_signature: tuple[Any, Any, Any] | None = None
    transient_errors = 0

    services.logger.info(
        f"Remote bridge #{task_id}: watching {client.config.base_url} item {remote_item_id} "
        f"as Remote {remote_slot}"
    )
    if not local_queue_item_id:
        services.logger.warning(
            f"Remote bridge #{task_id}: could not identify the webv2 queue item from origin "
            f"{getattr(queue_item, 'origin', None)!r}; live remote preview will be unavailable, "
            "but immediate final-image return will still run"
        )

    try:
        # Announce a Canvas worker immediately, before its first denoising frame.
        # The local queue may finish first; this marker lets Canvas retain a
        # separate live thumbnail until the final remote candidate is staged.
        if result_destination == "canvas":
            _emit_remote_progress(
                services=services,
                queue_item=queue_item,
                invocation=invocation,
                local_queue_item_id=local_queue_item_id,
                remote_slot=remote_slot,
                state="running",
                message=f"Remote {remote_slot} queued",
            )
        while True:
            if task.cancel_requested.is_set():
                raise RemoteBridgeCancelled()
            if time.monotonic() - started > float(timeout_seconds):
                raise RemoteInvokeError(
                    f"Remote queue item {remote_item_id} timed out after {timeout_seconds:g} seconds"
                )

            try:
                item = client.get_item(item_id=remote_item_id, queue_id=remote_queue_id)
                transient_errors = 0
            except Exception as exc:
                transient_errors += 1
                if transient_errors >= 8:
                    raise RemoteInvokeError(
                        f"Lost contact with remote item {remote_item_id} after {transient_errors} attempts: {exc}"
                    ) from exc
                services.logger.warning(
                    f"Remote bridge #{task_id}: temporary status error ({transient_errors}/8): {exc}"
                )
                time.sleep(max(0.25, float(poll_interval_seconds)))
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
                final_name = getattr(imported[-1], "image_name", "remote image") if imported else "remote image"
                message = f"Remote {remote_slot} complete: {final_name}"
                if result_destination == "canvas":
                    names = [dto.image_name for dto in imported]
                    message += " [[IRW_CANVAS_IMAGES|" + json.dumps(names, separators=(",", ":")) + "]]"
                _emit_remote_progress(
                    services=services,
                    queue_item=queue_item,
                    invocation=invocation,
                    local_queue_item_id=local_queue_item_id,
                    remote_slot=remote_slot,
                    state="completed",
                    message=message,
                    percentage=1.0,
                    revision=None,
                )
                services.logger.info(
                    f"Remote bridge #{task_id}: item {remote_item_id} completed; imported {len(imported)} image(s)"
                )
                return

            if status in {"failed", "canceled", "cancelled"}:
                errors = item.get("session", {}).get("errors", {}) if isinstance(item.get("session"), dict) else {}
                raise RemoteInvokeError(
                    f"Remote queue item {remote_item_id} ended with status '{status}'. Errors: {json.dumps(errors)[:3000]}"
                )

            try:
                preview = client.get_progress_preview(item_id=remote_item_id, queue_id=remote_queue_id)
            except Exception as exc:
                # Preview transport is best-effort. Status and final-image return should continue even if
                # an older/custom v7 build does not expose retained previews.
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
                        local_queue_item_id=local_queue_item_id,
                        remote_slot=remote_slot,
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
        services.logger.info(f"Remote bridge #{task_id}: cancelled by generation owner")
        _emit_remote_progress(
            services=services,
            queue_item=queue_item,
            invocation=invocation,
            local_queue_item_id=local_queue_item_id,
            remote_slot=remote_slot,
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
                local_queue_item_id=local_queue_item_id,
                remote_slot=remote_slot,
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
    task = _BridgeTask(
        owner_id=str(queue_item.user_id),
        local_queue_item_id=_webv2_queue_item_id(getattr(queue_item, "origin", None)),
        local_backend_item_id=int(queue_item.item_id),
        source_origin=str(getattr(queue_item, "origin", None) or ""),
        remote_url=remote_url,
        remote_item_id=int(remote_item_id),
        remote_queue_id=remote_queue_id,
        remote_slot=int(remote_slot),
    )

    thread = threading.Thread(
        target=_bridge_worker,
        kwargs={
            "task_id": task_id,
            "services": services,
            "queue_item": queue_item,
            "invocation": invocation,
            "remote_url": remote_url,
            "remote_item_id": int(remote_item_id),
            "remote_queue_id": remote_queue_id,
            "local_board_id": local_board_id,
            "result_destination": result_destination,
            "keep_remote_copies": bool(keep_remote_copies),
            "poll_interval_seconds": float(poll_interval_seconds),
            "timeout_seconds": int(timeout_seconds),
            "remote_slot": int(remote_slot),
            "task": task,
        },
        name=f"invokeai-remote-bridge-{task_id}",
        daemon=True,
    )
    task.thread = thread
    with _BRIDGE_LOCK:
        _BRIDGE_TASKS[task_id] = task
        cancellation_time = _CANCELLED_RUNS.get((task.owner_id, task.local_queue_item_id))
        canceled_while_registering = cancellation_time is not None and time.monotonic() - cancellation_time <= 600
        if canceled_while_registering:
            task.cancel_requested.set()
    thread.start()
    if canceled_while_registering:
        try:
            _remote_client(remote_url, task.owner_id).cancel_queue_item(remote_item_id, remote_queue_id)
        except Exception as exc:
            services.logger.warning(f"Remote bridge #{task_id}: late-start cancellation failed: {exc}")
    return task_id
