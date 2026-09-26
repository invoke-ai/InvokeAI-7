import json
import re
import secrets
import time
import uuid
from copy import deepcopy
from typing import Any, Literal

from invokeai.app.invocations.remote_worker.diffusers_transfer import TemporaryDirectoryModelServer
from invokeai.app.invocations.remote_worker.early_dispatch import (
    AUTOMATIC_MIRROR_NODE_TYPE,
    dispatch_remote_once,
)
from invokeai.app.invocations.remote_worker.model_transfer import (
    ModelTransferError,
    TemporaryModelServer,
    enrich_model_identifier_hashes,
    resolve_local_model_file,
)
from invokeai.app.invocations.remote_worker.remote_bridge import (
    another_generation_needs_model,
    register_model_transfer,
    start_remote_bridge,
    unregister_model_transfer,
)
from invokeai.app.invocations.remote_worker.remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError
from invokeai.app.services.session_processor.session_processor_common import CanceledException
from invokeai.invocation_api import (
    BaseInvocation,
    BaseInvocationOutput,
    ImageField,
    ImageOutput,
    Input,
    InputField,
    InvocationContext,
    OutputField,
    invocation,
    invocation_output,
)

RemoteSeedMode = Literal["Randomize remote seed inputs", "Keep current workflow seeds"]

# Strip our own helper nodes from the mirrored graph so the remote worker cannot
# recursively mirror itself or try to collect its own output.
_HELPER_NODE_TYPES = {
    AUTOMATIC_MIRROR_NODE_TYPE,
    "irw_builtin_collect",
}


def _remote_client(remote_url: str, user_id: str = "") -> RemoteInvokeClient:
    return RemoteInvokeClient(RemoteConfig.from_environment(base_url=remote_url, verify_ssl=False, user_id=user_id))


