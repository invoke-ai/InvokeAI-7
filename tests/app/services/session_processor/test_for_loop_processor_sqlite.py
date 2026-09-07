import asyncio
import uuid
from contextlib import contextmanager
from threading import Condition, Event
from typing import Any, Iterator

import pytest
from fastapi_events.handlers.local import local_handler

from invokeai.app.invocations.baseinvocation import BaseInvocation, BaseInvocationOutput, invocation, invocation_output
from invokeai.app.invocations.fields import InputField, OutputField
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.events.events_base import EventServiceBase
from invokeai.app.services.events.events_common import EventBase, QueueItemStatusChangedEvent
from invokeai.app.services.invoker import Invoker
from invokeai.app.services.session_processor.session_processor_default import (
    DefaultSessionProcessor,
    DefaultSessionRunner,
)
from invokeai.app.services.session_queue.session_queue_sqlite import SqliteSessionQueue
from invokeai.app.services.shared.graph import CollectInvocation, Graph, GraphExecutionState, IterateInvocation
from invokeai.app.services.shared.invocation_context import InvocationContext
from tests.test_nodes import create_edge, create_loop_linkage


@invocation_output("test_for_sqlite_body_output")
class ForSqliteBodyOutput(BaseInvocationOutput):
    value: int = OutputField(description="The loop body value")


@invocation("test_for_sqlite_body", version="1.0.0")
class ForSqliteBodyInvocation(BaseInvocation):
    value: int = InputField(default=0, description="The current loop item")
    fail_on: int | None = InputField(default=None, description="The value that raises an exception")

    def invoke(self, context: InvocationContext) -> ForSqliteBodyOutput:
        if self.value == self.fail_on:
            raise ValueError(f"Refusing loop value {self.value}")
        return ForSqliteBodyOutput(value=self.value)


@invocation_output("test_for_sqlite_collection_adapter_output")
class ForSqliteCollectionAdapterOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(description="The inner loop collection")


@invocation("test_for_sqlite_collection_adapter", version="1.0.0")
class ForSqliteCollectionAdapterInvocation(BaseInvocation):
    value: Any = InputField(default=None, description="The outer loop item")

    def invoke(self, context: InvocationContext) -> ForSqliteCollectionAdapterOutput:
        return ForSqliteCollectionAdapterOutput(collection=self.value)


@invocation_output("test_for_sqlite_after_output")
class ForSqliteAfterOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(description="The completed loop collection")


@invocation("test_for_sqlite_after", version="1.0.0")
class ForSqliteAfterInvocation(BaseInvocation):
    collection: list[Any] = InputField(default_factory=list, description="The completed loop collection")

    def invoke(self, context: InvocationContext) -> ForSqliteAfterOutput:
        return ForSqliteAfterOutput(collection=self.collection)


def _build_nested_graph(*, fail_on: int | None = None) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[[1, 2], [3, 4]]))
    graph.add_node(ForSqliteCollectionAdapterInvocation(id="adapter"))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(ForSqliteBodyInvocation(id="body", fail_on=fail_on))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(ForSqliteAfterInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "adapter", "value"))
    graph.add_edge(create_edge("adapter", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "collection"))
    graph.add_edge(create_loop_linkage("for", "return"))
    return graph


