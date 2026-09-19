import asyncio
import json
import re
import secrets
import threading
import uuid
from copy import deepcopy
from typing import Any, Literal

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

from .remote_bridge import start_remote_bridge
from .remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError
from .model_transfer import (
    ModelTransferError,
    TemporaryModelServer,
    enrich_model_identifier_hashes,
    resolve_local_model_file,
)


RemoteSeedMode = Literal["Randomize remote seed inputs", "Keep current workflow seeds"]

# Strip our own helper nodes from the mirrored graph so the remote worker cannot
# recursively mirror itself or try to collect its own output.
_HELPER_NODE_TYPES = {
    "irw_builtin_mirror_current_workflow",
    "irw_builtin_collect",
    # Legacy custom-node workflows must also be removed from the remote clone.
    "remote_mirror_current_workflow",
    "remote_mirror_collect",
    # Previous node-pack generations, stripped defensively if an older workflow
    # still contains one of them.
    "remote_dual_queue_dispatch_krea2",
    "remote_dual_queue_collect",
    "remote_parallel_krea2_dispatch",
    "remote_parallel_krea2_collect",
    "remote_parallel_krea2_kickoff",
    "remote_invoke_workflow_file_krea2",
}


def _remote_client(remote_url: str, user_id: str = "") -> RemoteInvokeClient:
    return RemoteInvokeClient(RemoteConfig.from_environment(base_url=remote_url, verify_ssl=False, user_id=user_id))


def _transfer_missing_model_to_remote(
    *,
    context: InvocationContext,
    remote_client: RemoteInvokeClient,
    remote_index: int,
    identifier: dict[str, Any],
    transfer_host: str,
    timeout_seconds: int,
) -> None:
    """Expose one existing local model file over LAN and let remote InvokeAI install it normally."""
    try:
        model = resolve_local_model_file(context._services, identifier)
    except ModelTransferError as exc:
        raise RemoteInvokeError(str(exc)) from exc

    existing = remote_client.get_model_by_hash(model.hash)
    if existing is not None:
        return

    gib = model.path.stat().st_size / (1024 ** 3)
    context.logger.warning(
        f"Remote #{remote_index}: required model '{model.name}' is missing; "
        f"serving {model.path.name} ({gib:.2f} GiB) directly from this InvokeAI host over the LAN"
    )

    try:
        with TemporaryModelServer(
            model=model,
            remote_url=remote_client.config.base_url,
            advertise_host=transfer_host,
        ) as server:
            context.logger.info(
                f"Remote #{remote_index}: temporary model transfer endpoint ready at {server.url}"
            )
            job = remote_client.install_model_from_url(server.url, name=model.name)
            try:
                job_id = int(job.get("id"))
            except (TypeError, ValueError) as exc:
                raise RemoteInvokeError(f"Remote model installer returned no usable job id: {job}") from exc

            context.logger.info(
                f"Remote #{remote_index}: InvokeAI model install job {job_id} started for '{model.name}'"
            )
            completed = remote_client.wait_for_model_install(
                job_id,
                timeout_seconds=float(timeout_seconds),
                poll_interval_seconds=1.0,
            )
            context.logger.info(
                f"Remote #{remote_index}: model install job {job_id} completed with status "
                f"{completed.get('status', 'completed')}"
            )
    except ModelTransferError as exc:
        raise RemoteInvokeError(str(exc)) from exc

    installed = remote_client.get_model_by_hash(model.hash)
    if installed is None:
        raise RemoteInvokeError(
            f"Remote #{remote_index}: '{model.name}' finished installing but hash {model.hash} "
            "was not found in the remote model manager"
        )

    remote_payload = installed.get("model") if isinstance(installed.get("model"), dict) else installed
    context.logger.info(
        f"Remote #{remote_index}: verified transferred model '{model.name}' by hash; "
        f"remote key={remote_payload.get('key', 'unknown')}"
    )