def _emit_model_transfer_progress(
    *,
    context: InvocationContext,
    invocation: Any,
    remote_index: int,
    model: Any,
    directory: bool,
    phase: str,
    job: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    """Send transfer-only progress to the queue item's owner; never expose LAN URLs or credentials."""
    queue_item = context._data.queue_item
    backend_item_id = int(getattr(queue_item, "item_id", 0) or 0)
    if backend_item_id < 1:
        return
    job = job or {}
    payload = {
        "backend_item_id": backend_item_id,
        "remote_index": remote_index,
        "model_hash": model.hash,
        "name": model.name,
        "directory": directory,
        "phase": phase,
        "bytes": max(0, int(job.get("bytes") or 0)),
        "total_bytes": max(0, int(job.get("total_bytes") or 0)),
    }
    if error:
        payload["error"] = str(error)[:2048]

    try:
        from invokeai.app.services.events.events_common import InvocationProgressEvent

        source_id = queue_item.session.prepared_source_mapping.get(invocation.id, invocation.id)
        context._services.events.dispatch(
            InvocationProgressEvent(
                queue_id=queue_item.queue_id,
                item_id=queue_item.item_id,
                batch_id=queue_item.batch_id,
                origin=queue_item.origin,
                destination=queue_item.destination,
                user_id=queue_item.user_id,
                session_id=queue_item.session_id,
                invocation=invocation.get_event_invocation(),
                invocation_source_id=source_id,
                message="[[IRW_MODEL_TRANSFER]]" + json.dumps(payload, separators=(",", ":")),
                percentage=None,
            )
        )
    except Exception as exc:
        # A failed UI notification must never fail a model transfer.
        context.logger.debug(f"Could not emit remote model transfer progress: {exc}")


class RemoteModelTransferCancelled(CanceledException):
    """The local generation was canceled while preparing a worker model."""


def _transfer_missing_model_to_remote(
    *,
    context: InvocationContext,
    invocation: Any,
    remote_client: RemoteInvokeClient,
    remote_index: int,
    identifier: dict[str, Any],
    transfer_host: str,
    timeout_seconds: int,
) -> None:
    """Transfer one missing model, observing cancellation even before a render bridge exists."""
    try:
        model = resolve_local_model_file(context._services, identifier)
    except ModelTransferError as exc:
        raise RemoteInvokeError(str(exc)) from exc

    existing = remote_client.get_model_by_hash(model.hash)
    if existing is not None:
        return

    transfer_id, transfer = register_model_transfer(context._data.queue_item, remote_client.config.base_url, model.hash)
    is_directory = model.path.is_dir()
    job_id: int | None = None
    status = ""
    cancel_sent = False
    cancel_notified = False
    cancel_started: float | None = None
    cancel_error_logged = False
    lock_acquired = False

    def cancelled() -> bool:
        if transfer.cancel_requested.is_set():
            return True
        try:
            item = context._services.session_queue.get_queue_item(transfer.local_backend_item_id)
        except Exception:
            return False
        return str(getattr(item.status, "value", item.status)).lower() in {"canceled", "cancelled"}

    def notify_cancelled() -> None:
        nonlocal cancel_notified
        if cancel_notified:
            return
        cancel_notified = True
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase="cancelled",
        )

    def preparation_should_cancel() -> bool:
        if not cancelled():
            return False
        notify_cancelled()
        return not another_generation_needs_model(transfer)

    def check_cancellation() -> None:
        nonlocal cancel_started, cancel_sent, cancel_error_logged
        if not cancelled():
            return
        notify_cancelled()
        if job_id is None:
            # Before a worker-side install exists, this caller still owns the
            # singleflight preparation. Keep preparing for another live waiter.
            if another_generation_needs_model(transfer):
                return
            raise RemoteModelTransferCancelled("Remote model transfer cancelled")
        if status in {"completed", "error", "cancelled", "canceled", "failed"}:
            raise RemoteModelTransferCancelled("Remote model transfer cancelled")
        # A second live generation may be using the SAME worker-side install.
        # Keep this primary HTTP server alive until that job reaches a terminal state.
        if another_generation_needs_model(transfer):
            return
        if cancel_started is None:
            cancel_started = time.monotonic()
        # Do not interrupt InvokeAI while it moves/registers an already-downloaded model.
        if status in {"running", "installing"}:
            if time.monotonic() - cancel_started > 90:
                raise RemoteModelTransferCancelled("Remote model transfer cancelled during installation")
            return
        if not cancel_sent:
            path = (
                f"/api/v1/remote_workers/diffusers/install/{job_id}"
                if is_directory
                else f"/api/v2/models/install/{job_id}"
            )
            try:
                cancel_install = getattr(remote_client, "cancel_model_install", None)
                if callable(cancel_install):
                    cancel_install(job_id, directory=is_directory)
                else:
                    remote_client._request("DELETE", path)
            except Exception as exc:
                if not cancel_error_logged:
                    context.logger.warning(
                        f"Remote #{remote_index}: model install job {job_id} cancellation request failed: {exc}"
                    )
                    cancel_error_logged = True
            else:
                cancel_sent = True
        # A missing/unresponsive worker must not keep the primary server alive indefinitely.
        if time.monotonic() - cancel_started > 30:
            context.logger.warning(
                f"Remote #{remote_index}: model install job {job_id} cancellation could not be confirmed"
            )
            raise RemoteModelTransferCancelled("Remote model transfer cancellation not confirmed")

    def report_install_progress(job: dict[str, Any]) -> None:
        if cancelled():
            return
        phase = {
            "waiting": "waiting",
            "downloading": "downloading",
            "downloads_done": "downloading",
            "running": "installing",
            "installing": "installing",
            "completed": "verifying",
            "error": "failed",
            "cancelled": "cancelled",
            "canceled": "cancelled",
        }.get(status, "waiting")
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase=phase,
            job=job,
            error=str(job.get("error") or "") if phase == "failed" else "",
        )

    try:
        while not lock_acquired:
            if cancelled():
                notify_cancelled()
                raise RemoteModelTransferCancelled("Remote model transfer cancelled")
            lock_acquired = transfer.shared_lock.acquire(timeout=0.25)
        check_cancellation()
        if remote_client.get_model_by_hash(model.hash) is not None:
            return
        check_cancellation()
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase="preparing",
        )
        server = (
            TemporaryDirectoryModelServer(
                path=model.path,
                remote_url=remote_client.config.base_url,
                advertise_host=transfer_host,
                should_cancel=preparation_should_cancel,
            )
            if is_directory
            else TemporaryModelServer(
                model=model, remote_url=remote_client.config.base_url, advertise_host=transfer_host
            )
        )
        with server:
            check_cancellation()
            size = (
                sum(file.size for file in server.files)
                if isinstance(server, TemporaryDirectoryModelServer)
                else model.path.stat().st_size
            )
            context.logger.warning(
                f"Remote #{remote_index}: required model '{model.name}' is missing; "
                f"serving {model.path.name} ({size / (1024**3):.2f} GiB) directly from this InvokeAI host over the LAN"
            )
            context.logger.info(f"Remote #{remote_index}: temporary model transfer endpoint ready at {server.url}")
            if is_directory:
                assert isinstance(server, TemporaryDirectoryModelServer)
                job = remote_client.install_directory_from_manifest(
                    server.manifest(name=model.name, model_hash=model.hash)
                )
            else:
                job = remote_client.install_model_from_url(server.url, name=model.name)
            try:
                job_id = int(job.get("id"))
            except (TypeError, ValueError) as exc:
                raise RemoteInvokeError(f"Remote model installer returned no usable job id: {job}") from exc
            status = str(job.get("status") or "").lower()
            context.logger.info(
                f"Remote #{remote_index}: InvokeAI model install job {job_id} started for '{model.name}'"
            )

            started = time.monotonic()
            while True:
                check_cancellation()
                try:
                    job = (
                        remote_client.get_directory_install_job(job_id)
                        if is_directory
                        else remote_client.get_model_install_job(job_id)
                    )
                except RemoteInvokeError as exc:
                    if cancelled() and cancel_sent and "HTTP 404" in str(exc):
                        raise RemoteModelTransferCancelled("Remote model transfer cancelled") from exc
                    raise
                status = str(job.get("status") or "").lower()
                report_install_progress(job)
                check_cancellation()
                if status == "completed":
                    break
                if status in {"error", "canceled", "cancelled"}:
                    detail = job.get("error") or job.get("error_type") or "unknown installation error"
                    raise RemoteInvokeError(f"Remote model install job {job_id} ended with status '{status}': {detail}")
                if time.monotonic() - started > float(timeout_seconds):
                    raise RemoteInvokeError(
                        f"Remote model install job {job_id} timed out after {timeout_seconds:g} seconds"
                    )
                time.sleep(1.0)
            context.logger.info(f"Remote #{remote_index}: model install job {job_id} completed with status {status}")

        check_cancellation()
        installed = remote_client.get_model_by_hash(model.hash)
        check_cancellation()
        if installed is None:
            raise RemoteInvokeError(
                f"Remote #{remote_index}: '{model.name}' finished installing but hash {model.hash} "
                "was not found in the remote model manager"
            )
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase="completed",
        )
        remote_payload = installed.get("model") if isinstance(installed.get("model"), dict) else installed
        context.logger.info(
            f"Remote #{remote_index}: verified transferred model '{model.name}' by hash; "
            f"remote key={remote_payload.get('key', 'unknown')}"
        )
    except RemoteModelTransferCancelled:
        notify_cancelled()
        raise
    except ModelTransferError as exc:
        if cancelled():
            notify_cancelled()
            raise RemoteModelTransferCancelled("Remote model transfer cancelled") from exc
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase="failed",
            error=str(exc),
        )
        raise RemoteInvokeError(str(exc)) from exc
    except Exception as exc:
        if cancelled():
            notify_cancelled()
            raise RemoteModelTransferCancelled("Remote model transfer cancelled") from exc
        _emit_model_transfer_progress(
            context=context,
            invocation=invocation,
            remote_index=remote_index,
            model=model,
            directory=is_directory,
            phase="failed",
            error=str(exc),
        )
        raise
    finally:
        if lock_acquired:
            transfer.shared_lock.release()
        unregister_model_transfer(transfer_id)