def _build_nested_for_graph(*, fail_on: int | None = None) -> Graph:
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[1, 2], [3, 4]]))
    graph.add_node(ForSqliteCollectionAdapterInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(ForSqliteBodyInvocation(id="inner_body", fail_on=fail_on))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(ForSqliteAfterInvocation(id="after"))
    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_body", "value"))
    graph.add_edge(create_edge("inner_body", "value", "inner_return", "output"))
    graph.add_edge(create_edge("inner_for", "output_collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "collection"))
    graph.add_edge(create_loop_linkage("outer_for", "outer_return"))
    graph.add_edge(create_loop_linkage("inner_for", "inner_return"))
    return graph


class _RecordingRegisteredEventService(EventServiceBase):
    def __init__(self) -> None:
        self._events: list[EventBase] = []
        self._events_condition = Condition()

    def dispatch(self, event: EventBase) -> None:
        with self._events_condition:
            self._events.append(event)
            self._events_condition.notify_all()
        asyncio.run(local_handler.handle((event.__event_name__, event)))

    def wait_for_status(self, item_id: int, status: str, timeout: float = 5) -> bool:
        def has_status() -> bool:
            return any(
                isinstance(event, QueueItemStatusChangedEvent) and event.item_id == item_id and event.status == status
                for event in self._events
            )

        with self._events_condition:
            if has_status():
                return True
            return self._events_condition.wait_for(has_status, timeout=timeout)


@pytest.fixture
def registered_event_bus() -> Iterator[_RecordingRegisteredEventService]:
    yield _RecordingRegisteredEventService()


def _stop_processor(processor: DefaultSessionProcessor) -> None:
    processor.stop()
    for worker in processor._workers:
        assert worker.thread is not None
        worker.thread.join(timeout=5)
        assert not worker.thread.is_alive()


def _insert_session(queue: SqliteSessionQueue, graph: Graph) -> int:
    session = GraphExecutionState(graph=graph)
    with queue._db.transaction() as cursor:
        cursor.execute(
            """--sql
            INSERT INTO session_queue (
                queue_id, session, session_id, batch_id, field_values, priority,
                workflow, origin, destination, retried_from_item_id, user_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "default",
                session.model_dump_json(warnings=False, exclude_none=True),
                session.id,
                str(uuid.uuid4()),
                None,
                0,
                None,
                None,
                None,
                None,
                "system",
            ),
        )
        return cursor.lastrowid  # type: ignore[return-value]


class _Stats:
    @contextmanager
    def collect_stats(self, invocation, graph_execution_state_id):
        yield

    def log_stats(self, graph_execution_state_id) -> None:
        pass

    def reset_stats(self, graph_execution_state_id) -> None:
        pass


@pytest.mark.parametrize("outcome", ["success", "canceled", "failure"])
def test_processor_sqlite_queue_nested_iterate_for_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    mock_invoker: Invoker,
    registered_event_bus: _RecordingRegisteredEventService,
    outcome: str,
) -> None:
    monkeypatch.setattr(
        "invokeai.app.services.session_processor.session_processor_default.build_invocation_context",
        lambda data, services, is_canceled: None,
    )

    queue = SqliteSessionQueue(db=mock_invoker.services.board_records._db)
    mock_invoker.services.events = registered_event_bus
    mock_invoker.services.session_queue = queue
    mock_invoker.services.performance_statistics = _Stats()
    queue.start(mock_invoker)

    returns_seen = 0

    def cancel_after_first_return(invocation, queue_item, output) -> None:
        nonlocal returns_seen
        if queue_item.session.prepared_source_mapping[invocation.id] != "return":
            return
        returns_seen += 1
        if outcome == "canceled" and returns_seen == 1:
            queue.cancel_queue_item(queue_item.item_id)

    processor = DefaultSessionProcessor(
        session_runner=DefaultSessionRunner(on_after_run_node_callbacks=[cancel_after_first_return]),
        polling_interval=0,
    )
    graph = _build_nested_graph(fail_on=2 if outcome == "failure" else None)
    item_id = _insert_session(queue, graph)
    status_handler_called = Event()
    original_status_handler = processor._on_queue_item_status_changed

    async def recording_status_handler(event) -> None:
        if event[1].item_id == item_id and event[1].status == "canceled":
            status_handler_called.set()
        await original_status_handler(event)

    processor._on_queue_item_status_changed = recording_status_handler  # type: ignore[method-assign]
    try:
        processor.start(mock_invoker)

        expected_status = {
            "success": "completed",
            "canceled": "canceled",
            "failure": "failed",
        }[outcome]
        assert registered_event_bus.wait_for_status(item_id, expected_status)

        queue_item = queue.get_queue_item(item_id)
        assert queue_item.status == expected_status
        assert queue.get_current("default") is None
        assert any(
            isinstance(event, QueueItemStatusChangedEvent)
            and event.item_id == item_id
            and event.status == expected_status
            for event in registered_event_bus._events
        )

        if outcome == "success":
            assert queue_item.session.is_complete()
            [after_exec_id] = queue_item.session.source_prepared_mapping["after"]
            assert queue_item.session.results[after_exec_id].collection == [[1, 2], [3, 4]]
            assert returns_seen == 2
        else:
            assert "after" not in queue_item.session.source_prepared_mapping
            assert ("for", ()) not in queue_item.session.finalized_loop_contexts
            if outcome == "canceled":
                assert returns_seen == 1
                assert status_handler_called.wait(timeout=5)
                assert not queue_item.session.is_complete()
            else:
                assert queue_item.session.has_error()
                assert queue_item.error_type == "ValueError"
                assert queue_item.error_message == "Refusing loop value 2"
                assert returns_seen == 0
    finally:
        _stop_processor(processor)


@pytest.mark.parametrize("outcome", ["success", "canceled", "failure"])
def test_processor_sqlite_queue_nested_for_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    mock_invoker: Invoker,
    registered_event_bus: _RecordingRegisteredEventService,
    outcome: str,
) -> None:
    monkeypatch.setattr(
        "invokeai.app.services.session_processor.session_processor_default.build_invocation_context",
        lambda data, services, is_canceled: None,
    )

    queue = SqliteSessionQueue(db=mock_invoker.services.board_records._db)
    mock_invoker.services.events = registered_event_bus
    mock_invoker.services.session_queue = queue
    mock_invoker.services.performance_statistics = _Stats()
    queue.start(mock_invoker)

    inner_returns_seen = 0

    def cancel_after_first_inner_return(invocation, queue_item, output) -> None:
        nonlocal inner_returns_seen
        if queue_item.session.prepared_source_mapping[invocation.id] != "inner_return":
            return
        inner_returns_seen += 1
        if outcome == "canceled" and inner_returns_seen == 1:
            queue.cancel_queue_item(queue_item.item_id)

    processor = DefaultSessionProcessor(
        session_runner=DefaultSessionRunner(on_after_run_node_callbacks=[cancel_after_first_inner_return]),
        polling_interval=0,
    )
    graph = _build_nested_for_graph(fail_on=3 if outcome == "failure" else None)
    item_id = _insert_session(queue, graph)
    status_handler_called = Event()
    original_status_handler = processor._on_queue_item_status_changed

    async def recording_status_handler(event) -> None:
        if event[1].item_id == item_id and event[1].status == "canceled":
            status_handler_called.set()
        await original_status_handler(event)

    processor._on_queue_item_status_changed = recording_status_handler  # type: ignore[method-assign]
    try:
        processor.start(mock_invoker)

        expected_status = {
            "success": "completed",
            "canceled": "canceled",
            "failure": "failed",
        }[outcome]
        assert registered_event_bus.wait_for_status(item_id, expected_status)

        queue_item = queue.get_queue_item(item_id)
        assert queue_item.status == expected_status
        assert queue.get_current("default") is None
        assert any(
            isinstance(event, QueueItemStatusChangedEvent)
            and event.item_id == item_id
            and event.status == expected_status
            for event in registered_event_bus._events
        )

        if outcome == "success":
            assert queue_item.session.is_complete()
            [after_exec_id] = queue_item.session.source_prepared_mapping["after"]
            assert queue_item.session.results[after_exec_id].collection == [[1, 2], [3, 4]]
            assert (
                len(
                    [
                        exec_id
                        for exec_id in queue_item.session.source_prepared_mapping["outer_return"]
                        if exec_id in queue_item.session.results
                    ]
                )
                == 2
            )
            assert inner_returns_seen == 4
        else:
            assert "after" not in queue_item.session.source_prepared_mapping
            assert ("outer_for", ()) not in queue_item.session.finalized_loop_contexts
            assert not any(
                getattr(queue_item.session.results.get(exec_id), "output_collection", [])
                for exec_id in queue_item.session.source_prepared_mapping.get("outer_for", [])
            )
            if outcome == "canceled":
                assert inner_returns_seen == 1
                assert not any(
                    exec_id in queue_item.session.results
                    for exec_id in queue_item.session.source_prepared_mapping.get("outer_return", [])
                )
                assert status_handler_called.wait(timeout=5)
                assert not queue_item.session.is_complete()
            else:
                assert queue_item.session.has_error()
                assert queue_item.error_type == "ValueError"
                assert queue_item.error_message == "Refusing loop value 3"
                assert (
                    len(
                        [
                            exec_id
                            for exec_id in queue_item.session.source_prepared_mapping["outer_return"]
                            if exec_id in queue_item.session.results
                        ]
                    )
                    == 1
                )
                assert inner_returns_seen == 2
    finally:
        _stop_processor(processor)
