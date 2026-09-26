from __future__ import annotations

import threading
from concurrent.futures import Future
from queue import Queue
from typing import Any, Callable, TypeVar

AUTOMATIC_MIRROR_NODE_ID = "__irw_automatic_mirror__"
AUTOMATIC_MIRROR_NODE_TYPE = "irw_builtin_mirror_current_workflow"


T = TypeVar("T")

_IRW_EARLY_LOCK = threading.Lock()
_IRW_EARLY_RESULTS: dict[int, Future[Any]] = {}
_IRW_EARLY_PENDING: Queue[tuple[int, Any]] = Queue()
_IRW_EARLY_SCHEDULED: set[int] = set()
_IRW_EARLY_WORKERS_STARTED = False


def dispatch_remote_once(item_id: int, dispatch: Callable[[], T]) -> T:
    """Run one dispatch per backend queue item and let concurrent callers join its result."""
    with _IRW_EARLY_LOCK:
        existing = _IRW_EARLY_RESULTS.get(item_id)
        if existing is None:
            existing = Future()
            _IRW_EARLY_RESULTS[item_id] = existing
            owner = True
        else:
            owner = False
    if not owner:
        return existing.result()
    try:
        result = dispatch()
    except Exception as exc:
        existing.set_exception(exc)
        raise
    else:
        existing.set_result(result)
        return result


def _early_dispatch_worker() -> None:
    # Lazy imports avoid a module cycle: remote_nodes imports this module for
    # constants/dispatch_remote_once, while the worker needs the registered invocation type.
    from invokeai.app.invocations.remote_worker.remote_nodes import (
        AAARemoteMirrorCurrentWorkflowInvocation,
        RemoteModelTransferCancelled,
    )
    from invokeai.app.services.shared.invocation_context import InvocationContextData, build_invocation_context

    while True:
        item_id, services = _IRW_EARLY_PENDING.get()
        try:
            item = services.session_queue.get_queue_item(item_id)
            if item.status not in {"pending", "in_progress", "waiting"}:
                continue
            if services.configuration.multiuser:
                user = services.users.get(item.user_id)
                if user is None or not user.is_active:
                    continue
            helper = item.session.graph.nodes.get(AUTOMATIC_MIRROR_NODE_ID)
            if not isinstance(helper, AAARemoteMirrorCurrentWorkflowInvocation):
                continue

            def canceled(_services: Any = services, _item_id: int = item_id) -> bool:
                try:
                    return _services.session_queue.get_queue_item(_item_id).status in {
                        "canceled",
                        "failed",
                        "completed",
                    }
                except Exception:
                    return True

            if canceled():
                continue
            context = build_invocation_context(
                services=services,
                data=InvocationContextData(queue_item=item, invocation=helper, source_invocation_id=helper.id),
                is_canceled=canceled,
            )
            helper.invoke(context)
        except RemoteModelTransferCancelled:
            services.logger.info(f"IRW early remote dispatch item {item_id}: cancelled")
        except Exception as exc:
            # The normal queued invocation joins the same dispatch result/error,
            # so InvokeAI still handles the queue item terminal status normally.
            services.logger.error(f"IRW early remote dispatch item {item_id}: {exc}")
        finally:
            with _IRW_EARLY_LOCK:
                _IRW_EARLY_SCHEDULED.discard(item_id)
            _IRW_EARLY_PENDING.task_done()


def schedule_early_remote_dispatch(item_id: int, services: Any) -> None:
    """Enqueue a small CPU/network task; remote work never executes on the API thread."""
    global _IRW_EARLY_WORKERS_STARTED
    with _IRW_EARLY_LOCK:
        if item_id in _IRW_EARLY_SCHEDULED:
            return
        _IRW_EARLY_SCHEDULED.add(item_id)
        if not _IRW_EARLY_WORKERS_STARTED:
            for n in range(4):
                threading.Thread(
                    target=_early_dispatch_worker,
                    daemon=True,
                    name=f"irw-early-dispatch-{n + 1}",
                ).start()
            _IRW_EARLY_WORKERS_STARTED = True
    try:
        _IRW_EARLY_PENDING.put((item_id, services))
    except Exception:
        with _IRW_EARLY_LOCK:
            _IRW_EARLY_SCHEDULED.discard(item_id)
        raise


def schedule_automatic_remote_dispatches(*, batch: Any, item_ids: list[int], services: Any) -> bool:
    """Schedule the automatic Remote Worker fast lane for an enqueued batch, if present."""
    helper = batch.graph.nodes.get(AUTOMATIC_MIRROR_NODE_ID)
    if helper is None or helper.get_type() != AUTOMATIC_MIRROR_NODE_TYPE:
        return False

    for item_id in item_ids:
        schedule_early_remote_dispatch(int(item_id), services)
    return True