def _resolve_remote_urls(primary_url: str, additional_urls: str) -> list[str]:
    """Return a de-duplicated list of remote InvokeAI base URLs.

    The primary URL retains the existing INVOKE_REMOTE_URL fallback. Additional URLs
    may be separated by commas, semicolons, or newlines.
    """
    raw_additional = [part.strip() for part in re.split(r"[,;\n\r]+", additional_urls or "") if part.strip()]

    raw_urls: list[str] = []
    if (primary_url or "").strip():
        raw_urls.append(primary_url.strip())
    elif not raw_additional:
        # An empty primary URL lets RemoteConfig fall back to INVOKE_REMOTE_URL.
        raw_urls.append("")
    raw_urls.extend(raw_additional)

    resolved: list[str] = []
    seen: set[str] = set()
    for raw_url in raw_urls:
        client = _remote_client(raw_url)
        base_url = client.config.base_url.rstrip("/")
        key = base_url.lower()
        if key in seen:
            continue
        seen.add(key)
        resolved.append(base_url)

    if not resolved:
        raise RemoteInvokeError("No remote InvokeAI workers are configured")
    return resolved


def _seed_values_for_remotes(base_seed: int, count: int) -> list[int]:
    if count <= 0:
        return []
    max_seed = 2147483647
    if int(base_seed) >= 0:
        return [((int(base_seed) + index) % (max_seed + 1)) for index in range(count)]

    seeds: list[int] = []
    used: set[int] = set()
    while len(seeds) < count:
        value = secrets.randbelow(max_seed + 1)
        if value in used:
            continue
        used.add(value)
        seeds.append(value)
    return seeds


def _is_seed_field(field_name: str) -> bool:
    name = str(field_name).strip().lower()
    return name == "seed" or name.endswith("_seed")


def _strip_helper_nodes(graph: dict[str, Any]) -> list[str]:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        raise RemoteInvokeError("Current workflow graph does not contain a nodes object")

    removed = {
        str(node_id)
        for node_id, node in nodes.items()
        if isinstance(node, dict) and str(node.get("type", "")) in _HELPER_NODE_TYPES
    }
    for node_id in removed:
        nodes.pop(node_id, None)

    edges = graph.get("edges")
    if isinstance(edges, list) and removed:
        kept_edges = []
        for edge in edges:
            if not isinstance(edge, dict):
                kept_edges.append(edge)
                continue
            source = edge.get("source") if isinstance(edge.get("source"), dict) else {}
            destination = edge.get("destination") if isinstance(edge.get("destination"), dict) else {}
            if str(source.get("node_id")) in removed or str(destination.get("node_id")) in removed:
                continue
            kept_edges.append(edge)
        graph["edges"] = kept_edges

    if not nodes:
        raise RemoteInvokeError(
            "Nothing remains to mirror after removing Remote Invoke helper nodes. "
            "Add the Mirror node alongside a normal image workflow."
        )
    return sorted(removed)


def _disable_graph_cache(graph: dict[str, Any]) -> int:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        return 0
    count = 0
    for node in nodes.values():
        if isinstance(node, dict):
            node["use_cache"] = False
            count += 1
    return count