def _run_coroutine_sync(coro):
    """Run an InvokeAI async service call from this synchronous invocation.

    InvokeAI v7 normally executes invocations outside the API event loop, so asyncio.run()
    is sufficient. The thread fallback keeps this safe if execution ever occurs while a loop
    is already active in the current thread.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)

    result_box = []
    error_box = []

    def runner():
        try:
            result_box.append(asyncio.run(coro))
        except BaseException as exc:  # propagate the original service error to the invocation
            error_box.append(exc)

    thread = threading.Thread(target=runner, name="invokeai-remote-worker-local-enqueue", daemon=True)
    thread.start()
    thread.join()
    if error_box:
        raise error_box[0]
    if not result_box:
        raise RemoteInvokeError("Local InvokeAI queue service returned no result")
    return result_box[0]


def _enqueue_local_graph(
    context: InvocationContext,
    *,
    graph: dict[str, Any],
    queue_id: str,
    origin: str,
    destination: str | None,
) -> int:
    """Enqueue a graph directly through the local InvokeAI v7 queue service.

    This deliberately avoids calling the local HTTP API. In multi-user mode the current
    queue item already carries the authenticated local user's identity, so the collector is
    enqueued as that same user without asking for local credentials again.
    """
    try:
        queue_item = context._data.queue_item
        services = context._services
    except Exception as exc:
        raise RemoteInvokeError(
            "InvokeAI v7 local invocation context is unavailable; cannot enqueue the background collector"
        ) from exc
        
    from invokeai.app.services.session_queue.session_queue_common import Batch

    batch = Batch(
        graph=graph,
        runs=1,
        origin=origin,
        destination=destination,
    )
    result = _run_coroutine_sync(
        services.session_queue.enqueue_batch(
            queue_id=queue_id,
            batch=batch,
            prepend=False,
            user_id=queue_item.user_id,
        )
    )
    item_ids = list(getattr(result, "item_ids", []) or [])
    if not item_ids:
        raise RemoteInvokeError("Local InvokeAI did not return an item ID for the background collector")
    return int(item_ids[0])


def _resolve_remote_urls(primary_url: str, additional_urls: str) -> list[str]:
    """Return a de-duplicated list of remote InvokeAI base URLs.

    The primary URL retains the existing INVOKE_REMOTE_URL fallback. Additional URLs
    may be separated by commas, semicolons, or newlines.
    """
    raw_additional = [
        part.strip()
        for part in re.split(r"[,;\n\r]+", additional_urls or "")
        if part.strip()
    ]

    raw_urls: list[str] = []
    if (primary_url or "").strip():
        raw_urls.append(primary_url.strip())
    elif not raw_additional:
        # Preserve the existing environment-variable behavior when no URL is entered.
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


def _new_seed(value: int) -> int:
    if int(value) >= 0:
        return int(value)
    return secrets.randbelow(2147483648)


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
        context.logger.info(
            f"Mirror background collector: waiting for remote item {self.remote_item_id}"
        )
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
                f"Mirror background collector: imported remote {remote_name} into the primary instance as {dto.image_name}" +
                (f" on board {target_board_id}" if target_board_id else "")
            )
        if last_dto is None:
            raise RemoteInvokeError(
                f"Remote item {self.remote_item_id} completed without an importable image output"
            )

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


def _build_background_collector_graph(
    *,
    remote_url: str,
    remote_item_id: int,
    remote_queue_id: str,
    local_board_id: str,
    keep_remote_copies: bool,
    poll_interval_seconds: float,
    timeout_seconds: int,
) -> dict[str, Any]:
    node_id = f"remote_mirror_collect_{uuid.uuid4()}"
    return {
        "id": str(uuid.uuid4()),
        "nodes": {
            node_id: {
                "id": node_id,
                "type": "irw_builtin_background_collect",
                "is_intermediate": False,
                "use_cache": False,
                "remote_url": remote_url,
                "remote_item_id": int(remote_item_id),
                "remote_queue_id": remote_queue_id,
                "local_board_id": str(local_board_id or ""),
                "keep_remote_copies": bool(keep_remote_copies),
                "poll_interval_seconds": float(poll_interval_seconds),
                "timeout_seconds": int(timeout_seconds),
            }
        },
        "edges": [],
    }


@invocation_output("irw_builtin_mirror_current_workflow_output")
class RemoteMirrorCurrentWorkflowOutput(BaseInvocationOutput):
    ticket: str = OutputField(description="Remote job ticket for legacy/manual collection. v0.9.2 returns remote images automatically.")
    remote_item_id: int = OutputField(description="Remote worker queue item ID")
    remote_seed: int = OutputField(description="Remote seed override, or -1 when current workflow seeds were kept")
    mirrored_nodes: int = OutputField(description="Number of normal workflow nodes mirrored to the remote worker")
    collector_item_id: int = OutputField(description="Deprecated compatibility alias for the primary remote bridge task ID")
    bridge_task_id: int = OutputField(description="Background bridge task ID for the primary remote")
    remote_count: int = OutputField(description="Number of remote workers used for this invoke")
    remote_item_ids: str = OutputField(description="JSON list of remote queue item IDs")
    remote_seeds: str = OutputField(description="JSON list of remote seed overrides")
    collector_item_ids: str = OutputField(description="Deprecated compatibility alias for JSON list of remote bridge task IDs")
    bridge_task_ids: str = OutputField(description="JSON list of background remote bridge task IDs")


# IMPORTANT: the Python class name intentionally begins with AAA. InvokeAI-7
# groups ready nodes by Python class name and, absent ready_order, selects classes
# alphabetically. This makes the mirror kickoff run before normal workflow classes.
@invocation(
    "irw_builtin_mirror_current_workflow",
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
            "If a required single-file model is missing remotely, serve the existing local model over the LAN "
            "and ask remote InvokeAI to install it. Matching and post-install verification use the model hash."
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
        default=0.75, ge=0.25, le=30.0,
        description="How often the v0.9.2 bridge polls remote progress/status.",
    )
    collector_timeout_seconds: int = InputField(
        default=1800, ge=10, le=86400,
        description="Maximum time the v0.9.2 bridge waits for the remote render.",
    )

    def invoke(self, context: InvocationContext) -> RemoteMirrorCurrentWorkflowOutput:
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
        if not isinstance(source_graph, dict) or not isinstance(source_graph.get("nodes"), dict):
            raise RemoteInvokeError("Current local queue item has no usable session.graph")

        # Build a clean base clone once, then make one independent copy per remote.
        base_remote_graph = deepcopy(source_graph)
        base_remote_graph["id"] = str(uuid.uuid4())

        removed = _strip_helper_nodes(base_remote_graph)
        nodes = base_remote_graph.get("nodes", {})
        local_board_ids = _collect_local_board_ids(source_graph)
        stripped_board_nodes = _strip_remote_board_assignments(base_remote_graph)
        # An explicit image-node board wins. Board=Auto is absent from the
        # executable graph, so use webv2's captured enqueue-time board.
        target_local_board_id = (
            local_board_ids[0] if local_board_ids else self.local_gallery_board_id.strip()
        )
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
        if media_refs:
            preview = ", ".join(media_refs[:6])
            suffix = " ..." if len(media_refs) > 6 else ""
            context.logger.warning(
                "Mirror Current Workflow: the graph references existing local media "
                f"({preview}{suffix}). v0.10.0 does not copy source media to remote workers; "
                "those image/video names must already exist on each remote."
            )

        remote_urls = _resolve_remote_urls(self.remote_url, self.additional_remote_urls)
        if self.remote_seed_mode == "Randomize remote seed inputs":
            seed_values = _seed_values_for_remotes(self.remote_seed, len(remote_urls))
        else:
            seed_values = [-1 for _ in remote_urls]

        origin = current_item.get("origin")
        remote_item_ids: list[int] = []
        bridge_task_ids: list[int] = []

        for remote_index, remote_url in enumerate(remote_urls, start=1):
            remote_graph = deepcopy(base_remote_graph)
            remote_graph["id"] = str(uuid.uuid4())
            seed_value = seed_values[remote_index - 1]

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

            remote_client = _remote_client(remote_url, str(local_queue_item.user_id))

            missing_model_handler = None
            if self.auto_transfer_missing_models:
                def missing_model_handler(identifier: dict[str, Any], *, _remote_index: int = remote_index) -> None:
                    _transfer_missing_model_to_remote(
                        context=context,
                        remote_client=remote_client,
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
                context.logger.info(f"Remote #{remote_index} model remap: {mapping}")

            remote_origin = f"windows-mirror-current-workflow:r{remote_index}"
            if isinstance(origin, str) and origin:
                remote_origin = f"{origin}:remote-mirror:r{remote_index}"

            remote_item_id = remote_client.enqueue_graph(
                graph=remote_graph,
                queue_id=queue_id,
                origin=remote_origin,
            )
            remote_item_ids.append(int(remote_item_id))

            # v0.9.2 does not enqueue a local collector item. A long-lived bridge uses only
            # InvokeAI's application services (not InvocationContext wrappers), so it can stream
            # remote progress and import the final image immediately without waiting behind the
            # remaining local queue.
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
            remote_seed = int(ticket.get("remote_seed", -1))
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

        # Return a native ImageOutput, matching InvokeAI's normal image-producing nodes.
        # All remote images above are saved into the local image service; the last
        # imported image is exposed as this node's standard Image output.
        if last_dto is None:
            raise RemoteInvokeError(f"Remote item {remote_item_id} did not produce a saved image DTO")
        context.logger.info(
            f"Collect Mirrored Image: imported {len(imported_fields)} remote image(s) from item "
            f"{remote_item_id}; returning {last_dto.image_name} as native ImageOutput"
        )
        return ImageOutput.build(last_dto)
