from __future__ import annotations

import json
import threading
import time
from typing import Any

from invokeai.app.services.board_records.board_records_common import BoardVisibility
from invokeai.app.services.image_records.image_records_common import ImageCategory, ResourceOrigin
from invokeai.app.services.session_processor.session_processor_common import ProgressImage

from .remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError


_BRIDGE_LOCK = threading.Lock()
_BRIDGE_TASKS: dict[int, threading.Thread] = {}
_BRIDGE_SEQUENCE = 0
_REMOTE_MESSAGE_PREFIX = "[[IRW_REMOTE|"


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
        image = client.download_image(remote_name)
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
                )
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

            time.sleep(max(0.25, float(poll_interval_seconds)))

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
        },
        name=f"invokeai-remote-bridge-{task_id}",
        daemon=True,
    )
    with _BRIDGE_LOCK:
        _BRIDGE_TASKS[task_id] = thread
    thread.start()
    return task_id
