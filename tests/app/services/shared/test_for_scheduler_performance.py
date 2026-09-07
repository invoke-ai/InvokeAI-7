"""Regression coverage for scheduler overhead with trivial loop bodies."""

import time
from collections.abc import Callable
from statistics import median
from unittest.mock import Mock

import pytest

from invokeai.app.invocations.collections import RangeInvocation
from invokeai.app.invocations.loops import ForInvocation, ForReturnInvocation
from invokeai.app.services.shared.graph import CollectInvocation, Graph, GraphExecutionState, IterateInvocation
from tests.test_nodes import AnyTypeTestInvocation, create_edge, create_loop_linkage


def _run_trivial_loop(loop_type: str, count: int, *, clock: Callable[[], float] = time.perf_counter) -> float:
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=count))
    graph.add_node(ForInvocation(id="loop") if loop_type == "for" else IterateInvocation(id="loop"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_edge(create_edge("range", "collection", "loop", "collection"))
    graph.add_edge(create_edge("loop", "item", "body", "value"))
    if loop_type == "for":
        graph.add_node(ForReturnInvocation(id="return"))
        graph.add_edge(create_edge("body", "value", "return", "output"))
        graph.add_edge(create_loop_linkage("loop", "return"))
    else:
        graph.add_node(CollectInvocation(id="collect"))
        graph.add_edge(create_edge("body", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)
    context = Mock()
    started = clock()
    while (node := state.next()) is not None:
        state.complete(node.id, node.invoke(context))
    assert state.is_complete()
    return clock() - started


@pytest.mark.parametrize("loop_type", ["iterate", "for"])
def test_loop_scheduler_overhead_is_linear(loop_type: str) -> None:
    timings = {count: [] for count in (300, 1200)}
    for _ in range(3):
        for count in (1200, 300):
            timings[count].append(_run_trivial_loop(loop_type, count, clock=time.process_time) / count)
    per_node = {count: median(samples) for count, samples in timings.items()}
    # Linear scheduling keeps per-item cost flat; the quadratic regression roughly doubled it per doubling.
    assert per_node[1200] < per_node[300] * 1.5, f"{loop_type}: {per_node}"


@pytest.mark.parametrize("loop_type", ["for", "iterate"])
def test_trivial_loop_scheduler_overhead(loop_type: str) -> None:
    elapsed = _run_trivial_loop(loop_type, 600)
    # Generous headroom for shared CI hosts; the reported quadratic For regression took six seconds.
    assert elapsed < 4, f"{loop_type}: {elapsed:.3f}s for 600 items"


def test_completion_predicate_preserves_durable_state() -> None:
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="value", value=1))
    state = GraphExecutionState(graph=graph)
    node = state.next()
    assert node is not None
    state.complete(node.id, node.invoke(Mock()))
    # A restored session may have completed executions without the derived source history yet.
    state.executed.discard("value")
    state.executed_history.clear()
    before = state.model_dump_json()
    assert state.is_complete()
    assert state.model_dump_json() == before
    restored_state = GraphExecutionState.model_validate_json(before)
    assert restored_state.is_complete()
    assert restored_state.model_dump_json() == before


def test_completion_cache_preserves_completed_sources_after_restore() -> None:
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="first", value=1))
    graph.add_node(AnyTypeTestInvocation(id="second", value=2))
    state = GraphExecutionState(graph=graph)

    first = state.next()
    assert first is not None
    state.complete(first.id, first.invoke(Mock()))

    restored_state = GraphExecutionState.model_validate_json(state.model_dump_json())
    second = restored_state.next()
    assert second is not None
    restored_state.complete(second.id, second.invoke(Mock()))

    assert restored_state.is_complete()