def _force_remote_seed(graph: dict[str, Any], seed: int) -> list[str]:
    """Set seed-like node inputs on the remote clone and remove incoming seed edges.

    Connected values override literal node values in InvokeAI. Removing the incoming
    edge is therefore intentional when remote seed randomization is selected.
    """
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        raise RemoteInvokeError("Current workflow graph does not contain a nodes object")

    targets: set[tuple[str, str]] = set()

    # Literal seed-like fields already present on nodes.
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        for field_name, field_value in list(node.items()):
            if _is_seed_field(field_name) and not isinstance(field_value, bool):
                # Seed fields are integer-valued in InvokeAI. We intentionally also
                # include None for connected inputs whose literal value is unset.
                if field_value is None or isinstance(field_value, int):
                    targets.add((str(node_id), str(field_name)))

    # Seed-like destination fields that are currently supplied by a connection
    # (e.g. Random Integer -> Denoise.seed).
    edges = graph.get("edges")
    if isinstance(edges, list):
        for edge in edges:
            if not isinstance(edge, dict):
                continue
            destination = edge.get("destination")
            if not isinstance(destination, dict):
                continue
            node_id = str(destination.get("node_id", ""))
            field_name = str(destination.get("field", ""))
            if node_id in nodes and _is_seed_field(field_name):
                targets.add((node_id, field_name))

    if isinstance(edges, list) and targets:
        graph["edges"] = [
            edge
            for edge in edges
            if not (
                isinstance(edge, dict)
                and isinstance(edge.get("destination"), dict)
                and (
                    str(edge["destination"].get("node_id", "")),
                    str(edge["destination"].get("field", "")),
                )
                in targets
            )
        ]

    changed: list[str] = []
    for node_id, field_name in sorted(targets):
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            continue
        node[field_name] = int(seed)
        node["use_cache"] = False
        changed.append(f"{node_id}.{field_name}")
    return changed


def _find_media_references(value: Any, found: set[str]) -> None:
    if isinstance(value, list):
        for item in value:
            _find_media_references(item, found)
        return
    if not isinstance(value, dict):
        return
    image_name = value.get("image_name")
    video_name = value.get("video_name")
    if isinstance(image_name, str) and image_name:
        found.add(f"image:{image_name}")
    if isinstance(video_name, str) and video_name:
        found.add(f"video:{video_name}")
    for child in value.values():
        _find_media_references(child, found)


def _graph_media_references(graph: dict[str, Any]) -> list[str]:
    found: set[str] = set()
    nodes = graph.get("nodes")
    if isinstance(nodes, dict):
        for node in nodes.values():
            _find_media_references(node, found)
    return sorted(found)


def _remap_graph_image_names(value: Any, mapped: dict[str, str]) -> int:
    """Rewrite image references (including nested ImageField/list inputs), not other strings."""
    changed = 0
    if isinstance(value, list):
        for entry in value:
            changed += _remap_graph_image_names(entry, mapped)
    elif isinstance(value, dict):
        original = value.get("image_name")
        if isinstance(original, str) and original in mapped:
            value["image_name"] = mapped[original]
            changed += 1
        for entry in value.values():
            changed += _remap_graph_image_names(entry, mapped)
    return changed


def _transfer_source_images_to_remote(
    *,
    context: InvocationContext,
    remote_client: RemoteInvokeClient,
    graph: dict[str, Any],
    image_names: list[str],
    remote_index: int,
) -> None:
    """Copy every distinct local image once per worker before enqueueing the graph."""
    mapped: dict[str, str] = {}
    for local_name in image_names:
        try:
            # InvocationContext checks access for the authenticated queue owner.
            local_image = context.images.get_pil(local_name)
        except Exception as exc:
            raise RemoteInvokeError(
                f"Remote #{remote_index}: cannot read primary source image '{local_name}': {exc}"
            ) from exc
        try:
            mapped[local_name] = remote_client.upload_input_image(local_image)
        except Exception as exc:
            raise RemoteInvokeError(
                f"Remote #{remote_index}: could not transfer source image '{local_name}': {exc}"
            ) from exc
        context.logger.debug(
            f"Remote #{remote_index}: transferred input image '{local_name}' -> '{mapped[local_name]}'"
        )
    # Never change the local source graph; `graph` is a per-worker deepcopy.
    changed = _remap_graph_image_names(graph.get("nodes", {}), mapped)
    context.logger.info(
        f"Remote #{remote_index}: remapped {changed} image field(s) from {len(mapped)} transferred source image(s)"
    )


def _node_board_id(node: Any) -> str | None:
    if not isinstance(node, dict):
        return None
    board = node.get("board")
    if isinstance(board, dict):
        for key in ("board_id", "id"):
            value = board.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    value = node.get("board_id")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _collect_local_board_ids(graph: dict[str, Any]) -> list[str]:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        return []
    ordered: list[str] = []
    seen: set[str] = set()
    for node in nodes.values():
        board_id = _node_board_id(node)
        if board_id and board_id not in seen:
            seen.add(board_id)
            ordered.append(board_id)
    return ordered


def _strip_remote_board_assignments(graph: dict[str, Any]) -> list[str]:
    nodes = graph.get("nodes")
    if not isinstance(nodes, dict):
        return []
    removed_from: list[str] = []
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        changed = False
        if isinstance(node.get("board"), dict):
            node["board"] = None
            changed = True
        if "board_id" in node and node.get("board_id") is not None:
            node["board_id"] = None
            changed = True
        if changed:
            removed_from.append(str(node_id))
    return removed_from


@invocation(
    "irw_builtin_background_collect",
    title="Remote Workers - Built-in Background Collector",
    tags=["remote", "invokeai", "worker", "mirror", "collector", "image"],
    category="Remote Invoke",
    version="0.9.2",
    use_cache=False,
)
class RemoteMirrorBackgroundCollectInvocation(BaseInvocation):
    """Queued on the primary instance by the mirror node. Waits for the remote render and imports its images."""

    remote_url: str = InputField(description="Remote InvokeAI base URL")
    remote_item_id: int = InputField(ge=1, description="Remote queue item to collect")
    remote_queue_id: str = InputField(default="default", description="Remote queue ID")
    local_board_id: str = InputField(default="", description="Original local board ID for imported remote images")
    keep_remote_copies: bool = InputField(
        default=False,
        description="Keep generated images on the remote worker after they have been imported into the primary instance.",
    )
    poll_interval_seconds: float = InputField(default=0.75, ge=0.25, le=30.0)
    timeout_seconds: int = InputField(default=1800, ge=10, le=86400)

    def invoke(self, context: InvocationContext) -> ImageOutput:
        client = _remote_client(self.remote_url, str(context._data.queue_item.user_id))
        context.logger.info(f"Mirror background collector: waiting for remote item {self.remote_item_id}")
        completed = client.wait_for_item(
            item_id=self.remote_item_id,
            queue_id=self.remote_queue_id,
            poll_interval_seconds=self.poll_interval_seconds,
            timeout_seconds=self.timeout_seconds,
        )
        # First collect every image output from the remote session, then ask the
        # remote image service which of those images are actually non-intermediate.
        # This mirrors InvokeAI's own Save-to-Gallery state and avoids relying on
        # session result IDs matching source graph node IDs.
        all_remote_names = client.extract_image_names(completed, non_intermediate_only=False)
        remote_names = client.filter_gallery_image_names(all_remote_names)
        context.logger.info(
            f"Mirror background collector: remote item {self.remote_item_id} produced "
            f"{len(all_remote_names)} image output(s); {len(remote_names)} marked for gallery return: {remote_names}"
        )
        if not remote_names:
            raise RemoteInvokeError(
                f"Remote item {self.remote_item_id} completed, but none of its image outputs are marked Save to Gallery"
            )
        last_dto = None
        target_board_id = self.local_board_id.strip() or None
        imported_remote_names: list[str] = []
        for remote_name in remote_names:
            image = client.download_image(remote_name)
            if target_board_id:
                try:
                    dto = context.images.save(image=image, board_id=target_board_id)
                except TypeError:
                    dto = context.images.save(image=image)
                    context.logger.warning(
                        "Mirror background collector: local image service did not accept board_id; "
                        f"imported {remote_name} without board assignment"
                    )
            else:
                dto = context.images.save(image=image)
            last_dto = dto
            imported_remote_names.append(remote_name)
            context.logger.info(
                f"Mirror background collector: imported remote {remote_name} into the primary instance as {dto.image_name}"
                + (f" on board {target_board_id}" if target_board_id else "")
            )
        if last_dto is None:
            raise RemoteInvokeError(f"Remote item {self.remote_item_id} completed without an importable image output")

        # Only clean up the remote after every requested gallery image has been
        # successfully downloaded and saved locally. If import fails above, the
        # remote copy remains available for recovery. Clean up *all* image outputs
        # from the remote session, including intermediate/cache-only images.
        if not self.keep_remote_copies:
            deleted = 0
            failed: list[str] = []
            for remote_name in all_remote_names:
                try:
                    result = client.delete_image(remote_name)
                    deleted_images = result.get("deleted_images") if isinstance(result, dict) else None
                    if isinstance(deleted_images, list) and remote_name not in deleted_images:
                        failed.append(remote_name)
                        continue
                    deleted += 1
                except Exception as exc:
                    failed.append(remote_name)
                    context.logger.warning(
                        f"Mirror background collector: imported {remote_name} locally but could not delete it "
                        f"from the remote worker: {exc}"
                    )
            context.logger.info(
                f"Mirror background collector: remote cleanup deleted {deleted}/{len(all_remote_names)} "
                f"image output(s) from {self.remote_url}"
            )
            if failed:
                context.logger.warning(
                    "Mirror background collector: remote cleanup left these image(s): " + ", ".join(failed)
                )
        else:
            context.logger.info(
                f"Mirror background collector: keeping {len(all_remote_names)} remote image output(s) on "
                f"{self.remote_url}"
            )

        return ImageOutput.build(last_dto)


@invocation_output("irw_builtin_mirror_current_workflow_output")
class RemoteMirrorCurrentWorkflowOutput(BaseInvocationOutput):
    ticket: str = OutputField(
        description="Remote job ticket for manual collection; remote images are also imported automatically."
    )
    remote_item_id: int = OutputField(description="Remote worker queue item ID")
    remote_seed: int = OutputField(description="Remote seed override, or -1 when current workflow seeds were kept")
    mirrored_nodes: int = OutputField(description="Number of normal workflow nodes mirrored to the remote worker")
    collector_item_id: int = OutputField(
        description="Deprecated compatibility alias for the primary remote bridge task ID"
    )
    bridge_task_id: int = OutputField(description="Background bridge task ID for the primary remote")
    remote_count: int = OutputField(description="Number of remote workers used for this invoke")
    remote_item_ids: str = OutputField(description="JSON list of remote queue item IDs")
    remote_seeds: str = OutputField(description="JSON list of remote seed overrides")
    collector_item_ids: str = OutputField(
        description="Deprecated compatibility alias for JSON list of remote bridge task IDs"
    )
    bridge_task_ids: str = OutputField(description="JSON list of background remote bridge task IDs")


# IMPORTANT: the Python class name intentionally begins with AAA. InvokeAI-7
# groups ready nodes by Python class name and, absent ready_order, selects classes
# alphabetically. This makes the mirror kickoff run before normal workflow classes.
@invocation(
    AUTOMATIC_MIRROR_NODE_TYPE,
    title="Remote Workers - Built-in Mirror",
    tags=["remote", "invokeai", "worker", "mirror", "parallel", "workflow"],
    category="Remote Invoke",
    version="0.10.0",
    use_cache=False,
)
class AAARemoteMirrorCurrentWorkflowInvocation(BaseInvocation):
    """Mirror the *current executable local graph* to the remote InvokeAI worker.

    The primary instance continues executing the current workflow normally. This node only clones
    the current queue item's source graph, removes Remote Invoke helper nodes, remaps
    model identifiers for the remote installation, and enqueues that clone remotely.
    """

    # For remote-only dispatch, the local queue runs only this helper. Its
    # full original graph is supplied as JSON, including per-batch prompt/seed edits.
    source_graph_json: str = InputField(default="", ui_hidden=True)
    # Preserve the worker's configured slot even if single-target dispatch picks R3.
    remote_slot_indices: str = InputField(default="", ui_hidden=True)

    result_destination: Literal["gallery", "canvas"] = InputField(
        default="gallery",
        ui_hidden=True,
        description="Internal: captured InvokeAI result destination (Gallery or Canvas).",
    )
    local_gallery_board_id: str = InputField(
        default="",
        ui_hidden=True,
        description="Internal: Gallery board captured when this workflow was queued.",
    )
    remote_url: str = InputField(
        default="",
        description="Primary remote InvokeAI URL. Blank uses INVOKE_REMOTE_URL.",
    )
    additional_remote_urls: str = InputField(
        default="",
        description="Optional extra remote InvokeAI URLs, separated by commas, semicolons, or new lines.",
    )
    remote_seed_mode: RemoteSeedMode = InputField(
        default="Randomize remote seed inputs",
        description="Give seed-like inputs on the remote clone a new seed, or leave the current workflow seeds untouched.",
    )
    remote_seed: int = InputField(
        default=-1,
        ge=-1,
        le=2147483647,
        description="With randomization enabled: -1 chooses a fresh remote seed each run; N>=0 forces N.",
    )
    keep_remote_copies: bool = InputField(
        default=False,
        description="Keep generated images on remote workers after successful import. Off makes remotes act as disposable workers.",
    )
    auto_transfer_missing_models: bool = InputField(
        default=True,
        description=(
            "If a required model is missing remotely, transfer its single file or complete model directory "
            "over the LAN to remote InvokeAI. Matching and post-install verification use the model hash."
        ),
    )
    model_transfer_host: str = InputField(
        default="",
        description=(
            "Optional LAN IP/hostname that remote workers should use to reach this machine during model transfer. "
            "Blank auto-detects the local address used to route to each remote."
        ),
    )
    model_transfer_timeout_seconds: int = InputField(
        default=7200,
        ge=60,
        le=86400,
        description="Maximum time to wait for each remote model transfer/install job.",
    )
    collector_poll_interval_seconds: float = InputField(
        default=0.75,
        ge=0.25,
        le=30.0,
        description="How often the remote bridge polls progress and status.",
    )
    collector_timeout_seconds: int = InputField(
        default=14400,
        ge=10,
        le=86400,
        description="Maximum wait per phase: queued and actively rendering (each has its own deadline).",
    )

    def invoke(self, context: InvocationContext) -> RemoteMirrorCurrentWorkflowOutput:
        # If eager dispatch has already started, join it: never enqueue twice.
        # If no eager task exists (manual invoke, recovery, or API hook failed),
        # the original in-queue implementation remains fully functional.
        item_id = int(context._data.queue_item.item_id)
        return dispatch_remote_once(item_id, lambda: self._invoke_dispatch(context))

    def _invoke_dispatch(self, context: InvocationContext) -> RemoteMirrorCurrentWorkflowOutput:
        if context.util.is_canceled():
            raise RemoteInvokeError("Remote dispatch was canceled before it started")
        queue_id = "default"

        # We are already executing inside the authenticated local InvokeAI queue item.
        # Read it directly instead of making a second HTTP request to localhost, which
        # would require a separate bearer token when local multi-user mode is enabled.
        try:
            local_queue_item = context._data.queue_item
            current_item = local_queue_item.model_dump(mode="json")
        except Exception as exc:
            raise RemoteInvokeError("Could not read the current local InvokeAI queue item") from exc
        if not isinstance(current_item, dict):
            raise RemoteInvokeError("The primary InvokeAI instance did not expose a usable current queue item")

        session = current_item.get("session")
        if not isinstance(session, dict):
            raise RemoteInvokeError("Current local queue item has no session object")
        source_graph = session.get("graph")
        if self.source_graph_json:
            try:
                source_graph = json.loads(self.source_graph_json)
            except (ValueError, TypeError) as exc:
                raise RemoteInvokeError("Remote-only dispatch contains invalid source graph JSON") from exc
        if not isinstance(source_graph, dict) or not isinstance(source_graph.get("nodes"), dict):
            raise RemoteInvokeError("Current local queue item has no usable session.graph")

        base_remote_graph = deepcopy(source_graph)
        base_remote_graph["id"] = str(uuid.uuid4())

        removed = _strip_helper_nodes(base_remote_graph)
        nodes = base_remote_graph.get("nodes", {})
        local_board_ids = _collect_local_board_ids(source_graph)
        stripped_board_nodes = _strip_remote_board_assignments(base_remote_graph)
        # An explicit image-node board wins. Board=Auto is absent from the
        # executable graph, so use webv2's captured enqueue-time board.
        target_local_board_id = local_board_ids[0] if local_board_ids else self.local_gallery_board_id.strip()
        # InvokeAI's Uncategorized choice is the string "none", not a database board.
        if target_local_board_id.lower() == "none" or self.result_destination == "canvas":
            target_local_board_id = ""
        context.logger.info(
            f"Mirror Current Workflow: captured local item {current_item.get('item_id')} with "
            f"{len(source_graph.get('nodes', {}))} source node(s); removed helper node(s): {removed or 'none'}"
        )
        if target_local_board_id:
            context.logger.info(
                f"Mirror Current Workflow: captured local board {target_local_board_id} for returned remote images; "
                f"stripped board assignment from {len(stripped_board_nodes)} mirrored remote node(s)"
            )
        elif stripped_board_nodes:
            context.logger.info(
                f"Mirror Current Workflow: stripped board assignment from {len(stripped_board_nodes)} mirrored remote node(s)"
            )

        cache_count = _disable_graph_cache(base_remote_graph)
        context.logger.info(f"Mirror Current Workflow: disabled cache on {cache_count} remote node(s)")

        enriched_hashes = enrich_model_identifier_hashes(base_remote_graph, context._services)
        if enriched_hashes:
            context.logger.info(
                f"Mirror Current Workflow: filled {enriched_hashes} model hash value(s) from the local model manager"
            )

        media_refs = _graph_media_references(base_remote_graph)
        source_image_names = [ref[6:] for ref in media_refs if ref.startswith("image:")]
        video_refs = [ref for ref in media_refs if ref.startswith("video:")]
        if video_refs:
            preview = ", ".join(video_refs[:6])
            context.logger.warning(
                f"Mirror Current Workflow: remote video input transfer is not implemented ({preview}); "
                "video names must already exist on each remote."
            )

        remote_urls = _resolve_remote_urls(self.remote_url, self.additional_remote_urls)
        remote_slots = list(range(1, len(remote_urls) + 1))
        if self.remote_slot_indices.strip():
            try:
                configured_slots = [int(value.strip()) for value in self.remote_slot_indices.split(",")]
                if (
                    len(configured_slots) != len(remote_urls)
                    or len(set(configured_slots)) != len(configured_slots)
                    or any(value < 1 for value in configured_slots)
                ):
                    raise ValueError("Invalid remote slot indices")
                remote_slots = configured_slots
            except ValueError as exc:
                raise RemoteInvokeError("Remote worker slot indices are invalid") from exc
        if self.remote_seed_mode == "Randomize remote seed inputs":
            seed_values = _seed_values_for_remotes(self.remote_seed, len(remote_urls))
        else:
            seed_values = [-1 for _ in remote_urls]

        origin = current_item.get("origin")
        remote_item_ids: list[int] = []
        bridge_task_ids: list[int] = []

        for remote_position, remote_url in enumerate(remote_urls):
            remote_index = remote_slots[remote_position]
            remote_graph = deepcopy(base_remote_graph)
            remote_graph["id"] = str(uuid.uuid4())
            seed_value = seed_values[remote_position]

            if self.remote_seed_mode == "Randomize remote seed inputs":
                changed_seed_fields = _force_remote_seed(remote_graph, seed_value)
                context.logger.info(
                    f"Mirror Current Workflow: remote #{remote_index} seed={seed_value}; "
                    f"overrode {len(changed_seed_fields)} seed input(s)"
                )
            else:
                context.logger.info(
                    f"Mirror Current Workflow: remote #{remote_index} preserving current workflow seed inputs"
                )

            if context.util.is_canceled():
                raise RemoteInvokeError("Remote dispatch was canceled")
            remote_client = _remote_client(remote_url, str(local_queue_item.user_id))

            missing_model_handler = None
            if self.auto_transfer_missing_models:

                def missing_model_handler(
                    identifier: dict[str, Any],
                    *,
                    _remote_index: int = remote_index,
                    _remote_client: RemoteInvokeClient = remote_client,
                ) -> None:
                    _transfer_missing_model_to_remote(
                        context=context,
                        invocation=self,
                        remote_client=_remote_client,
                        remote_index=_remote_index,
                        identifier=identifier,
                        transfer_host=self.model_transfer_host,
                        timeout_seconds=self.model_transfer_timeout_seconds,
                    )

            mappings = remote_client.remap_model_identifiers(
                remote_graph,
                missing_model_handler=missing_model_handler,
            )
            for mapping in mappings:
                context.logger.debug(f"Remote #{remote_index} model remap: {mapping}")

            if source_image_names:
                _transfer_source_images_to_remote(
                    context=context,
                    remote_client=remote_client,
                    graph=remote_graph,
                    image_names=source_image_names,
                    remote_index=remote_index,
                )

            remote_origin = f"windows-mirror-current-workflow:r{remote_index}"
            if isinstance(origin, str) and origin:
                remote_origin = f"{origin}:remote-mirror:r{remote_index}"

            if context.util.is_canceled():
                raise RemoteInvokeError("Remote dispatch was canceled")
            remote_item_id = remote_client.enqueue_graph(
                graph=remote_graph,
                queue_id=queue_id,
                origin=remote_origin,
            )
            remote_item_ids.append(int(remote_item_id))

            # The long-lived bridge imports progress/results without waiting behind the local queue.
            bridge_task_id = start_remote_bridge(
                services=context._services,
                local_queue_item=local_queue_item,
                source_invocation=self,
                remote_url=remote_client.config.base_url,
                remote_item_id=int(remote_item_id),
                remote_queue_id=queue_id,
                local_board_id=target_local_board_id,
                result_destination=self.result_destination,
                keep_remote_copies=self.keep_remote_copies,
                poll_interval_seconds=self.collector_poll_interval_seconds,
                timeout_seconds=self.collector_timeout_seconds,
                remote_slot=remote_index,
            )
            bridge_task_ids.append(int(bridge_task_id))
            context.logger.info(
                f"Mirror Current Workflow: remote #{remote_index} {remote_client.config.base_url} "
                f"queued item {remote_item_id}; bridge task {bridge_task_id} started"
            )

        primary_item_id = remote_item_ids[0]
        primary_seed = seed_values[0]
        primary_bridge_task_id = bridge_task_ids[0]
        ticket = json.dumps(
            {
                "version": 2,
                "remote_url": remote_urls[0],
                "queue_id": queue_id,
                "item_id": int(primary_item_id),
                "remote_seed": int(primary_seed),
                "remote_urls": remote_urls,
                "item_ids": remote_item_ids,
                "remote_seeds": seed_values,
                "collector_item_ids": bridge_task_ids,
                "bridge_task_ids": bridge_task_ids,
            },
            separators=(",", ":"),
        )
        context.logger.info(
            f"Mirror Current Workflow: queued {len(remote_item_ids)} remote worker job(s) with "
            f"{len(nodes)} mirrored node(s) each; the primary instance continues its current workflow normally"
        )
        return RemoteMirrorCurrentWorkflowOutput(
            ticket=ticket,
            remote_item_id=int(primary_item_id),
            remote_seed=int(primary_seed),
            mirrored_nodes=len(nodes),
            collector_item_id=int(primary_bridge_task_id),
            bridge_task_id=int(primary_bridge_task_id),
            remote_count=len(remote_item_ids),
            remote_item_ids=json.dumps(remote_item_ids, separators=(",", ":")),
            remote_seeds=json.dumps(seed_values, separators=(",", ":")),
            collector_item_ids=json.dumps(bridge_task_ids, separators=(",", ":")),
            bridge_task_ids=json.dumps(bridge_task_ids, separators=(",", ":")),
        )


# IMPORTANT: the Python class name intentionally begins with ZZZ. Combined with
# the local_image dependency, this keeps the collector at the end of the local run.
@invocation(
    "irw_builtin_collect",
    title="Remote Workers - Built-in Collect Mirrored Image",
    tags=["remote", "invokeai", "worker", "mirror", "parallel", "collector", "image"],
    category="Remote Invoke",
    version="0.9.2",
    use_cache=False,
)
class ZZZRemoteMirrorCollectInvocation(BaseInvocation):
    """Wait for the remote mirror only after the normal local image has completed."""

    ticket: str = InputField(
        input=Input.Connection,
        description="Connect Ticket from Remote Invoke - Mirror Current Workflow.",
    )
    local_image: ImageField = InputField(
        input=Input.Connection,
        description="Connect the normal local workflow's final image here. This is a synchronization dependency, not an upload.",
    )
    poll_interval_seconds: float = InputField(
        default=0.75,
        ge=0.25,
        le=30.0,
        description="How often to poll the remote queue after the local image is finished.",
    )
    timeout_seconds: int = InputField(
        default=1800,
        ge=10,
        le=86400,
        description="Maximum time to wait for the mirrored remote workflow.",
    )

    def invoke(self, context: InvocationContext) -> ImageOutput:
        try:
            ticket = json.loads(self.ticket)
        except Exception as exc:
            raise RemoteInvokeError(f"Mirror ticket is not valid JSON: {exc}") from exc
        if not isinstance(ticket, dict) or int(ticket.get("version", 0)) not in {1, 2}:
            raise RemoteInvokeError("Mirror ticket is missing or has an unsupported version")

        try:
            remote_url = str(ticket["remote_url"])
            queue_id = str(ticket["queue_id"])
            remote_item_id = int(ticket["item_id"])
        except Exception as exc:
            raise RemoteInvokeError(f"Mirror ticket is missing required fields: {exc}") from exc

        client = _remote_client(remote_url)
        context.logger.info(
            f"Collect Mirrored Image: Local image {self.local_image.image_name} is complete; "
            f"waiting for remote item {remote_item_id}"
        )
        completed = client.wait_for_item(
            item_id=remote_item_id,
            queue_id=queue_id,
            poll_interval_seconds=self.poll_interval_seconds,
            timeout_seconds=self.timeout_seconds,
        )
        remote_names = client.extract_image_names(completed)
        imported_fields: list[ImageField] = []
        last_dto = None
        for remote_name in remote_names:
            image = client.download_image(remote_name)
            dto = context.images.save(image=image)
            last_dto = dto
            imported_fields.append(ImageField(image_name=dto.image_name))
            context.logger.info(
                f"Collect Mirrored Image: imported remote {remote_name} into the primary instance as {dto.image_name}"
            )

        if not imported_fields:
            raise RemoteInvokeError(f"Remote item {remote_item_id} completed without an importable image output")

        if last_dto is None:
            raise RemoteInvokeError(f"Remote item {remote_item_id} did not produce a saved image DTO")
        context.logger.info(
            f"Collect Mirrored Image: imported {len(imported_fields)} remote image(s) from item "
            f"{remote_item_id}; returning {last_dto.image_name} as native ImageOutput"
        )
        return ImageOutput.build(last_dto)
