from collections import defaultdict, deque
from collections.abc import Iterator
from typing import Any, Optional
from unittest.mock import Mock

import pytest
from pydantic import TypeAdapter

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    InvocationContext,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.collections import (
    CollectionCartesianInvocation,
    CollectionConcatInvocation,
    CollectionZipInvocation,
    RangeInvocation,
)
from invokeai.app.invocations.fields import InputField, OutputField
from invokeai.app.invocations.logic import IfInvocation, IfInvocationOutput
from invokeai.app.invocations.loops import (
    ForInvocation,
    ForInvocationOutput,
    ForReturnInvocation,
    ForReturnInvocationOutput,
    LoopState,
    StateGetInvocation,
    StateSetInvocation,
)
from invokeai.app.invocations.math import AddInvocation, MultiplyInvocation
from invokeai.app.invocations.primitives import (
    BooleanCollectionInvocation,
    BooleanCollectionOutput,
    BooleanInvocation,
    BooleanOutput,
    IntegerCollectionInvocation,
)
from invokeai.app.services.invocation_cache.invocation_cache_memory import MemoryInvocationCache
from invokeai.app.services.shared.graph import (
    CollectInvocation,
    Graph,
    GraphExecutionState,
    IterateInvocation,
    WorkflowCallFrame,
)

# This import must happen before other invoke imports or test in other files(!!) break
from tests.test_nodes import (
    AnyTypeTestInvocation,
    AnyTypeTestInvocationOutput,
    PolymorphicStringTestInvocation,
    PromptCollectionTestInvocation,
    PromptTestInvocation,
    TestEventService,
    TextToImageTestInvocation,
    create_edge,
    create_loop_linkage,
)


def add_test_loop_linkages(graph: Graph) -> Graph:
    """Add the explicit boundary edges shared by the runtime fixture graphs."""
    for_node_ids = [node.id for node in graph.nodes.values() if isinstance(node, ForInvocation)]
    return_node_ids = {node.id for node in graph.nodes.values() if isinstance(node, ForReturnInvocation)}
    for for_node_id in for_node_ids:
        return_node_id = "return" if for_node_id == "for" else for_node_id.removesuffix("_for") + "_return"
        if return_node_id in return_node_ids:
            graph.add_edge(create_loop_linkage(for_node_id, return_node_id))
    return graph


@invocation_output("test_two_any_output")
class TwoAnyTestInvocationOutput(BaseInvocationOutput):
    value: Any = OutputField()


@invocation("test_two_any", version="1.0.0")
class TwoAnyTestInvocation(BaseInvocation):
    first: Any = InputField(default=None)
    second: Any = InputField(default=None)

    def invoke(self, context: InvocationContext) -> TwoAnyTestInvocationOutput:
        return TwoAnyTestInvocationOutput(value=(self.first, self.second))


@invocation("test_continue_on_value", version="1.0.0")
class ContinueOnValueTestInvocation(BaseInvocation):
    value: Any = InputField(default=None)

    def invoke(self, context: InvocationContext) -> BooleanOutput:
        return BooleanOutput(value=self.value != "stop")


@invocation_output("test_nested_any_collection_output")
class NestedAnyCollectionTestInvocationOutput(BaseInvocationOutput):
    collection: list[list[Any]] = OutputField(default=[])


@invocation("test_nested_any_collection", version="1.0.0")
class NestedAnyCollectionTestInvocation(BaseInvocation):
    collection: list[list[Any]] = InputField(default=[])

    def invoke(self, context: InvocationContext) -> NestedAnyCollectionTestInvocationOutput:
        return NestedAnyCollectionTestInvocationOutput(collection=self.collection)


class IntegerCollectionTestInvocationOutput(BaseInvocationOutput):
    collection: list[int] = OutputField(default=[])


class IntegerCollectionFromItemTestInvocation(BaseInvocation):
    value: int = InputField(default=0)

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        base = self.value * 10
        return IntegerCollectionTestInvocationOutput(collection=[base, base + 1])


@invocation_output("test_any_collection_from_value_output")
class AnyCollectionFromValueTestInvocationOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(default=[])


@invocation("test_any_collection_from_value", version="1.0.0")
class AnyCollectionFromValueTestInvocation(BaseInvocation):
    value: Any = InputField(default=None)

    def invoke(self, context: InvocationContext) -> AnyCollectionFromValueTestInvocationOutput:
        return AnyCollectionFromValueTestInvocationOutput(collection=self.value)


@invocation_output("test_empty_collection_output")
class EmptyCollectionTestInvocationOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(default=[])


@invocation("test_empty_collection", version="1.0.0")
class EmptyCollectionTestInvocation(BaseInvocation):
    value: Any = InputField(default=None)

    def invoke(self, context: InvocationContext) -> EmptyCollectionTestInvocationOutput:
        return EmptyCollectionTestInvocationOutput(collection=[])


class IntegerCollectionWithBranchingTestInvocation(BaseInvocation):
    value: int = InputField(default=0)
    branch_count: int = InputField(default=2)

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        base = self.value * 10
        return IntegerCollectionTestInvocationOutput(collection=[base + branch for branch in range(self.branch_count)])


class MaybeEmptyIntegerCollectionTestInvocation(BaseInvocation):
    value: int = InputField(default=0)
    always_empty: bool = InputField(default=False)

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        if self.always_empty or self.value == 0:
            return IntegerCollectionTestInvocationOutput(collection=[])
        return IntegerCollectionTestInvocationOutput(collection=[self.value])


class EmptyOrTwoIntegerCollectionTestInvocation(BaseInvocation):
    value: int = InputField(default=0)

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        return IntegerCollectionTestInvocationOutput(collection=[] if self.value == 0 else [0, 1])


class IntegerCollectionPassthroughTestInvocation(BaseInvocation):
    collection: list[int] = InputField(default=[])

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        return IntegerCollectionTestInvocationOutput(collection=self.collection.copy())


class TwoIntegerCollectionsTestInvocation(BaseInvocation):
    first: list[int] = InputField(default=[])
    second: list[int] = InputField(default=[])

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        return IntegerCollectionTestInvocationOutput(collection=self.first + self.second)


class IntegerAndCollectionTestInvocation(BaseInvocation):
    value: int = InputField(default=0)
    collection: list[int] = InputField(default=[])

    def invoke(self, context: InvocationContext) -> IntegerCollectionTestInvocationOutput:
        return IntegerCollectionTestInvocationOutput(collection=[self.value, *self.collection])


@pytest.fixture
def simple_graph() -> Graph:
    g = Graph()
    g.add_node(PromptTestInvocation(id="1", prompt="Banana sushi"))
    g.add_node(TextToImageTestInvocation(id="2"))
    g.add_edge(create_edge("1", "prompt", "2", "prompt"))
    return g


def invoke_next(g: GraphExecutionState) -> tuple[Optional[BaseInvocation], Optional[BaseInvocationOutput]]:
    n = g.next()
    if n is None:
        return (None, None)

    print(f"invoking {n.id}: {type(n)}")
    o = n.invoke(Mock(InvocationContext))
    g.complete(n.id, o)

    return (n, o)


def execute_all_nodes(g: GraphExecutionState) -> list[str]:
    """Execute the graph to completion and return source node ids in execution order."""

    executed_source_ids: list[str] = []
    while True:
        invocation, _output = invoke_next(g)
        if invocation is None:
            break
        executed_source_ids.append(g.prepared_source_mapping[invocation.id])

    return executed_source_ids


def test_graph_state_executes_in_order(simple_graph: Graph):
    g = GraphExecutionState(graph=simple_graph)

    n1 = invoke_next(g)
    n2 = invoke_next(g)
    n3 = g.next()

    assert g.prepared_source_mapping[n1[0].id] == "1"
    assert g.prepared_source_mapping[n2[0].id] == "2"
    assert n3 is None
    assert g.results[n1[0].id].prompt == n1[0].prompt
    assert n2[0].prompt == n1[0].prompt


def test_graph_for_materializes_first_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))

    next_node = state.next()

    assert isinstance(next_node, ForInvocation)
    assert state.prepared_source_mapping[next_node.id] == "for"
    output = next_node.invoke(Mock(InvocationContext))

    assert isinstance(output, ForInvocationOutput)
    assert output.item == "alpha"
    assert output.index == 0
    assert output.total == 2
    assert output.state == LoopState()


def test_graph_for_return_receives_first_iteration_item():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_node, for_output = invoke_next(state)
    return_node, return_output = invoke_next(state)

    assert state.prepared_source_mapping[for_node.id] == "for"
    assert isinstance(return_node, ForReturnInvocation)
    assert state.prepared_source_mapping[return_node.id] == "return"
    assert isinstance(return_output, ForReturnInvocationOutput)
    assert return_output.output == for_output.item


def test_graph_for_final_outputs_do_not_materialize_from_iteration_output():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_node, _for_output = invoke_next(state)
    next_node = state.next()

    assert state.prepared_source_mapping[for_node.id] == "for"
    assert isinstance(next_node, ForReturnInvocation)
    assert "after" not in state.source_prepared_mapping


def test_graph_for_return_schedules_next_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    _return_node, _return_output = invoke_next(state)

    first_for_node_id = _for_node.id

    assert not state.is_complete()

    next_node = state.next()

    assert isinstance(next_node, ForInvocation)
    assert state.execution_graph.get_node(first_for_node_id).collection == []
    assert next_node.collection == ["alpha", "beta"]
    assert state.prepared_source_mapping[next_node.id] == "for"
    output = next_node.invoke(Mock(InvocationContext))

    assert isinstance(output, ForInvocationOutput)
    assert output.item == "beta"
    assert output.index == 1
    assert output.total == 2

    state.complete(next_node.id, output)
    next_return = state.next()

    assert isinstance(next_return, ForReturnInvocation)
    return_output = next_return.invoke(Mock(InvocationContext))

    assert isinstance(return_output, ForReturnInvocationOutput)
    assert return_output.output == "beta"
    state.complete(next_return.id, return_output)

    assert all(
        state.execution_graph.get_node(exec_node_id).collection == []
        for exec_node_id in state.source_prepared_mapping["for"]
    )
    assert state.is_complete()


def test_graph_sequential_for_uses_previous_final_collection_as_next_input():
    graph = Graph()
    graph.add_node(ForInvocation(id="first_for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("first_for", "item", "first_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "second_for", "collection"))
    graph.add_edge(create_edge("second_for", "item", "second_return", "output"))
    graph.add_edge(create_edge("second_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == ["alpha", "beta"]
    assert state.is_complete()


def test_graph_sequential_for_preserves_outer_iteration_scope():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="source", collection=[["alpha", "beta"], ["charlie"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("source", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "first_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "second_for", "collection"))
    graph.add_edge(create_edge("second_for", "item", "second_return", "output"))
    graph.add_edge(create_edge("second_for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    collect_exec_ids = sorted(state.source_prepared_mapping["collect"], key=state._get_iteration_path)
    assert [state._get_iteration_path(exec_id) for exec_id in collect_exec_ids] == [(0,), (1,)]
    assert [state.results[exec_id].collection for exec_id in collect_exec_ids] == [[["alpha", "beta"]], [["charlie"]]]
    assert state.is_complete()


@pytest.mark.parametrize("value", [42, None, {"item": 1}, "text", (1, 2)])
def test_graph_for_dynamic_non_collection_input_fails_with_a_clear_error(value: Any):
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="source", value=value))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("source", "value", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    source_node = state.next()
    assert isinstance(source_node, AnyTypeTestInvocation)
    state.complete(source_node.id, source_node.invoke(Mock(InvocationContext)))
    with pytest.raises(ValueError, match="For collection input must be a list"):
        state.next()


def test_graph_combines_independent_for_final_outputs_with_different_lengths():
    graph = Graph()
    graph.add_node(ForInvocation(id="first_for", collection=["alpha"]))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForInvocation(id="second_for", collection=["beta", "charlie"]))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(CollectionConcatInvocation(id="concat"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("first_for", "item", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "concat", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "concat", "second"))
    graph.add_edge(create_edge("concat", "collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == ["alpha", "beta", "charlie"]
    assert state.is_complete()


def test_graph_for_retention_survives_partial_json_round_trip():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta", "charlie"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    first_for_node, _first_for_output = invoke_next(state)
    _body_node, _body_output = invoke_next(state)
    first_return_node, _first_return_output = invoke_next(state)
    state.complete(
        first_return_node.id,
        ForReturnInvocationOutput(output="alpha", state=LoopState(values={"count": 1})),
    )

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)

    prepared_for_nodes = [
        resumed.execution_graph.get_node(exec_node_id) for exec_node_id in resumed.source_prepared_mapping["for"]
    ]
    assert first_for_node.id in resumed.execution_graph.nodes
    assert all(
        node.collection == ([] if node.index == 0 else ["alpha", "beta", "charlie"]) for node in prepared_for_nodes
    )

    execute_all_nodes(resumed)

    after_node_id = next(iter(resumed.source_prepared_mapping["after"]))
    assert resumed.results[after_node_id].value == ["alpha", "beta", "charlie"]
    assert resumed.is_complete()


def test_graph_for_return_passes_state_to_next_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_node = state.next()
    assert isinstance(for_node, ForInvocation)
    state.complete(for_node.id, for_node.invoke(Mock(InvocationContext)))
    return_node = state.next()
    assert isinstance(return_node, ForReturnInvocation)
    state.complete(return_node.id, ForReturnInvocationOutput(output="alpha", state=LoopState(values={"count": 1})))

    next_node = state.next()

    assert isinstance(next_node, ForInvocation)
    output = next_node.invoke(Mock(InvocationContext))

    assert isinstance(output, ForInvocationOutput)
    assert output.state == LoopState(values={"count": 1})


def test_graph_for_rematerializes_indirect_body_for_each_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    executed_source_ids = execute_all_nodes(state)

    assert executed_source_ids == ["for", "body", "return", "for", "body", "return", "after"]
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == ["alpha", "beta"]
    assert state.is_complete()


def test_graph_for_rematerializes_nested_iterate_body_through_collect():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[["a", "b"], ["c", "d"]]))
    graph.add_node(PolymorphicStringTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    collect_exec_ids = state.source_prepared_mapping["collect"]
    return_exec_ids = state.source_prepared_mapping["return"]

    assert sorted(state._get_iteration_path(exec_node_id) for exec_node_id in collect_exec_ids) == [(0,), (1,)]
    assert sorted(state._get_iteration_path(exec_node_id) for exec_node_id in return_exec_ids) == [(0,), (1,)]
    assert state.results[after_exec_id].value == [["a", "b"], ["c", "d"]]
    assert state.is_complete()


def test_graph_for_rematerializes_nested_iterate_body_chain_through_collect():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[["a", "b"], ["c", "d"]]))
    graph.add_node(PolymorphicStringTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AnyTypeTestInvocation(id="second_body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "second_body", "value"))
    graph.add_edge(create_edge("second_body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [["a", "b"], ["c", "d"]]
    assert state.is_complete()


def test_graph_for_nested_iterate_empty_inner_collection_still_returns_one_empty_group():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[0, 1]))
    graph.add_node(MaybeEmptyIntegerCollectionTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [[], [1]]
    assert state.is_complete()


def test_graph_for_nested_iterate_resumes_after_json_round_trip():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[["a", "b"], ["c", "d"]]))
    graph.add_node(PolymorphicStringTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for _ in range(4):
        invoke_next(state)

    resumed = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )
    execute_all_nodes(resumed)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert resumed.results[after_exec_id].value == [["a", "b"], ["c", "d"]]
    assert resumed.is_complete()


def test_graph_nested_for_resumes_after_json_round_trip_without_replaying_inner_output():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a", "b"], ["c", "d"]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyTypeTestInvocation(id="inner_body"))
    graph.add_node(StateSetInvocation(id="inner_state", key="last_item"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_body", "value"))
    graph.add_edge(create_edge("inner_for", "state", "inner_state", "state"))
    graph.add_edge(create_edge("inner_for", "item", "inner_state", "value"))
    graph.add_edge(create_edge("inner_body", "value", "inner_return", "output"))
    graph.add_edge(create_edge("inner_state", "state", "inner_return", "state"))
    graph.add_edge(create_edge("inner_for", "output_collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    executed_source_ids: list[str] = []
    for _ in range(6):
        invocation, _output = invoke_next(state)
        assert invocation is not None
        executed_source_ids.append(state.prepared_source_mapping[invocation.id])
    assert executed_source_ids == [
        "outer_for",
        "inner_collection",
        "inner_for",
        "inner_body",
        "inner_state",
        "inner_return",
    ]
    first_outer_inner_for_ids = [
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "inner_for" and state._get_iteration_path(exec_node_id) == (0, 1)
    ]
    assert len(first_outer_inner_for_ids) == 1
    assert state.execution_graph.get_node(first_outer_inner_for_ids[0]).state == LoopState(values={"last_item": "a"})
    prepared_mapping = state.prepared_source_mapping.copy()
    prepared_paths = {exec_node_id: state._get_iteration_path(exec_node_id) for exec_node_id in prepared_mapping}

    resumed = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )
    assert {edge.type for edge in resumed.graph.edges} == {"default", "loop_linkage"}
    assert resumed.prepared_source_mapping == prepared_mapping
    assert {
        exec_node_id: resumed._get_iteration_path(exec_node_id) for exec_node_id in prepared_mapping
    } == prepared_paths
    assert resumed.finalized_loop_contexts == set()

    resumed_source_ids = execute_all_nodes(resumed)

    assert resumed_source_ids == [
        "inner_for",
        "inner_body",
        "inner_state",
        "inner_return",
        "outer_return",
        "outer_for",
        "inner_collection",
        "inner_for",
        "inner_body",
        "inner_state",
        "inner_return",
        "inner_for",
        "inner_body",
        "inner_state",
        "inner_return",
        "outer_return",
        "after",
    ]
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert resumed.results[after_exec_id].value == [["a", "b"], ["c", "d"]]
    assert resumed.is_complete()


def test_graph_executes_deeper_nested_for_boundaries():
    graph = Graph()
    graph.add_node(
        ForInvocation(
            id="outer_for",
            collection=[[["a", "b"], [], ["c"]], [], [[], ["d"]]],
        )
    )
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="leaf_collection"))
    graph.add_node(ForInvocation(id="leaf_for"))
    graph.add_node(AnyTypeTestInvocation(id="leaf_body"))
    graph.add_node(ForReturnInvocation(id="leaf_return"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "leaf_collection", "value"))
    graph.add_edge(create_edge("leaf_collection", "collection", "leaf_for", "collection"))
    graph.add_edge(create_edge("leaf_for", "item", "leaf_body", "value"))
    graph.add_edge(create_edge("leaf_body", "value", "leaf_return", "output"))
    graph.add_edge(create_edge("leaf_for", "output_collection", "inner_return", "output"))
    graph.add_edge(create_edge("inner_for", "output_collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [[["a", "b"], [], ["c"]], [], [[], ["d"]]]
    assert state.is_complete()


def test_graph_executes_nested_for_with_outer_continuation_using_inner_final_output():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[], ["a"]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyTypeTestInvocation(id="inner_body"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(TwoAnyTestInvocation(id="continuation"))
    graph.add_node(AnyTypeTestInvocation(id="continuation_tail"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_body", "value"))
    graph.add_edge(create_edge("inner_body", "value", "inner_return", "output"))
    graph.add_edge(create_edge("outer_for", "item", "continuation", "first"))
    graph.add_edge(create_edge("inner_for", "output_collection", "continuation", "second"))
    graph.add_edge(create_edge("continuation", "value", "continuation_tail", "value"))
    graph.add_edge(create_edge("continuation_tail", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [([], []), (["a"], ["a"])]
    assert state.is_complete()


def test_graph_nested_for_inner_early_break_resumes_outer_loop():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a", "stop"], ["later"]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(ContinueOnValueTestInvocation(id="inner_condition"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_condition", "value"))
    graph.add_edge(create_edge("inner_for", "item", "inner_return", "output"))
    graph.add_edge(create_edge("inner_condition", "value", "inner_return", "continue_condition"))
    graph.add_edge(create_edge("inner_for", "output_collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [["a", "stop"], ["later"]]
    assert state.is_complete()


def test_graph_executes_independent_nested_for_children_through_explicit_fan_in():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[], ["a", "b"], ["c"]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AnyTypeTestInvocation(id="second_body"))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(TwoAnyTestInvocation(id="fan_in"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "value"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "fan_in", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "fan_in", "second"))
    graph.add_edge(create_edge("fan_in", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [([], []), (["a", "b"], ["a", "b"]), (["c"], ["c"])]
    assert state.is_complete()


def test_graph_executes_sibling_for_through_collection_concat():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a", "b"]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AnyTypeTestInvocation(id="second_body"))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(CollectionConcatInvocation(id="concat"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "value"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "concat", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "concat", "second"))
    graph.add_edge(create_edge("concat", "collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [["a", "b", "a", "b"]]
    assert state.is_complete()


def test_graph_executes_sibling_for_through_collection_zip():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[1, 2]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AddInvocation(id="second_body", b=10))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(CollectionZipInvocation(id="zip"))
    graph.add_node(ForReturnInvocation(id="outer_return"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "a"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "zip", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "zip", "second"))
    graph.add_edge(create_edge("zip", "collection", "outer_return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    outer_return_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "outer_return"
    )
    assert state.results[outer_return_id].output == [[1, 11], [2, 12]]
    assert state.is_complete()


def test_graph_executes_sibling_for_through_collection_cartesian():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[1, 2]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AddInvocation(id="second_body", b=10))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(CollectionCartesianInvocation(id="cartesian"))
    graph.add_node(ForReturnInvocation(id="outer_return"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "a"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "cartesian", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "cartesian", "second"))
    graph.add_edge(create_edge("cartesian", "collection", "outer_return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    outer_return_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "outer_return"
    )
    assert state.results[outer_return_id].output == [[1, 11], [1, 12], [2, 11], [2, 12]]
    assert state.is_complete()


def test_graph_nested_sibling_failure_does_not_release_outer_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a"]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AnyTypeTestInvocation(id="second_body"))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(TwoAnyTestInvocation(id="fan_in"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "value"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "fan_in", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "fan_in", "second"))
    graph.add_edge(create_edge("fan_in", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    while True:
        node = state.next()
        assert node is not None
        source_node_id = state.prepared_source_mapping[node.id]
        if source_node_id == "first_body":
            state.set_node_error(node.id, "first sibling failed")
            break
        state.complete(node.id, node.invoke(Mock(InvocationContext)))

    assert state.has_error()
    assert state.next() is None
    assert "fan_in" not in state.source_prepared_mapping
    assert "outer_return" not in state.source_prepared_mapping
    assert "after" not in state.source_prepared_mapping


def test_graph_executes_sibling_for_with_one_empty_child_context():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a", "b"], ["c"]]))
    graph.add_node(ForInvocation(id="first_for"))
    graph.add_node(EmptyCollectionTestInvocation(id="second_collection"))
    graph.add_node(ForInvocation(id="second_for"))
    graph.add_node(AnyTypeTestInvocation(id="first_body"))
    graph.add_node(AnyTypeTestInvocation(id="second_body"))
    graph.add_node(ForReturnInvocation(id="first_return"))
    graph.add_node(ForReturnInvocation(id="second_return"))
    graph.add_node(TwoAnyTestInvocation(id="fan_in"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "first_for", "collection"))
    graph.add_edge(create_edge("outer_for", "item", "second_collection", "value"))
    graph.add_edge(create_edge("second_collection", "collection", "second_for", "collection"))
    graph.add_edge(create_edge("first_for", "item", "first_body", "value"))
    graph.add_edge(create_edge("first_body", "value", "first_return", "output"))
    graph.add_edge(create_edge("second_for", "item", "second_body", "value"))
    graph.add_edge(create_edge("second_body", "value", "second_return", "output"))
    graph.add_edge(create_edge("first_for", "output_collection", "fan_in", "first"))
    graph.add_edge(create_edge("second_for", "output_collection", "fan_in", "second"))
    graph.add_edge(create_edge("fan_in", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [(["a", "b"], []), (["c"], [])]
    assert state.is_complete()
    assert set(state.graph.nx_graph_flat().nodes) <= state.executed


def test_graph_nested_for_continuation_failure_does_not_release_outer_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a"]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyTypeTestInvocation(id="inner_body"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(TwoAnyTestInvocation(id="continuation"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_body", "value"))
    graph.add_edge(create_edge("inner_body", "value", "inner_return", "output"))
    graph.add_edge(create_edge("outer_for", "item", "continuation", "first"))
    graph.add_edge(create_edge("inner_for", "output_collection", "continuation", "second"))
    graph.add_edge(create_edge("continuation", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    while True:
        node = state.next()
        assert node is not None
        if state.prepared_source_mapping[node.id] == "continuation":
            state.set_node_error(node.id, "outer continuation failed")
            break
        state.complete(node.id, node.invoke(Mock(InvocationContext)))

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert not any(
        exec_node_id in state.results for exec_node_id in state.source_prepared_mapping.get("outer_return", set())
    )


def test_graph_nested_for_continuation_resumes_after_json_round_trip():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[["a"], ["b"]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyTypeTestInvocation(id="inner_body"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(TwoAnyTestInvocation(id="continuation"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "inner_body", "value"))
    graph.add_edge(create_edge("inner_body", "value", "inner_return", "output"))
    graph.add_edge(create_edge("outer_for", "item", "continuation", "first"))
    graph.add_edge(create_edge("inner_for", "output_collection", "continuation", "second"))
    graph.add_edge(create_edge("continuation", "value", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for _ in range(5):
        invoke_next(state)

    continuation_ids = state.source_prepared_mapping["continuation"].copy()
    assert len(continuation_ids) == 1
    resumed = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )
    assert resumed.source_prepared_mapping["continuation"] == continuation_ids

    execute_all_nodes(resumed)

    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert resumed.results[after_exec_id].value == [(["a"], ["a"]), (["b"], ["b"])]
    assert resumed.is_complete()


def test_graph_deeper_nested_for_failure_does_not_release_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="outer_for", collection=[[["a"]]]))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="inner_collection"))
    graph.add_node(ForInvocation(id="inner_for"))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="leaf_collection"))
    graph.add_node(ForInvocation(id="leaf_for"))
    graph.add_node(AnyTypeTestInvocation(id="leaf_body"))
    graph.add_node(ForReturnInvocation(id="leaf_return"))
    graph.add_node(ForReturnInvocation(id="inner_return"))
    graph.add_node(ForReturnInvocation(id="outer_return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))

    graph.add_edge(create_edge("outer_for", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_for", "collection"))
    graph.add_edge(create_edge("inner_for", "item", "leaf_collection", "value"))
    graph.add_edge(create_edge("leaf_collection", "collection", "leaf_for", "collection"))
    graph.add_edge(create_edge("leaf_for", "item", "leaf_body", "value"))
    graph.add_edge(create_edge("leaf_body", "value", "leaf_return", "output"))
    graph.add_edge(create_edge("leaf_for", "output_collection", "inner_return", "output"))
    graph.add_edge(create_edge("inner_for", "output_collection", "outer_return", "output"))
    graph.add_edge(create_edge("outer_for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    while True:
        node = state.next()
        assert node is not None
        if state.prepared_source_mapping[node.id] == "leaf_body":
            state.set_node_error(node.id, "deeply nested body failed")
            break
        state.complete(node.id, node.invoke(Mock(InvocationContext)))

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert not any(
        exec_node_id in state.results for exec_node_id in state.source_prepared_mapping.get("outer_return", set())
    )


def test_graph_for_nested_iterate_scopes_under_parent_iterator():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="source", collection=[[["a", "b"], ["c"]], [["d", "e"]]]))
    graph.add_node(IterateInvocation(id="parent_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(PolymorphicStringTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="after"))
    graph.add_edge(create_edge("source", "collection", "parent_iterate", "collection"))
    graph.add_edge(create_edge("parent_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_ids = sorted(state.source_prepared_mapping["after"], key=state._get_iteration_path)
    assert [state._get_iteration_path(exec_node_id) for exec_node_id in after_exec_ids] == [(0,), (1,)]
    assert [state.results[exec_node_id].collection for exec_node_id in after_exec_ids] == [
        [[["a", "b"], ["c"]]],
        [[["d", "e"]]],
    ]
    assert state.is_complete()


def test_graph_for_nested_iterate_mixed_empty_groups_under_parent_iterator():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="source", collection=[[[], [1]], [[2]]]))
    graph.add_node(IterateInvocation(id="parent_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(AnyCollectionFromValueTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="after"))
    graph.add_edge(create_edge("source", "collection", "parent_iterate", "collection"))
    graph.add_edge(create_edge("parent_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)

    after_exec_ids = sorted(state.source_prepared_mapping["after"], key=state._get_iteration_path)
    assert [state._get_iteration_path(exec_node_id) for exec_node_id in after_exec_ids] == [(0,), (1,)]
    assert [state.results[exec_node_id].collection for exec_node_id in after_exec_ids] == [
        [[[], [1]]],
        [[[2]]],
    ]
    assert state.is_complete()


def test_graph_for_nested_iterate_failure_does_not_release_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[["a", "b"], ["c", "d"]]))
    graph.add_node(PolymorphicStringTestInvocation(id="collection_adapter"))
    graph.add_node(IterateInvocation(id="nested_iterate"))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "collection_adapter", "value"))
    graph.add_edge(create_edge("collection_adapter", "collection", "nested_iterate", "collection"))
    graph.add_edge(create_edge("nested_iterate", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    _adapter_node, _adapter_output = invoke_next(state)
    _inner_node, _inner_output = invoke_next(state)
    _inner_node, _inner_output = invoke_next(state)
    body_node = state.next()
    assert isinstance(body_node, AnyTypeTestInvocation)

    state.set_node_error(body_node.id, "nested body failed")

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert not any(exec_node_id in state.results for exec_node_id in state.source_prepared_mapping.get("return", set()))


def test_graph_for_rematerialized_body_carries_returned_state():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_0 = state.next()
    assert isinstance(for_0, ForInvocation)
    state.complete(for_0.id, for_0.invoke(Mock(InvocationContext)))
    body_0 = state.next()
    assert isinstance(body_0, AnyTypeTestInvocation)
    state.complete(body_0.id, body_0.invoke(Mock(InvocationContext)))
    return_0 = state.next()
    assert isinstance(return_0, ForReturnInvocation)
    state.complete(return_0.id, ForReturnInvocationOutput(output="alpha", state=LoopState(values={"count": 1})))

    for_1 = state.next()

    assert isinstance(for_1, ForInvocation)
    assert for_1.state == LoopState(values={"count": 1})


def test_graph_for_iteration_does_not_deep_copy_collection_twice():
    class DeepCopyCounter:
        copies = 0

        def __deepcopy__(self, memo):
            type(self).copies += 1
            return self

    item = DeepCopyCounter()
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[item, "last"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_edge(create_edge("for", "item", "return", "output"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_0 = state.next()
    assert isinstance(for_0, ForInvocation)
    DeepCopyCounter.copies = 0
    state.complete(for_0.id, for_0.invoke(Mock(InvocationContext)))
    return_0 = state.next()
    assert isinstance(return_0, ForReturnInvocation)
    state.complete(return_0.id, ForReturnInvocationOutput(output="first", state=LoopState()))

    for_1 = state.next()
    assert isinstance(for_1, ForInvocation)
    assert for_1.collection[0] is item
    assert DeepCopyCounter.copies == 2


def test_graph_for_body_state_helper_updates_state_for_next_iteration_and_final_output():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta", "charlie"]))
    graph.add_node(StateSetInvocation(id="state_set", key="last_item"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("for", "item", "state_set", "value"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "final_state", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    executed_source_ids = execute_all_nodes(state)

    assert executed_source_ids == [
        "for",
        "state_set",
        "return",
        "for",
        "state_set",
        "return",
        "for",
        "state_set",
        "return",
        "after",
    ]
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == LoopState(values={"last_item": "charlie"})
    assert state.is_complete()


def test_graph_for_body_state_helper_return_state_is_visible_to_next_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(StateSetInvocation(id="state_set", key="last_item"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "state", "return", "output"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("for", "item", "state_set", "value"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )

    assert state.results[after_exec_id].value == [
        LoopState(),
        LoopState(values={"last_item": "alpha"}),
    ]
    assert state.is_complete()


@pytest.mark.parametrize(
    ("completed_count", "expected_remaining_source_ids"),
    [
        (1, ["state_set", "return", "for", "state_set", "return", "after"]),
        (2, ["return", "for", "state_set", "return", "after"]),
        (3, ["for", "state_set", "return", "after"]),
    ],
)
def test_graph_for_partially_completed_stateful_loop_resumes_after_serialization(
    completed_count: int, expected_remaining_source_ids: list[str]
) -> None:
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(StateSetInvocation(id="state_set", key="last_item"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("for", "item", "state_set", "value"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "final_state", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for _ in range(completed_count):
        invoke_next(state)

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)
    registry = resumed._prepared_registry()
    executed_source_ids = execute_all_nodes(resumed)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
        if source_node_id == "after"
    )

    assert all(
        registry.get_iteration_path(exec_node_id) is not None for exec_node_id in resumed.prepared_source_mapping
    )
    assert executed_source_ids == expected_remaining_source_ids
    assert resumed.results[after_exec_id].value == LoopState(values={"last_item": "beta"})
    assert resumed.is_complete()


def test_graph_for_rematerialized_body_cache_keys_overlap_for_matching_item_inputs():
    def execute_loop_and_get_body_cache_keys(collection: list[int]) -> dict[int, int]:
        graph = Graph()
        graph.add_node(ForInvocation(id="for", collection=collection))
        graph.add_node(StateSetInvocation(id="state_set", key="item"))
        graph.add_node(ForReturnInvocation(id="return"))
        graph.add_edge(create_edge("for", "item", "state_set", "value"))
        graph.add_edge(create_edge("state_set", "state", "return", "state"))

        state = GraphExecutionState(graph=add_test_loop_linkages(graph))
        execute_all_nodes(state)

        return {
            state.execution_graph.get_node(exec_node_id).value: MemoryInvocationCache.create_key(
                state.execution_graph.get_node(exec_node_id)
            )
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "state_set"
        }

    first_keys = execute_loop_and_get_body_cache_keys([0, 1, 4, 5])
    second_keys = execute_loop_and_get_body_cache_keys([0, 2, 5, 7])

    assert first_keys[0] == second_keys[0]
    assert first_keys[5] == second_keys[5]
    assert first_keys[1] not in second_keys.values()
    assert first_keys[4] not in second_keys.values()


def test_graph_for_rematerialized_body_cache_keys_include_loop_state_inputs():
    def execute_loop_and_get_body_cache_keys(collection: list[int]) -> dict[int, int]:
        graph = Graph()
        graph.add_node(ForInvocation(id="for", collection=collection))
        graph.add_node(StateSetInvocation(id="state_set", key="item"))
        graph.add_node(ForReturnInvocation(id="return"))
        graph.add_edge(create_edge("for", "state", "state_set", "state"))
        graph.add_edge(create_edge("for", "item", "state_set", "value"))
        graph.add_edge(create_edge("state_set", "state", "return", "state"))

        state = GraphExecutionState(graph=add_test_loop_linkages(graph))
        execute_all_nodes(state)

        return {
            state.execution_graph.get_node(exec_node_id).value: MemoryInvocationCache.create_key(
                state.execution_graph.get_node(exec_node_id)
            )
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "state_set"
        }

    first_keys = execute_loop_and_get_body_cache_keys([0, 5])
    second_keys = execute_loop_and_get_body_cache_keys([1, 5])

    assert first_keys[5] != second_keys[5]


def test_graph_for_body_failure_stops_loop_without_releasing_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    body_node = state.next()
    assert isinstance(body_node, AnyTypeTestInvocation)

    state.set_node_error(body_node.id, "body failed")

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert state.source_prepared_mapping["for"] == {_for_node.id}
    assert not any(exec_node_id in state.results for exec_node_id in state.source_prepared_mapping.get("return", set()))


def test_graph_for_return_failure_stops_loop_without_releasing_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    _body_node, _body_output = invoke_next(state)
    return_node = state.next()
    assert isinstance(return_node, ForReturnInvocation)

    state.set_node_error(return_node.id, "return failed")

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert len(state.source_prepared_mapping["for"]) == 1
    assert not any(exec_node_id in state.results for exec_node_id in state.source_prepared_mapping.get("return", set()))


def test_graph_for_failure_after_successful_iteration_does_not_release_partial_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_0, _for_output_0 = invoke_next(state)
    _body_0, _body_output_0 = invoke_next(state)
    return_0 = state.next()
    assert isinstance(return_0, ForReturnInvocation)
    state.complete(return_0.id, ForReturnInvocationOutput(output="alpha", state=LoopState(values={"count": 1})))
    _for_1, _for_output_1 = invoke_next(state)
    body_1 = state.next()
    assert isinstance(body_1, AnyTypeTestInvocation)

    state.set_node_error(body_1.id, "second body failed")

    assert state.has_error()
    assert state.next() is None
    assert "after" not in state.source_prepared_mapping
    assert sum(exec_node_id in state.results for exec_node_id in state.source_prepared_mapping["return"]) == 1


def test_graph_for_failure_state_round_trip_does_not_resume_loop_or_release_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    body_node = state.next()
    assert isinstance(body_node, AnyTypeTestInvocation)
    state.set_node_error(body_node.id, "body failed")

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)

    assert resumed.has_error()
    assert resumed.next() is None
    assert "after" not in resumed.source_prepared_mapping
    assert not any(
        exec_node_id in resumed.results for exec_node_id in resumed.source_prepared_mapping.get("return", set())
    )


def test_graph_for_rematerialized_body_reuses_external_input_each_iteration():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="external", prompt="shared"))
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(TwoAnyTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "first"))
    graph.add_edge(create_edge("external", "prompt", "body", "second"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    executed_source_ids = execute_all_nodes(state)

    assert executed_source_ids.count("external") == 1
    assert executed_source_ids.count("for") == 2
    assert executed_source_ids.count("body") == 2
    assert executed_source_ids.count("return") == 2
    assert executed_source_ids[-1] == "after"
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )
    assert state.results[after_exec_id].value == [("alpha", "shared"), ("beta", "shared")]
    assert state.is_complete()


def test_graph_for_output_collection_is_scoped_to_parent_iterator_context():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[["alpha"], ["beta"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=state._get_iteration_path,
    )

    assert [state.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [["alpha"]],
        [["beta"]],
    ]


def test_graph_for_output_collection_preserves_multiple_items_per_parent_iterator_context():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[["alpha", "beta"], ["gamma"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=state._get_iteration_path,
    )

    assert [state._get_iteration_path(exec_node_id) for exec_node_id in collect_exec_ids] == [(0,), (1,)]
    assert [state.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [["alpha", "beta"]],
        [["gamma"]],
    ]


def test_graph_for_does_not_release_final_outputs_until_each_parent_context_finishes():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[["alpha"], ["beta", "gamma"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    while len(state.finalized_loop_contexts) < 1:
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    assert len(state.finalized_loop_contexts) == 1
    assert "collect" not in state.source_prepared_mapping

    resumed = TypeAdapter(GraphExecutionState).validate_json(state.model_dump_json(warnings=False), strict=False)
    assert resumed.finalized_loop_contexts == state.finalized_loop_contexts
    assert "collect" not in resumed.source_prepared_mapping

    execute_all_nodes(resumed)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=resumed._get_iteration_path,
    )
    assert [resumed.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [["alpha"]],
        [["beta", "gamma"]],
    ]


def test_graph_for_final_state_is_scoped_to_parent_iterator_context():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[["alpha"], ["beta"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(StateSetInvocation(id="state_set", key="item"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("for", "item", "state_set", "value"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "final_state", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=state._get_iteration_path,
    )

    assert [state.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [LoopState(values={"item": "alpha"})],
        [LoopState(values={"item": "beta"})],
    ]


def test_graph_for_final_output_collection_materializes_after_last_direct_return():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_0, _for_output_0 = invoke_next(state)
    _return_0, _return_output_0 = invoke_next(state)
    _for_1, _for_output_1 = invoke_next(state)
    _return_1, _return_output_1 = invoke_next(state)

    after_node = state.next()

    assert isinstance(after_node, AnyTypeTestInvocation)
    assert after_node.value == ["alpha", "beta"]


def test_graph_for_final_state_materializes_after_last_direct_return():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "final_state", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_0 = state.next()
    assert isinstance(for_0, ForInvocation)
    state.complete(for_0.id, for_0.invoke(Mock(InvocationContext)))
    return_0 = state.next()
    assert isinstance(return_0, ForReturnInvocation)
    state.complete(return_0.id, ForReturnInvocationOutput(output="alpha", state=LoopState(values={"count": 1})))
    for_1 = state.next()
    assert isinstance(for_1, ForInvocation)
    state.complete(for_1.id, for_1.invoke(Mock(InvocationContext)))
    return_1 = state.next()
    assert isinstance(return_1, ForReturnInvocation)
    state.complete(return_1.id, ForReturnInvocationOutput(output="beta", state=LoopState(values={"count": 2})))

    after_node = state.next()

    assert isinstance(after_node, AnyTypeTestInvocation)
    assert after_node.value == LoopState(values={"count": 2})


def test_graph_for_return_can_break_early_and_release_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta", "charlie"]))
    graph.add_node(ForReturnInvocation(id="return", continue_condition=False))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for_node, _for_output = invoke_next(state)
    assert isinstance(for_node, ForInvocation)
    return_node, return_output = invoke_next(state)
    assert isinstance(return_node, ForReturnInvocation)
    assert isinstance(return_output, ForReturnInvocationOutput)
    assert return_output.output == "alpha"

    after_node = state.next()

    assert isinstance(after_node, AnyTypeTestInvocation)
    assert after_node.value == ["alpha"]
    assert not any(
        isinstance(state.execution_graph.get_node(exec_node_id), ForInvocation)
        and state.execution_graph.get_node(exec_node_id).index == 1
        for exec_node_id in state.source_prepared_mapping["for"]
    )

    state.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))
    assert state.is_complete()


def test_graph_for_return_evaluates_connected_break_condition_for_each_iteration():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "stop", "charlie"]))
    graph.add_node(ContinueOnValueTestInvocation(id="condition"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "condition", "value"))
    graph.add_edge(create_edge("condition", "value", "return", "continue_condition"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    executed_source_ids: list[str] = []
    while True:
        node = state.next()
        assert node is not None
        source_id = state.prepared_source_mapping[node.id]
        if source_id == "after":
            after_node = node
            break
        executed_source_ids.append(source_id)
        state.complete(node.id, node.invoke(Mock(InvocationContext)))

    assert executed_source_ids.count("condition") == 2
    assert executed_source_ids.count("return") == 2
    assert isinstance(after_node, AnyTypeTestInvocation)
    assert after_node.value == ["alpha", "stop"]
    state.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))


def test_graph_for_return_early_break_survives_resume_with_returned_state():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"], state=LoopState(values={"count": 0})))
    graph.add_node(StateSetInvocation(id="state_set", key="count", value=1))
    graph.add_node(ForReturnInvocation(id="return", continue_condition=False))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "state", "state_set", "state"))
    graph.add_edge(create_edge("state_set", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    _state_set_node, _state_set_output = invoke_next(state)
    _return_node, _return_output = invoke_next(state)

    resumed = TypeAdapter(GraphExecutionState).validate_json(state.model_dump_json(warnings=False), strict=False)
    after_node = resumed.next()

    assert isinstance(after_node, TwoAnyTestInvocation)
    assert after_node.first == ["alpha"]
    assert after_node.second == LoopState(values={"count": 1})
    resumed.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))
    assert resumed.is_complete()


def test_graph_for_empty_collection_materializes_final_outputs():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[], state=LoopState(values={"initial": True})))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    after_node = state.next()

    assert isinstance(after_node, TwoAnyTestInvocation)
    assert after_node.first == []
    assert after_node.second == LoopState(values={"initial": True})
    assert "return" not in state.source_prepared_mapping
    state.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))

    assert state.is_complete()


def test_graph_for_empty_collection_round_trips_without_optional_item():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    after_node = state.next()
    assert isinstance(after_node, AnyTypeTestInvocation)

    resumed = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )
    resumed_after_node = resumed.next()

    assert isinstance(resumed_after_node, AnyTypeTestInvocation)
    assert resumed_after_node.value == []


def test_graph_for_empty_collection_round_trips_missing_loop_state_value():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(StateGetInvocation(id="get", key="missing"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "final_state", "get", "state"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    get_node = state.next()
    assert isinstance(get_node, StateGetInvocation)
    state.complete(get_node.id, get_node.invoke(Mock(InvocationContext)))

    resumed = TypeAdapter(GraphExecutionState).validate_json(
        state.model_dump_json(warnings=False, exclude_none=True), strict=False
    )

    assert resumed.results[get_node.id].value is None


def test_graph_for_empty_collection_preserves_connected_initial_state():
    graph = Graph()
    graph.add_node(IntegerCollectionInvocation(id="collection", collection=[]))
    graph.add_node(StateSetInvocation(id="initial_state", key="initial", value=True))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("collection", "collection", "for", "collection"))
    graph.add_edge(create_edge("initial_state", "state", "for", "state"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )

    assert state.results[after_exec_id].value == ([], LoopState(values={"initial": True}))
    assert state.is_complete()


def test_graph_for_independent_empty_and_nonempty_final_outputs_join_correctly():
    graph = Graph()
    graph.add_node(ForInvocation(id="empty_for", collection=[]))
    graph.add_node(ForInvocation(id="nonempty_for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="empty_return"))
    graph.add_node(ForReturnInvocation(id="nonempty_return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("empty_for", "item", "empty_return", "output"))
    graph.add_edge(create_edge("nonempty_for", "item", "nonempty_return", "output"))
    graph.add_edge(create_edge("empty_for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("nonempty_for", "output_collection", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )

    assert state.results[after_exec_id].value == ([], ["alpha", "beta"])
    assert state.is_complete()


def test_graph_for_nested_parent_context_survives_state_round_trip():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[["alpha", "beta"], ["gamma"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    for _ in range(5):
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    resumed = TypeAdapter(GraphExecutionState).validate_json(state.model_dump_json(warnings=False), strict=False)
    execute_all_nodes(resumed)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in resumed.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=resumed._get_iteration_path,
    )

    assert [resumed._get_iteration_path(exec_node_id) for exec_node_id in collect_exec_ids] == [(0,), (1,)]
    assert [resumed.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [["alpha", "beta"]],
        [["gamma"]],
    ]


def test_graph_for_empty_and_nonempty_parent_iterator_contexts_both_finalize():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[[], ["alpha"]]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    collect_exec_ids = sorted(
        (
            exec_node_id
            for exec_node_id, source_node_id in state.prepared_source_mapping.items()
            if source_node_id == "collect"
        ),
        key=state._get_iteration_path,
    )

    assert [state.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [
        [[]],
        [["alpha"]],
    ]
    assert state.is_complete()


def test_graph_for_under_empty_parent_iterator_collects_and_completes():
    graph = Graph()
    graph.add_node(NestedAnyCollectionTestInvocation(id="nested", collection=[]))
    graph.add_node(IterateInvocation(id="outer_iterate"))
    graph.add_node(ForInvocation(id="for"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("nested", "collection", "outer_iterate", "collection"))
    graph.add_edge(create_edge("outer_iterate", "item", "for", "collection"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "collect", "item"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    collect_exec_ids = [
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "collect"
    ]

    assert [state.results[exec_node_id].collection for exec_node_id in collect_exec_ids] == [[]]
    assert state.is_complete()


def test_graph_for_empty_collection_with_indirect_body_completes_without_body_execution():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=[]))
    graph.add_node(AnyTypeTestInvocation(id="body"))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "body", "value"))
    graph.add_edge(create_edge("body", "value", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    after_node = state.next()

    assert isinstance(after_node, AnyTypeTestInvocation)
    assert after_node.value == []
    assert "body" not in state.source_prepared_mapping
    assert "return" not in state.source_prepared_mapping
    state.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))

    assert state.is_complete()


def test_graph_for_return_none_output_is_collected():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha", "beta"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(AnyTypeTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "state", "return", "state"))
    graph.add_edge(create_edge("for", "output_collection", "after", "value"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    execute_all_nodes(state)
    after_exec_id = next(
        exec_node_id
        for exec_node_id, source_node_id in state.prepared_source_mapping.items()
        if source_node_id == "after"
    )

    assert state.results[after_exec_id].value == [None, None]


def test_graph_for_multiple_final_edges_to_same_node_do_not_crash():
    graph = Graph()
    graph.add_node(ForInvocation(id="for", collection=["alpha"]))
    graph.add_node(ForReturnInvocation(id="return"))
    graph.add_node(TwoAnyTestInvocation(id="after"))
    graph.add_edge(create_edge("for", "item", "return", "output"))
    graph.add_edge(create_edge("for", "output_collection", "after", "first"))
    graph.add_edge(create_edge("for", "final_state", "after", "second"))

    state = GraphExecutionState(graph=add_test_loop_linkages(graph))
    _for_node, _for_output = invoke_next(state)
    _return_node, _return_output = invoke_next(state)
    after_node = state.next()

    assert isinstance(after_node, TwoAnyTestInvocation)
    assert after_node.first == ["alpha"]
    assert after_node.second == LoopState()
    state.complete(after_node.id, after_node.invoke(Mock(InvocationContext)))

    assert state.is_complete()


def test_graph_is_complete(simple_graph: Graph):
    g = GraphExecutionState(graph=simple_graph)
    _ = invoke_next(g)
    _ = invoke_next(g)
    _ = g.next()

    assert g.is_complete()


def test_graph_is_not_complete(simple_graph: Graph):
    g = GraphExecutionState(graph=simple_graph)
    _ = invoke_next(g)
    _ = g.next()

    assert not g.is_complete()


def test_graph_waiting_on_workflow_call_blocks_other_ready_nodes():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="prompt_a", prompt="a"))
    graph.add_node(PromptTestInvocation(id="prompt_b", prompt="b"))

    g = GraphExecutionState(graph=graph)

    first = g.next()
    assert first is not None

    waiting_frame = g.build_workflow_call_frame(exec_node_id=first.id, workflow_id="workflow-a")
    g.begin_waiting_on_workflow_call(waiting_frame)

    assert g.next() is None
    assert not g.is_complete()
    assert g.is_waiting_on_workflow_call()


def test_graph_build_workflow_call_frame_uses_prepared_and_source_ids():
    g = GraphExecutionState(graph=Graph())
    g.execution_graph.add_node(PromptTestInvocation(id="prepared-call", prompt="a"))
    g.prepared_source_mapping["prepared-call"] = "source-call"

    frame = g.build_workflow_call_frame(exec_node_id="prepared-call", workflow_id="workflow-a")

    assert frame.prepared_call_node_id == "prepared-call"
    assert frame.source_call_node_id == "source-call"
    assert frame.workflow_id == "workflow-a"
    assert frame.depth == 1


def test_graph_build_workflow_call_frame_rejects_depth_over_limit():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source-call", prompt="a"))
    g = GraphExecutionState(
        graph=graph,
        workflow_call_stack=[
            WorkflowCallFrame(
                prepared_call_node_id=f"prepared-{i}",
                source_call_node_id=f"source-{i}",
                workflow_id=f"workflow-{i}",
                depth=i + 1,
            )
            for i in range(4)
        ],
    )
    g.execution_graph.add_node(PromptTestInvocation(id="prepared-call", prompt="a"))
    g.prepared_source_mapping["prepared-call"] = "source-call"

    with pytest.raises(ValueError, match="Maximum workflow call depth"):
        g.build_workflow_call_frame(exec_node_id="prepared-call", workflow_id="workflow-a")


def test_graph_execution_state_serializes_workflow_call_state():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source-call", prompt="a"))
    g = GraphExecutionState(graph=graph)
    g.execution_graph.add_node(PromptTestInvocation(id="prepared-call", prompt="a"))
    g.prepared_source_mapping["prepared-call"] = "source-call"

    frame = g.build_workflow_call_frame(exec_node_id="prepared-call", workflow_id="workflow-a")
    g.workflow_call_stack.append(frame)
    g.begin_waiting_on_workflow_call(frame)

    restored = GraphExecutionState.model_validate(g.model_dump(warnings=False))

    assert restored.workflow_call_stack == [frame]
    assert restored.waiting_workflow_call == frame
    assert restored.max_workflow_call_depth == 4


def test_graph_waiting_on_workflow_call_blocks_until_suspended_node_is_completed():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="prompt_a", prompt="a"))
    graph.add_node(PromptTestInvocation(id="prompt_b", prompt="b"))

    g = GraphExecutionState(graph=graph)

    first = g.next()
    assert first is not None

    waiting_frame = g.build_workflow_call_frame(exec_node_id=first.id, workflow_id="workflow-a")
    g.begin_waiting_on_workflow_call(waiting_frame)
    assert g.next() is None

    g.end_waiting_on_workflow_call()
    g.complete(first.id, first.invoke(Mock(InvocationContext)))

    resumed = g.next()
    assert resumed is not None
    assert resumed.id != first.id
    assert g.prepared_source_mapping[resumed.id] == "prompt_b"


def test_graph_begin_waiting_on_workflow_call_rejects_double_entry():
    g = GraphExecutionState(graph=Graph())
    g.execution_graph.add_node(PromptTestInvocation(id="prepared-call", prompt="a"))
    g.prepared_source_mapping["prepared-call"] = "source-call"

    first_frame = g.build_workflow_call_frame(exec_node_id="prepared-call", workflow_id="workflow-a")
    g.begin_waiting_on_workflow_call(first_frame)

    with pytest.raises(ValueError, match="already waiting"):
        g.begin_waiting_on_workflow_call(first_frame)


def test_graph_build_workflow_call_frame_rejects_missing_execution_node():
    g = GraphExecutionState(graph=Graph())

    with pytest.raises(Exception, match="not found in execution graph"):
        g.build_workflow_call_frame(exec_node_id="missing-node", workflow_id="workflow-a")


def test_graph_build_workflow_call_frame_rejects_unprepared_execution_node():
    g = GraphExecutionState(graph=Graph())
    g.execution_graph.add_node(PromptTestInvocation(id="prepared-call", prompt="a"))

    with pytest.raises(ValueError, match="not a prepared execution node"):
        g.build_workflow_call_frame(exec_node_id="prepared-call", workflow_id="workflow-a")


def test_graph_child_workflow_execution_state_inherits_stack_and_isolates_runtime_state():
    parent_graph = Graph()
    child_graph = Graph()

    parent = GraphExecutionState(graph=parent_graph)
    parent.execution_graph.add_node(PromptTestInvocation(id="prepared-parent", prompt="a"))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"
    parent.results["prepared-parent"] = PromptTestInvocation(id="result-node", prompt="existing").invoke(
        Mock(InvocationContext)
    )
    parent.executed.add("prepared-parent")

    root_frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")
    parent.workflow_call_stack.append(root_frame)

    parent.execution_graph.add_node(PromptTestInvocation(id="prepared-child", prompt="b"))
    parent.prepared_source_mapping["prepared-child"] = "source-child"
    child_frame = parent.build_workflow_call_frame(exec_node_id="prepared-child", workflow_id="workflow-b")

    child_state = parent.create_child_workflow_execution_state(graph=child_graph, frame=child_frame)

    assert child_state.graph == child_graph
    assert child_state.workflow_call_stack == [root_frame, child_frame]
    assert child_state.max_workflow_call_depth == parent.max_workflow_call_depth
    assert child_state.waiting_workflow_call is None
    assert child_state.results == {}
    assert child_state.executed == set()


def test_graph_waiting_workflow_call_tracks_parent_child_metadata():
    parent = GraphExecutionState(graph=Graph())
    parent.execution_graph.add_node(PromptTestInvocation(id="prepared-parent", prompt="a"))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"
    frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")

    child = parent.create_child_workflow_execution_state(graph=Graph(), frame=frame)
    parent.begin_waiting_on_workflow_call(frame)
    parent.attach_waiting_workflow_call_child_session(child)

    assert parent.waiting_workflow_call_execution is not None
    assert parent.waiting_workflow_call_execution.parent_session_id == parent.id
    assert parent.waiting_workflow_call_execution.child_session_id == child.id
    assert parent.waiting_workflow_call_execution.status == "running_child"
    assert child.workflow_call_parent is not None
    assert child.workflow_call_parent.workflow_call_id == parent.waiting_workflow_call_execution.id
    assert child.workflow_call_parent.parent_session_id == parent.id


def test_graph_attach_waiting_workflow_call_child_sessions_tracks_fan_out_metadata():
    parent = GraphExecutionState(graph=Graph())
    parent.execution_graph.add_node(AddInvocation(id="prepared-parent", a=1, b=2))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"

    frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")
    child_a = parent.create_child_workflow_execution_state(Graph(), frame)
    child_b = parent.create_child_workflow_execution_state(Graph(), frame)

    parent.begin_waiting_on_workflow_call(frame)
    parent.attach_waiting_workflow_call_child_sessions([child_a, child_b])

    assert parent.waiting_workflow_call_execution is not None
    assert parent.waiting_workflow_call_execution.child_session_ids == [child_a.id, child_b.id]
    assert parent.waiting_workflow_call_execution.expected_child_count == 2
    assert parent.waiting_workflow_call_child_session is None
    assert child_a.workflow_call_parent is not None
    assert child_b.workflow_call_parent is not None


def test_graph_record_waiting_workflow_call_child_completion_aggregates_named_values():
    parent = GraphExecutionState(graph=Graph())
    parent.execution_graph.add_node(AddInvocation(id="prepared-parent", a=1, b=2))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"

    frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")
    child_a = parent.create_child_workflow_execution_state(Graph(), frame)
    child_b = parent.create_child_workflow_execution_state(Graph(), frame)

    parent.begin_waiting_on_workflow_call(frame)
    parent.attach_waiting_workflow_call_child_sessions([child_a, child_b])

    is_complete, aggregated_values = parent.record_waiting_workflow_call_child_completion(
        101, {"sum": 3, "images": "image-a"}
    )
    assert is_complete is False
    assert aggregated_values == {"sum": [3], "images": ["image-a"]}

    is_complete, aggregated_values = parent.record_waiting_workflow_call_child_completion(
        102, {"sum": 7, "images": "image-b"}
    )
    assert is_complete is True
    assert aggregated_values == {"sum": [3, 7], "images": ["image-a", "image-b"]}
    assert parent.waiting_workflow_call_execution is not None
    assert parent.waiting_workflow_call_execution.completed_child_item_ids == [101, 102]


def test_graph_record_waiting_workflow_call_child_completion_preserves_enqueue_order():
    parent = GraphExecutionState(graph=Graph())
    parent.execution_graph.add_node(AddInvocation(id="prepared-parent", a=1, b=2))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"

    frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")
    child_a = parent.create_child_workflow_execution_state(Graph(), frame)
    child_b = parent.create_child_workflow_execution_state(Graph(), frame)
    parent.begin_waiting_on_workflow_call(frame)
    parent.attach_waiting_workflow_call_child_sessions([child_a, child_b])
    parent.set_waiting_workflow_call_child_item_ids([101, 102])

    parent.record_waiting_workflow_call_child_completion(102, {"sum": 7})
    is_complete, aggregated_values = parent.record_waiting_workflow_call_child_completion(101, {"sum": 3})

    assert is_complete is True
    assert aggregated_values == {"sum": [3, 7]}


def test_graph_end_waiting_on_workflow_call_records_lifecycle_history():
    parent = GraphExecutionState(graph=Graph())
    parent.execution_graph.add_node(PromptTestInvocation(id="prepared-parent", prompt="a"))
    parent.prepared_source_mapping["prepared-parent"] = "source-parent"
    frame = parent.build_workflow_call_frame(exec_node_id="prepared-parent", workflow_id="workflow-a")

    child = parent.create_child_workflow_execution_state(graph=Graph(), frame=frame)
    parent.begin_waiting_on_workflow_call(frame)
    parent.attach_waiting_workflow_call_child_session(child)
    parent.end_waiting_on_workflow_call(status="failed", error_message="child failed")

    assert parent.waiting_workflow_call is None
    assert parent.waiting_workflow_call_execution is None
    assert parent.waiting_workflow_call_child_session is None
    assert len(parent.workflow_call_history) == 1
    assert parent.workflow_call_history[0].status == "failed"
    assert parent.workflow_call_history[0].error_message == "child failed"
    assert parent.workflow_call_history[0].parent_session_id == parent.id
    assert parent.workflow_call_history[0].child_session_id == child.id


def test_graph_execution_state_serializes_recursive_workflow_call_stack():
    g = GraphExecutionState(
        graph=Graph(),
        workflow_call_stack=[
            WorkflowCallFrame(
                prepared_call_node_id="prepared-a",
                source_call_node_id="source-a",
                workflow_id="workflow-a",
                depth=1,
            ),
            WorkflowCallFrame(
                prepared_call_node_id="prepared-b",
                source_call_node_id="source-b",
                workflow_id="workflow-b",
                depth=2,
            ),
            WorkflowCallFrame(
                prepared_call_node_id="prepared-a-2",
                source_call_node_id="source-a-2",
                workflow_id="workflow-a",
                depth=3,
            ),
        ],
    )

    restored = GraphExecutionState.model_validate(g.model_dump(warnings=False))

    assert restored.workflow_call_stack == g.workflow_call_stack


# TODO: test completion with iterators/subgraphs


def test_graph_state_expands_iterator():
    graph = Graph()
    graph.add_node(RangeInvocation(id="0", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="1"))
    graph.add_node(MultiplyInvocation(id="2", b=10))
    graph.add_node(AddInvocation(id="3", b=1))
    graph.add_edge(create_edge("0", "collection", "1", "collection"))
    graph.add_edge(create_edge("1", "item", "2", "a"))
    graph.add_edge(create_edge("2", "value", "3", "a"))

    g = GraphExecutionState(graph=graph)
    while not g.is_complete():
        invoke_next(g)

    prepared_add_nodes = g.source_prepared_mapping["3"]
    results = {g.results[n].value for n in prepared_add_nodes}
    expected = {1, 11, 21}
    assert results == expected


def test_graph_state_materialization_does_not_revalidate_execution_edges(monkeypatch: pytest.MonkeyPatch):
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))

    validate_edge_calls = 0
    original_validate_edge = Graph._validate_edge

    def track_validate_edge(self: Graph, edge):
        nonlocal validate_edge_calls
        validate_edge_calls += 1
        return original_validate_edge(self, edge)

    monkeypatch.setattr(Graph, "_validate_edge", track_validate_edge)

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    assert validate_edge_calls == 0
    state.execution_graph.validate_self()


def test_iterator_and_collector_do_not_use_invocation_cache_by_default():
    assert IterateInvocation().use_cache is False
    assert CollectInvocation().use_cache is False


def test_materialized_control_nodes_disable_invocation_cache():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate", use_cache=True))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect", use_cache=True))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)

    execute_all_nodes(state)

    for source_node_id in ("iterate", "collect"):
        for prepared_node_id in state.source_prepared_mapping[source_node_id]:
            assert state.execution_graph.get_node(prepared_node_id).use_cache is False


def test_iterator_and_collector_event_invocations_omit_collections():
    iterator = IterateInvocation(collection=[1, 2, 3], index=1)
    collector = CollectInvocation(collection=[1, 2, 3])

    iterator_event_invocation = iterator.get_event_invocation()
    collector_event_invocation = collector.get_event_invocation()

    assert iterator_event_invocation is not iterator
    assert iterator_event_invocation.collection == []
    assert iterator_event_invocation.index == iterator.index
    assert iterator.collection == [1, 2, 3]

    assert collector_event_invocation is not collector
    assert collector_event_invocation.collection == []
    assert collector.collection == [1, 2, 3]


def test_invocation_event_service_uses_compact_control_node_representation():
    iterator = IterateInvocation(collection=[1, 2, 3], index=1)
    queue_item = Mock(
        queue_id="default",
        item_id=1,
        batch_id="batch",
        origin="workflows",
        destination=None,
        user_id="system",
        session_id="session",
        session=Mock(prepared_source_mapping={iterator.id: "source"}),
    )
    events = TestEventService()

    events.emit_invocation_started(queue_item, iterator)

    assert len(events.events) == 1
    event = events.events[0]
    assert isinstance(event.invocation, IterateInvocation)
    assert event.invocation.collection == []
    assert iterator.collection == [1, 2, 3]


def test_if_scheduler_does_not_resolve_iteration_path_when_graph_has_no_if(monkeypatch: pytest.MonkeyPatch):
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source", prompt="test"))
    state = GraphExecutionState(graph=graph)
    prepared_node = PromptTestInvocation(id="prepared", prompt="test")
    state.execution_graph.add_node(prepared_node)
    state._register_prepared_exec_node(prepared_node.id, "source")

    def fail_get_iteration_path(self: GraphExecutionState, exec_node_id: str):
        raise AssertionError(f"Unexpected iteration path lookup for {exec_node_id}")

    monkeypatch.setattr(GraphExecutionState, "_get_iteration_path", fail_get_iteration_path)

    assert state._if_scheduler().is_deferred_by_unresolved_if(prepared_node.id) is False


def test_materializer_caches_iteration_paths_for_single_parent_chain(monkeypatch: pytest.MonkeyPatch):
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)

    def fail_build_iteration_path(exec_node_id: str, source_node_id: str):
        raise AssertionError(f"Unexpected graph traversal for {exec_node_id} from {source_node_id}")

    monkeypatch.setattr(state._runtime(), "_build_iteration_path", fail_build_iteration_path)

    execute_all_nodes(state)


def test_materializer_reuses_matching_parent_iteration_paths():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=1, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="left"))
    graph.add_node(AddInvocation(id="right"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "left", "a"))
    graph.add_edge(create_edge("iterate", "item", "right", "a"))
    state = GraphExecutionState(graph=graph)
    registry = state._prepared_registry()
    registry.register("left-prepared", "left")
    registry.register("right-prepared", "right")
    registry.set_iteration_path("left-prepared", (2,))
    registry.set_iteration_path("right-prepared", (2,))

    iteration_path = state._materializer()._get_known_iteration_path(
        -1,
        [("left", "left-prepared"), ("right", "right-prepared")],
    )

    assert iteration_path == (2,)


def test_materializer_does_not_merge_matching_paths_from_independent_iterators():
    graph = Graph()
    graph.add_node(RangeInvocation(id="left_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="left_iterate"))
    graph.add_node(RangeInvocation(id="right_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="right_iterate"))
    graph.add_node(AddInvocation(id="add"))
    graph.add_edge(create_edge("left_range", "collection", "left_iterate", "collection"))
    graph.add_edge(create_edge("right_range", "collection", "right_iterate", "collection"))
    graph.add_edge(create_edge("left_iterate", "item", "add", "a"))
    graph.add_edge(create_edge("right_iterate", "item", "add", "b"))
    state = GraphExecutionState(graph=graph)

    execute_all_nodes(state)

    iteration_paths = {state._get_iteration_path(prepared_id) for prepared_id in state.source_prepared_mapping["add"]}
    assert iteration_paths == {(0, 0), (0, 1), (1, 0), (1, 1)}


def test_materializer_indexes_prepared_nodes_once_per_source(monkeypatch: pytest.MonkeyPatch):
    item_count = 24
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=item_count, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)
    materializer_type = type(state._materializer())
    original_get_prepared_nodes = materializer_type._get_prepared_nodes_for_source
    calls_by_source: defaultdict[str, int] = defaultdict(int)

    def track_get_prepared_nodes(self, source_node_id: str):
        calls_by_source[source_node_id] += 1
        return original_get_prepared_nodes(self, source_node_id)

    monkeypatch.setattr(materializer_type, "_get_prepared_nodes_for_source", track_get_prepared_nodes)

    execute_all_nodes(state)

    assert calls_by_source["iterate"] <= 2
    assert calls_by_source["add"] <= 2


def test_materializer_uses_iteration_path_index_for_loop_body(monkeypatch: pytest.MonkeyPatch):
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=8, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="first_add", b=1))
    graph.add_node(AddInvocation(id="second_add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "first_add", "a"))
    graph.add_edge(create_edge("first_add", "value", "second_add", "a"))
    graph.add_edge(create_edge("second_add", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)
    materializer_type = type(state._materializer())

    def fail_matches_parent_iterators(*args, **kwargs):
        raise AssertionError("Known iteration paths should not require execution-graph path searches")

    monkeypatch.setattr(materializer_type, "_matches_parent_iterators", fail_matches_parent_iterators)

    execute_all_nodes(state)

    prepared_collect_id = next(iter(state.source_prepared_mapping["collect"]))
    assert state.results[prepared_collect_id].collection == list(range(2, 10))


def test_materializer_yields_parent_iteration_mappings_lazily():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    state = GraphExecutionState(graph=graph)

    invoke_next(state)
    iterate_node = state.next()
    assert isinstance(iterate_node, IterateInvocation)

    mappings = state._materializer()._get_parent_iteration_mappings("add", graph.nx_graph_flat())

    assert isinstance(mappings, Iterator)
    assert len(next(mappings)) == 1


def test_graph_caches_edge_adjacency_and_updates_it_incrementally():
    class CountingEdges(list):
        def __init__(self, edges):
            super().__init__(edges)
            self.iterations = 0

        def __iter__(self):
            self.iterations += 1
            return super().__iter__()

    graph = Graph()
    graph.add_node(PromptTestInvocation(id="source", prompt="test"))
    graph.add_node(PromptTestInvocation(id="first"))
    graph.add_node(PromptTestInvocation(id="second"))
    first_edge = create_edge("source", "prompt", "first", "prompt")
    second_edge = create_edge("source", "prompt", "second", "prompt")
    graph.add_edge(first_edge)
    counting_edges = CountingEdges(graph.edges)
    object.__setattr__(graph, "edges", counting_edges)
    graph._invalidate_edge_indexes()

    assert graph._get_input_edges("first") == [first_edge]
    assert graph._get_input_edges("first") == [first_edge]
    assert counting_edges.iterations == 1

    graph._extend_edges_unchecked([second_edge])
    assert graph._get_input_edges("second") == [second_edge]
    assert graph._get_output_edges("source") == [first_edge, second_edge]
    assert counting_edges.iterations == 1

    graph.delete_edge(first_edge)
    assert graph._get_input_edges("first") == []
    assert graph._get_output_edges("source") == [second_edge]
    assert counting_edges.iterations == 1


def test_ready_queue_does_not_scan_for_duplicate_nodes():
    class NoMembershipScanDeque(deque):
        def __contains__(self, value):
            raise AssertionError("Ready queue membership must use the scheduler index")

    state = GraphExecutionState(graph=Graph())
    prepared_node = PromptTestInvocation(id="prepared", prompt="test")
    state.execution_graph.add_node(prepared_node)
    state._register_prepared_exec_node(prepared_node.id, "source")
    state._prepared_registry().set_iteration_path(prepared_node.id, ())
    state.indegree[prepared_node.id] = 0
    class_name = state._type_key(prepared_node)
    state._ready_queues[class_name] = NoMembershipScanDeque()

    state._enqueue_if_ready(prepared_node.id)
    state._enqueue_if_ready(prepared_node.id)

    assert list(state._ready_queues[class_name]) == [prepared_node.id]


def test_iterator_reuses_collection_input_until_completed():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    state = GraphExecutionState(graph=graph)

    range_node, range_output = invoke_next(state)
    assert range_node is not None
    assert range_output is not None

    iterate_node = state.next()
    assert isinstance(iterate_node, IterateInvocation)
    assert iterate_node.collection is range_output.collection

    iterate_output = iterate_node.invoke(Mock(InvocationContext))
    state.complete(iterate_node.id, iterate_output)

    assert iterate_output.item == 0
    assert iterate_node.collection == []


def test_completed_collector_releases_input_collection_but_preserves_results():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=3, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))
    state = GraphExecutionState(graph=graph)

    execute_all_nodes(state)

    prepared_collect_id = next(iter(state.source_prepared_mapping["collect"]))
    prepared_collect = state.execution_graph.get_node(prepared_collect_id)
    assert isinstance(prepared_collect, CollectInvocation)
    assert prepared_collect.collection == []
    assert state.results[prepared_collect_id].collection == [1, 2, 3]
    assert {state.results[node_id].value for node_id in state.source_prepared_mapping["add"]} == {1, 2, 3}
    assert state.execution_graph._input_edges_by_node is None
    assert state.execution_graph._output_edges_by_node is None
    assert state._ready_node_ids == set()


def test_graph_state_collects():
    graph = Graph()
    test_prompts = ["Banana sushi", "Cat sushi"]
    graph.add_node(PromptCollectionTestInvocation(id="1", collection=list(test_prompts)))
    graph.add_node(IterateInvocation(id="2"))
    graph.add_node(PromptTestInvocation(id="3"))
    graph.add_node(CollectInvocation(id="4"))
    graph.add_edge(create_edge("1", "collection", "2", "collection"))
    graph.add_edge(create_edge("2", "item", "3", "prompt"))
    graph.add_edge(create_edge("3", "prompt", "4", "item"))

    g = GraphExecutionState(graph=graph)
    _ = invoke_next(g)
    _ = invoke_next(g)
    _ = invoke_next(g)
    _ = invoke_next(g)
    _ = invoke_next(g)
    n6 = invoke_next(g)

    assert isinstance(n6[0], CollectInvocation)

    assert sorted(g.results[n6[0].id].collection) == sorted(test_prompts)


def test_graph_state_empty_iterator_collects_and_completes():
    graph = Graph()
    graph.add_node(IntegerCollectionInvocation(id="collection", collection=[]))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(IntegerCollectionInvocation(id="consumer"))
    graph.add_edge(create_edge("collection", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "consumer", "collection"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    assert state.is_complete()
    prepared_collect_id = next(iter(state.source_prepared_mapping["collect"]))
    assert state.results[prepared_collect_id].collection == []
    prepared_consumer_id = next(iter(state.source_prepared_mapping["consumer"]))
    assert state.results[prepared_consumer_id].collection == []


def test_graph_state_multiple_empty_iterator_branches_complete():
    graph = Graph()
    for branch in ("first", "second"):
        graph.add_node(IntegerCollectionInvocation(id=f"{branch}_collection", collection=[]))
        graph.add_node(IterateInvocation(id=f"{branch}_iterate"))
        graph.add_node(AddInvocation(id=f"{branch}_add", b=1))
        graph.add_node(CollectInvocation(id=f"{branch}_collect"))
        graph.add_node(IntegerCollectionPassthroughTestInvocation(id=f"{branch}_consumer"))
        graph.add_edge(create_edge(f"{branch}_collection", "collection", f"{branch}_iterate", "collection"))
        graph.add_edge(create_edge(f"{branch}_iterate", "item", f"{branch}_add", "a"))
        graph.add_edge(create_edge(f"{branch}_add", "value", f"{branch}_collect", "item"))
        graph.add_edge(create_edge(f"{branch}_collect", "collection", f"{branch}_consumer", "collection"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    assert state.is_complete()
    assert state.next() is None
    assert state.next() is None
    for branch in ("first", "second"):
        prepared_consumer_id = next(iter(state.source_prepared_mapping[f"{branch}_consumer"]))
        assert state.results[prepared_consumer_id].collection == []


def test_graph_state_resumes_partially_executed_session_after_json_round_trip():
    graph = Graph()
    graph.add_node(RangeInvocation(id="c", start=1, stop=5, step=1))
    graph.add_node(IterateInvocation(id="iter"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))

    graph.add_edge(create_edge("c", "collection", "iter", "collection"))
    graph.add_edge(create_edge("iter", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))

    state = GraphExecutionState(graph=graph)

    for _ in range(4):
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)
    registry = resumed._prepared_registry()

    assert all(
        registry.get_iteration_path(exec_node_id) is not None for exec_node_id in resumed.prepared_source_mapping
    )

    executed_source_ids = execute_all_nodes(resumed)

    assert executed_source_ids
    assert "add" in executed_source_ids
    assert "collect" in resumed.source_prepared_mapping

    prepared_collect_id = next(iter(resumed.source_prepared_mapping["collect"]))
    assert resumed.results[prepared_collect_id].collection == [2, 3, 4, 5]


def test_graph_state_round_trip_reuses_persisted_iteration_paths(monkeypatch: pytest.MonkeyPatch):
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=24, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))
    graph.add_edge(create_edge("add", "value", "collect", "item"))

    state = GraphExecutionState(graph=graph)
    for _ in range(8):
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    runtime_type = type(state._runtime())

    def fail_build_iteration_path(self, exec_node_id: str, source_node_id: str):
        raise AssertionError(f"Unexpected graph traversal for {exec_node_id} from {source_node_id}")

    monkeypatch.setattr(runtime_type, "_build_iteration_path", fail_build_iteration_path)

    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)

    assert all(
        resumed._get_iteration_path(exec_node_id) is not None for exec_node_id in resumed.prepared_source_mapping
    )


def test_graph_state_round_trip_rebuilds_iteration_paths_for_legacy_session():
    graph = Graph()
    graph.add_node(RangeInvocation(id="range", start=0, stop=4, step=1))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(AddInvocation(id="add", b=1))
    graph.add_edge(create_edge("range", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "add", "a"))

    state = GraphExecutionState(graph=graph)
    for _ in range(3):
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    legacy_payload = state.model_dump(mode="json", warnings=False, exclude_none=True)
    legacy_payload.pop("prepared_iteration_paths")

    resumed = TypeAdapter(GraphExecutionState).validate_python(legacy_payload, strict=False)

    assert all(
        resumed._get_iteration_path(exec_node_id) is not None for exec_node_id in resumed.prepared_source_mapping
    )
    assert execute_all_nodes(resumed)


def test_if_graph_state_resumes_resolved_branch_after_json_round_trip():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(PromptTestInvocation(id="false_value", prompt="false branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("false_value", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    state = GraphExecutionState(graph=graph)

    for _ in range(2):
        invocation, output = invoke_next(state)
        assert invocation is not None
        assert output is not None

    raw = state.model_dump_json(warnings=False, exclude_none=True)
    resumed = TypeAdapter(GraphExecutionState).validate_json(raw, strict=False)

    executed_source_ids = execute_all_nodes(resumed)

    prepared_selected_output_id = next(iter(resumed.source_prepared_mapping["selected_output"]))
    assert resumed.results[prepared_selected_output_id].prompt == "true branch"
    assert set(executed_source_ids) == {"if", "selected_output"}
    assert "false_value" not in executed_source_ids


def test_graph_state_prepares_eagerly():
    """Tests that all prepareable nodes are prepared"""
    graph = Graph()

    test_prompts = ["Banana sushi", "Cat sushi"]
    graph.add_node(PromptCollectionTestInvocation(id="prompt_collection", collection=list(test_prompts)))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(PromptTestInvocation(id="prompt_iterated"))
    graph.add_edge(create_edge("prompt_collection", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "prompt_iterated", "prompt"))

    # separated, fully-preparable chain of nodes
    graph.add_node(PromptTestInvocation(id="prompt_chain_1", prompt="Dinosaur sushi"))
    graph.add_node(PromptTestInvocation(id="prompt_chain_2"))
    graph.add_node(PromptTestInvocation(id="prompt_chain_3"))
    graph.add_edge(create_edge("prompt_chain_1", "prompt", "prompt_chain_2", "prompt"))
    graph.add_edge(create_edge("prompt_chain_2", "prompt", "prompt_chain_3", "prompt"))

    g = GraphExecutionState(graph=graph)
    g.next()

    assert "prompt_collection" in g.source_prepared_mapping
    assert "prompt_chain_1" in g.source_prepared_mapping
    assert "prompt_chain_2" in g.source_prepared_mapping
    assert "prompt_chain_3" in g.source_prepared_mapping
    assert "iterate" not in g.source_prepared_mapping
    assert "prompt_iterated" not in g.source_prepared_mapping


def test_graph_executes_depth_first():
    """Tests that the graph executes depth-first, executing a branch as far as possible before moving to the next branch"""

    def assert_topo_order_and_all_executed(state: GraphExecutionState, order: list[str]):
        """
        Validates:
          1) Every materialized exec node executed exactly once.
          2) Execution order respects all exec-graph dependencies (u→v ⇒ u before v).
        """
        # order must be EXEC node ids in run order
        exec_nodes = set(state.execution_graph.nodes.keys())

        # 1) coverage: all exec nodes ran, and no duplicates
        pos = {nid: i for i, nid in enumerate(order)}
        assert set(pos.keys()) == exec_nodes, (
            f"Executed {len(pos)} of {len(exec_nodes)} nodes. Missing: {sorted(exec_nodes - set(pos))[:10]}"
        )
        assert len(pos) == len(order), "Duplicate execution detected"

        # 2) topo order: parents before children
        for e in state.execution_graph.edges:
            u = e.source.node_id
            v = e.destination.node_id
            assert pos[u] < pos[v], f"child {v} ran before parent {u}"

    graph = Graph()

    test_prompts = ["Banana sushi", "Cat sushi"]
    graph.add_node(PromptCollectionTestInvocation(id="prompt_collection", collection=list(test_prompts)))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(PromptTestInvocation(id="prompt_iterated"))
    graph.add_node(PromptTestInvocation(id="prompt_successor"))
    graph.add_edge(create_edge("prompt_collection", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "prompt_iterated", "prompt"))
    graph.add_edge(create_edge("prompt_iterated", "prompt", "prompt_successor", "prompt"))

    g = GraphExecutionState(graph=graph)
    order: list[str] = []

    while True:
        n = g.next()
        if n is None:
            break
        o = n.invoke(Mock(InvocationContext))
        g.complete(n.id, o)
        order.append(n.id)

    assert_topo_order_and_all_executed(g, order)


def test_graph_scheduler_drains_active_class_before_switching():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="prompt_a", prompt="a"))
    graph.add_node(PromptTestInvocation(id="prompt_b", prompt="b"))
    graph.add_node(TextToImageTestInvocation(id="image"))

    g = GraphExecutionState(graph=graph)
    g.set_ready_order([PromptTestInvocation, TextToImageTestInvocation])

    first = invoke_next(g)[0]
    second = invoke_next(g)[0]
    third = invoke_next(g)[0]

    assert first is not None
    assert g.prepared_source_mapping[first.id] == "prompt_a"
    assert g.prepared_source_mapping[second.id] == "prompt_b"
    assert g.prepared_source_mapping[third.id] == "image"


def test_graph_scheduler_skips_stale_ready_entries():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="prompt_a", prompt="a"))
    graph.add_node(PromptTestInvocation(id="prompt_b", prompt="b"))

    g = GraphExecutionState(graph=graph)
    g.set_ready_order([PromptTestInvocation])

    first = invoke_next(g)[0]
    assert first is not None

    prompt_queue = g._queue_for(PromptTestInvocation.__name__)
    prompt_queue.appendleft(first.id)

    second = g.next()

    assert second is not None
    assert second.id != first.id
    assert g.prepared_source_mapping[second.id] == "prompt_b"


def test_graph_scheduler_falls_back_to_non_priority_ready_classes():
    graph = Graph()
    graph.add_node(TextToImageTestInvocation(id="image"))

    g = GraphExecutionState(graph=graph)
    g.set_ready_order([PromptTestInvocation])

    next_node = g.next()

    assert next_node is not None
    assert g.prepared_source_mapping[next_node.id] == "image"


# Because this tests deterministic ordering, we run it multiple times
@pytest.mark.parametrize("execution_number", range(5))
def test_graph_iterate_execution_order(execution_number: int):
    """Tests that iterate nodes execution is ordered by the order of the collection"""

    graph = Graph()

    test_prompts = ["Banana sushi", "Cat sushi", "Strawberry Sushi", "Dinosaur Sushi"]
    graph.add_node(PromptCollectionTestInvocation(id="prompt_collection", collection=list(test_prompts)))
    graph.add_node(IterateInvocation(id="iterate"))
    graph.add_node(PromptTestInvocation(id="prompt_iterated"))
    graph.add_edge(create_edge("prompt_collection", "collection", "iterate", "collection"))
    graph.add_edge(create_edge("iterate", "item", "prompt_iterated", "prompt"))

    g = GraphExecutionState(graph=graph)
    _ = invoke_next(g)
    _ = invoke_next(g)
    assert _[1].item == "Banana sushi"
    _ = invoke_next(g)
    assert _[1].item == "Cat sushi"
    _ = invoke_next(g)
    assert _[1].item == "Strawberry Sushi"
    _ = invoke_next(g)
    assert _[1].item == "Dinosaur Sushi"
    _ = invoke_next(g)


# Because this tests deterministic ordering, we run it multiple times
@pytest.mark.parametrize("execution_number", range(5))
def test_graph_nested_iterate_execution_order(execution_number: int):
    """
    Validates best-effort in-order execution for nodes expanded under nested iterators.
    Expected lexicographic order by (outer_index, inner_index), subject to readiness.
    """
    graph = Graph()

    # Outer iterator: [0, 1]
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))

    # Inner iterator is derived from the outer item:
    # start = outer_item * 10
    # stop  = start + 2  => yields 2 items per outer item
    graph.add_node(MultiplyInvocation(id="mul10", b=10))
    graph.add_node(AddInvocation(id="stop_plus2", b=2))
    graph.add_node(RangeInvocation(id="inner_range", start=0, stop=1, step=1))
    graph.add_node(IterateInvocation(id="inner_iter"))

    # Observe inner items (they encode outer via start=outer*10)
    graph.add_node(AddInvocation(id="sum", b=0))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "mul10", "a"))
    graph.add_edge(create_edge("mul10", "value", "stop_plus2", "a"))
    graph.add_edge(create_edge("mul10", "value", "inner_range", "start"))
    graph.add_edge(create_edge("stop_plus2", "value", "inner_range", "stop"))
    graph.add_edge(create_edge("inner_range", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "sum", "a"))

    g = GraphExecutionState(graph=graph)
    sum_values: list[int] = []

    while True:
        n, o = invoke_next(g)
        if n is None:
            break
        if g.prepared_source_mapping[n.id] == "sum":
            sum_values.append(o.value)

    assert sum_values == [0, 1, 10, 11]


def test_graph_collector_nested_under_outer_iterator_collects_only_current_outer_iteration_items():
    graph = Graph()

    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(IntegerCollectionPassthroughTestInvocation(id="per_outer_consumer"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "per_outer_consumer", "collection"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    prepared_consumer_ids = g.source_prepared_mapping["per_outer_consumer"]
    consumer_collections = sorted(g.results[node_id].collection for node_id in prepared_consumer_ids)

    assert consumer_collections == [[0, 1], [10, 11]]


@pytest.mark.parametrize(
    ("always_empty", "expected_collection"),
    [(True, [[], []]), (False, [[], [1]])],
)
def test_graph_collector_nested_under_outer_iterator_preserves_empty_groups(
    always_empty: bool, expected_collection: list[list[int]]
):
    graph = Graph()
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(MaybeEmptyIntegerCollectionTestInvocation(id="inner_collection", always_empty=always_empty))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="inner_collect"))
    graph.add_node(IntegerCollectionPassthroughTestInvocation(id="per_outer_consumer"))
    graph.add_node(CollectInvocation(id="outer_collect"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "inner_collect", "item"))
    graph.add_edge(create_edge("inner_collect", "collection", "per_outer_consumer", "collection"))
    graph.add_edge(create_edge("per_outer_consumer", "collection", "outer_collect", "item"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    prepared_inner_collect_ids = state.source_prepared_mapping["inner_collect"]
    assert sorted(state._get_iteration_path(node_id) for node_id in prepared_inner_collect_ids) == [(0,), (1,)]
    prepared_outer_collect_id = next(iter(state.source_prepared_mapping["outer_collect"]))
    assert state.results[prepared_outer_collect_id].collection == expected_collection
    assert state.is_complete()


def test_graph_consumer_with_direct_iterator_and_empty_collector_preserves_outer_iterations():
    graph = Graph()
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(MaybeEmptyIntegerCollectionTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="inner_collect"))
    graph.add_node(IntegerAndCollectionTestInvocation(id="join"))
    graph.add_node(CollectInvocation(id="outer_collect"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "inner_collect", "item"))
    graph.add_edge(create_edge("inner_collect", "collection", "join", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "join", "value"))
    graph.add_edge(create_edge("join", "collection", "outer_collect", "item"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    join_ids = state.source_prepared_mapping["join"]
    assert sorted(state._get_iteration_path(node_id) for node_id in join_ids) == [(0,), (1,)]
    assert sorted(state.results[node_id].collection for node_id in join_ids) == [[0], [1, 1]]
    outer_collect_id = next(iter(state.source_prepared_mapping["outer_collect"]))
    assert state.results[outer_collect_id].collection == [[0], [1, 1]]


@pytest.mark.parametrize(
    ("always_empty", "expected"),
    [(True, [[], []]), (False, [[0, 1], [10, 11]]), (None, [[], [1]])],
)
def test_graph_chained_collectors_preserve_outer_iteration_scope(always_empty: bool | None, expected: list[list[int]]):
    graph = Graph()
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    if always_empty is not False:
        graph.add_node(
            MaybeEmptyIntegerCollectionTestInvocation(id="inner_collection", always_empty=always_empty is True)
        )
    else:
        graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect_a"))
    graph.add_node(IterateInvocation(id="downstream_iter"))
    graph.add_node(AddInvocation(id="downstream_body", b=0))
    graph.add_node(CollectInvocation(id="collect_b"))
    graph.add_node(IntegerCollectionPassthroughTestInvocation(id="per_outer"))
    graph.add_node(CollectInvocation(id="outer_collect"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect_a", "item"))
    graph.add_edge(create_edge("collect_a", "collection", "downstream_iter", "collection"))
    graph.add_edge(create_edge("downstream_iter", "item", "downstream_body", "a"))
    graph.add_edge(create_edge("downstream_body", "value", "collect_b", "item"))
    graph.add_edge(create_edge("collect_b", "collection", "per_outer", "collection"))
    graph.add_edge(create_edge("per_outer", "collection", "outer_collect", "item"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    collect_b_ids = state.source_prepared_mapping["collect_b"]
    assert sorted(state._get_iteration_path(node_id) for node_id in collect_b_ids) == [(0,), (1,)]
    assert sorted(state.results[node_id].collection for node_id in collect_b_ids) == expected
    outer_collect_id = next(iter(state.source_prepared_mapping["outer_collect"]))
    assert state.results[outer_collect_id].collection == expected


def test_graph_chained_collectors_preserve_ragged_empty_scope():
    graph = Graph()
    graph.add_node(RangeInvocation(id="source", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(EmptyOrTwoIntegerCollectionTestInvocation(id="middle_map"))
    graph.add_node(IterateInvocation(id="middle_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_map"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="body", b=0))
    graph.add_node(CollectInvocation(id="collect_a"))
    graph.add_node(IntegerCollectionPassthroughTestInvocation(id="per_x"))
    graph.add_node(CollectInvocation(id="top_collect"))

    graph.add_edge(create_edge("source", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "middle_map", "value"))
    graph.add_edge(create_edge("middle_map", "collection", "middle_iter", "collection"))
    graph.add_edge(create_edge("middle_iter", "item", "inner_map", "value"))
    graph.add_edge(create_edge("inner_map", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "body", "a"))
    graph.add_edge(create_edge("body", "value", "collect_a", "item"))
    graph.add_edge(create_edge("collect_a", "collection", "per_x", "collection"))
    graph.add_edge(create_edge("per_x", "collection", "top_collect", "item"))

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    top_collect_ids = state.source_prepared_mapping["top_collect"]
    top_collect_results = {
        state._get_iteration_path(node_id): state.results[node_id].collection for node_id in top_collect_ids
    }
    assert top_collect_results == {(0,): [[]], (1,): [[0, 1], [10, 11]]}


@pytest.mark.parametrize(("levels", "branch_count"), [(3, 2), (4, 2), (5, 1), (6, 1), (7, 1)])
def test_graph_chained_collectors_preserve_all_iteration_scopes(levels: int, branch_count: int):
    graph = Graph()
    graph.add_node(RangeInvocation(id="source", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="iter_0"))
    for level in range(1, levels):
        graph.add_node(IntegerCollectionWithBranchingTestInvocation(id=f"map_{level}", branch_count=branch_count))
        graph.add_node(IterateInvocation(id=f"iter_{level}"))
    graph.add_node(AddInvocation(id="body", b=0))

    graph.add_edge(create_edge("source", "collection", "iter_0", "collection"))
    for level in range(1, levels):
        graph.add_edge(create_edge(f"iter_{level - 1}", "item", f"map_{level}", "value"))
        graph.add_edge(create_edge(f"map_{level}", "collection", f"iter_{level}", "collection"))
    graph.add_edge(create_edge(f"iter_{levels - 1}", "item", "body", "a"))

    previous_node_id = "body"
    previous_field = "value"
    for level in reversed(range(levels)):
        collect_id = f"collect_{level}"
        graph.add_node(CollectInvocation(id=collect_id))
        graph.add_edge(create_edge(previous_node_id, previous_field, collect_id, "item"))
        previous_node_id = collect_id
        previous_field = "collection"

    state = GraphExecutionState(graph=graph)
    execute_all_nodes(state)

    def paths(depth: int) -> list[tuple[int, ...]]:
        if depth == 0:
            return [()]
        branch_level = depth - 1
        branch_options = range(2) if branch_level == 0 else range(branch_count)
        return [prefix + (branch,) for prefix in paths(depth - 1) for branch in branch_options]

    def expected_collection(level: int, prefix: tuple[int, ...]):
        branch_options = range(2) if level == 0 else range(branch_count)
        if level == levels - 1:
            return [int("".join(map(str, prefix + (branch,)))) for branch in branch_options]
        return [expected_collection(level + 1, prefix + (branch,)) for branch in branch_options]

    for level in range(levels):
        prepared_ids = state.source_prepared_mapping[f"collect_{level}"]
        actual = {state._get_iteration_path(node_id): state.results[node_id].collection for node_id in prepared_ids}
        expected = {prefix: expected_collection(level, prefix) for prefix in paths(level)}
        assert actual == expected


def test_graph_collector_reuses_outer_collection_input_for_each_nested_iterator_group():
    graph = Graph()

    graph.add_node(RangeInvocation(id="base_collection", start=100, stop=101, step=1))
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect"))

    graph.add_edge(create_edge("base_collection", "collection", "collect", "collection"))
    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect", "item"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    prepared_collect_ids = g.source_prepared_mapping["collect"]
    collect_results = sorted(g.results[node_id].collection for node_id in prepared_collect_ids)

    assert collect_results == [[100, 0, 1], [100, 10, 11]]


def test_graph_collector_nested_under_three_iterators_preserves_outer_iteration_paths():
    graph = Graph()

    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="middle_collection"))
    graph.add_node(IterateInvocation(id="middle_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(IntegerCollectionPassthroughTestInvocation(id="per_middle_consumer"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "middle_collection", "value"))
    graph.add_edge(create_edge("middle_collection", "collection", "middle_iter", "collection"))
    graph.add_edge(create_edge("middle_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "per_middle_consumer", "collection"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    prepared_consumer_ids = g.source_prepared_mapping["per_middle_consumer"]
    consumer_collections = sorted(g.results[node_id].collection for node_id in prepared_consumer_ids)

    assert consumer_collections == [[0, 1], [10, 11], [100, 101], [110, 111]]


def test_graph_collector_with_mixed_depth_item_inputs_keeps_outer_iterations_separate():
    graph = Graph()

    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(AddInvocation(id="outer_item", b=100))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "outer_item", "a"))
    graph.add_edge(create_edge("outer_item", "value", "collect", "item"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect", "item"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    collect_results = sorted(g.results[node_id].collection for node_id in g.source_prepared_mapping["collect"])

    assert collect_results == [[100, 0, 1], [101, 10, 11]]


def test_graph_consumer_matches_collector_parents_at_different_iteration_depths():
    graph = Graph()

    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="middle_collection"))
    graph.add_node(IterateInvocation(id="middle_iter"))
    graph.add_node(AddInvocation(id="shallow_item", b=0))
    graph.add_node(CollectInvocation(id="shallow_collect"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="deep_item", b=0))
    graph.add_node(CollectInvocation(id="deep_collect"))
    graph.add_node(TwoIntegerCollectionsTestInvocation(id="consumer"))

    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "middle_collection", "value"))
    graph.add_edge(create_edge("middle_collection", "collection", "middle_iter", "collection"))
    graph.add_edge(create_edge("middle_iter", "item", "shallow_item", "a"))
    graph.add_edge(create_edge("shallow_item", "value", "shallow_collect", "item"))
    graph.add_edge(create_edge("middle_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "deep_item", "a"))
    graph.add_edge(create_edge("deep_item", "value", "deep_collect", "item"))
    graph.add_edge(create_edge("shallow_collect", "collection", "consumer", "first"))
    graph.add_edge(create_edge("deep_collect", "collection", "consumer", "second"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    consumer_results = sorted(g.results[node_id].collection for node_id in g.source_prepared_mapping["consumer"])

    assert consumer_results == [
        [0, 1, 0, 1],
        [0, 1, 10, 11],
        [10, 11, 100, 101],
        [10, 11, 110, 111],
    ]


def test_graph_consumer_reuses_global_parent_for_each_nested_collector_iteration():
    graph = Graph()

    graph.add_node(RangeInvocation(id="global_collection", start=99, stop=100, step=1))
    graph.add_node(RangeInvocation(id="outer_range", start=0, stop=2, step=1))
    graph.add_node(IterateInvocation(id="outer_iter"))
    graph.add_node(IntegerCollectionFromItemTestInvocation(id="inner_collection"))
    graph.add_node(IterateInvocation(id="inner_iter"))
    graph.add_node(AddInvocation(id="inner_item", b=0))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_node(TwoIntegerCollectionsTestInvocation(id="consumer"))

    graph.add_edge(create_edge("global_collection", "collection", "consumer", "second"))
    graph.add_edge(create_edge("outer_range", "collection", "outer_iter", "collection"))
    graph.add_edge(create_edge("outer_iter", "item", "inner_collection", "value"))
    graph.add_edge(create_edge("inner_collection", "collection", "inner_iter", "collection"))
    graph.add_edge(create_edge("inner_iter", "item", "inner_item", "a"))
    graph.add_edge(create_edge("inner_item", "value", "collect", "item"))
    graph.add_edge(create_edge("collect", "collection", "consumer", "first"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    consumer_results = sorted(g.results[node_id].collection for node_id in g.source_prepared_mapping["consumer"])

    assert consumer_results == [[0, 1, 99], [10, 11, 99]]


def test_graph_validate_self_iterator_without_collection_input_raises_invalid_edge_error():
    """Iterator nodes with no collection input should fail validation cleanly.

    This test exposes the bug where validation crashes with IndexError instead of raising InvalidEdgeError.
    """
    from invokeai.app.services.shared.graph import InvalidEdgeError

    graph = Graph()
    graph.add_node(IterateInvocation(id="iterate"))

    with pytest.raises(InvalidEdgeError):
        graph.validate_self()


def test_graph_validate_self_collector_without_item_inputs_raises_invalid_edge_error():
    """Collector nodes with no item inputs should fail validation cleanly.

    This test exposes the bug where validation can crash (e.g. StopIteration) instead of raising InvalidEdgeError.
    """
    from invokeai.app.services.shared.graph import InvalidEdgeError

    graph = Graph()
    graph.add_node(CollectInvocation(id="collect"))

    with pytest.raises(InvalidEdgeError):
        graph.validate_self()


def test_if_invocation_selects_true_input_value():
    invocation = IfInvocation(id="if", condition=True, true_input="true", false_input="false")

    output = invocation.invoke(Mock(InvocationContext))

    assert output.value == "true"


def test_if_invocation_outputs_none_when_selected_input_is_missing():
    invocation = IfInvocation(id="if", condition=False, true_input="true")

    output = invocation.invoke(Mock(InvocationContext))

    assert output.value is None


def test_if_invocation_output_allows_missing_value_on_deserialization():
    output = IfInvocationOutput.model_validate({"type": "if_output"})

    assert output.value is None


def test_if_invocation_output_connects_to_downstream_input():
    graph = Graph()
    graph.add_node(IfInvocation(id="if", condition=True, true_input="connected value", false_input="unused"))
    graph.add_node(PromptTestInvocation(id="prompt"))
    graph.add_edge(create_edge("if", "value", "prompt", "prompt"))

    g = GraphExecutionState(graph=graph)
    while not g.is_complete():
        invoke_next(g)

    prepared_prompt_nodes = g.source_prepared_mapping["prompt"]
    assert len(prepared_prompt_nodes) == 1
    prepared_prompt_node_id = next(iter(prepared_prompt_nodes))
    assert g.results[prepared_prompt_node_id].prompt == "connected value"


@pytest.mark.xfail(strict=True, reason="Legacy eager If-node execution should no longer occur")
def test_if_graph_current_behavior_executes_both_branches_and_shared_ancestors():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="shared", prompt="shared value"))
    graph.add_node(PromptTestInvocation(id="true_mid"))
    graph.add_node(PromptTestInvocation(id="true_leaf"))
    graph.add_node(PromptTestInvocation(id="false_mid"))
    graph.add_node(PromptTestInvocation(id="false_leaf"))
    graph.add_node(PromptTestInvocation(id="side_consumer"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("shared", "prompt", "true_mid", "prompt"))
    graph.add_edge(create_edge("true_mid", "prompt", "true_leaf", "prompt"))
    graph.add_edge(create_edge("true_leaf", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("shared", "prompt", "false_mid", "prompt"))
    graph.add_edge(create_edge("false_mid", "prompt", "false_leaf", "prompt"))
    graph.add_edge(create_edge("false_leaf", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("shared", "prompt", "side_consumer", "prompt"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    assert set(executed_source_ids) == {
        "condition",
        "shared",
        "true_mid",
        "true_leaf",
        "false_mid",
        "false_leaf",
        "side_consumer",
        "if",
        "selected_output",
    }
    assert executed_source_ids.count("false_mid") == 1
    assert executed_source_ids.count("false_leaf") == 1

    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].prompt == "shared value"


@pytest.mark.xfail(strict=True, reason="Legacy eager If-node execution should no longer occur")
def test_if_graph_current_behavior_executes_both_simple_branches():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(PromptTestInvocation(id="false_value", prompt="false branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("false_value", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    assert set(executed_source_ids) == {"condition", "true_value", "false_value", "if", "selected_output"}
    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].prompt == "true branch"


def test_if_graph_optimized_behavior_executes_only_selected_simple_branch():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(PromptTestInvocation(id="false_value", prompt="false branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("false_value", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    assert set(executed_source_ids) == {"condition", "true_value", "if", "selected_output"}
    assert "false_value" not in executed_source_ids


def test_if_graph_optimized_behavior_records_skipped_branch_in_execution_history():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(PromptTestInvocation(id="false_value", prompt="false branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("false_value", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    execute_all_nodes(g)

    assert set(g.executed_history) == {"condition", "true_value", "false_value", "if", "selected_output"}
    assert g.executed_history.count("false_value") == 1


def test_if_graph_optimized_behavior_skips_unselected_branch_but_keeps_shared_ancestors():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="shared", prompt="shared value"))
    graph.add_node(PromptTestInvocation(id="true_mid"))
    graph.add_node(PromptTestInvocation(id="true_leaf"))
    graph.add_node(PromptTestInvocation(id="false_mid"))
    graph.add_node(PromptTestInvocation(id="false_leaf"))
    graph.add_node(PromptTestInvocation(id="side_consumer"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("shared", "prompt", "true_mid", "prompt"))
    graph.add_edge(create_edge("true_mid", "prompt", "true_leaf", "prompt"))
    graph.add_edge(create_edge("true_leaf", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("shared", "prompt", "false_mid", "prompt"))
    graph.add_edge(create_edge("false_mid", "prompt", "false_leaf", "prompt"))
    graph.add_edge(create_edge("false_leaf", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("shared", "prompt", "side_consumer", "prompt"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    assert set(executed_source_ids) == {
        "condition",
        "shared",
        "true_mid",
        "true_leaf",
        "side_consumer",
        "if",
        "selected_output",
    }
    assert "false_mid" not in executed_source_ids
    assert "false_leaf" not in executed_source_ids


def test_if_graph_optimized_behavior_skips_distant_unselected_ancestors_only_when_exclusive():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=False))
    graph.add_node(PromptTestInvocation(id="shared_root", prompt="shared value"))
    graph.add_node(PromptTestInvocation(id="true_shared_mid"))
    graph.add_node(PromptTestInvocation(id="true_exclusive_leaf"))
    graph.add_node(PromptTestInvocation(id="false_mid"))
    graph.add_node(PromptTestInvocation(id="false_leaf"))
    graph.add_node(PromptTestInvocation(id="shared_observer"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("shared_root", "prompt", "true_shared_mid", "prompt"))
    graph.add_edge(create_edge("true_shared_mid", "prompt", "true_exclusive_leaf", "prompt"))
    graph.add_edge(create_edge("true_exclusive_leaf", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("shared_root", "prompt", "false_mid", "prompt"))
    graph.add_edge(create_edge("false_mid", "prompt", "false_leaf", "prompt"))
    graph.add_edge(create_edge("false_leaf", "prompt", "if", "false_input"))
    graph.add_edge(create_edge("true_shared_mid", "prompt", "shared_observer", "prompt"))
    graph.add_edge(create_edge("if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    assert set(executed_source_ids) == {
        "condition",
        "shared_root",
        "true_shared_mid",
        "false_mid",
        "false_leaf",
        "shared_observer",
        "if",
        "selected_output",
    }
    assert "true_exclusive_leaf" not in executed_source_ids


def test_if_graph_optimized_behavior_allows_selected_missing_branch_input():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=False))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(AnyTypeTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "value"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].value is None
    assert set(executed_source_ids) == {"condition", "if", "selected_output"}
    assert "true_value" not in executed_source_ids


def test_if_graph_optimized_behavior_does_not_cross_defer_independent_ifs():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition_a", value=True))
    graph.add_node(BooleanInvocation(id="condition_b", value=False))
    graph.add_node(PromptTestInvocation(id="true_a", prompt="true a"))
    graph.add_node(PromptTestInvocation(id="false_a", prompt="false a"))
    graph.add_node(PromptTestInvocation(id="true_b", prompt="true b"))
    graph.add_node(PromptTestInvocation(id="false_b", prompt="false b"))
    graph.add_node(IfInvocation(id="if_a"))
    graph.add_node(IfInvocation(id="if_b"))
    graph.add_node(CollectInvocation(id="collect"))

    graph.add_edge(create_edge("condition_a", "value", "if_a", "condition"))
    graph.add_edge(create_edge("true_a", "prompt", "if_a", "true_input"))
    graph.add_edge(create_edge("false_a", "prompt", "if_a", "false_input"))
    graph.add_edge(create_edge("condition_b", "value", "if_b", "condition"))
    graph.add_edge(create_edge("true_b", "prompt", "if_b", "true_input"))
    graph.add_edge(create_edge("false_b", "prompt", "if_b", "false_input"))
    graph.add_edge(create_edge("if_a", "value", "collect", "item"))
    graph.add_edge(create_edge("if_b", "value", "collect", "item"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_collect_id = next(iter(g.source_prepared_mapping["collect"]))
    assert sorted(g.results[prepared_collect_id].collection) == ["false b", "true a"]
    assert set(executed_source_ids) == {
        "condition_a",
        "condition_b",
        "true_a",
        "false_b",
        "if_a",
        "if_b",
        "collect",
    }
    assert "false_a" not in executed_source_ids
    assert "true_b" not in executed_source_ids


def test_if_graph_optimized_behavior_supports_nested_ifs():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="outer_condition", value=True))
    graph.add_node(BooleanInvocation(id="inner_condition", value=False))
    graph.add_node(PromptTestInvocation(id="outer_false", prompt="outer false"))
    graph.add_node(PromptTestInvocation(id="inner_true", prompt="inner true"))
    graph.add_node(PromptTestInvocation(id="inner_false", prompt="inner false"))
    graph.add_node(IfInvocation(id="inner_if"))
    graph.add_node(IfInvocation(id="outer_if"))
    graph.add_node(PromptTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("inner_condition", "value", "inner_if", "condition"))
    graph.add_edge(create_edge("inner_true", "prompt", "inner_if", "true_input"))
    graph.add_edge(create_edge("inner_false", "prompt", "inner_if", "false_input"))
    graph.add_edge(create_edge("outer_condition", "value", "outer_if", "condition"))
    graph.add_edge(create_edge("inner_if", "value", "outer_if", "true_input"))
    graph.add_edge(create_edge("outer_false", "prompt", "outer_if", "false_input"))
    graph.add_edge(create_edge("outer_if", "value", "selected_output", "prompt"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].prompt == "inner false"
    assert set(executed_source_ids) == {
        "outer_condition",
        "inner_condition",
        "inner_false",
        "inner_if",
        "outer_if",
        "selected_output",
    }
    assert "inner_true" not in executed_source_ids
    assert "outer_false" not in executed_source_ids


def test_if_graph_optimized_behavior_prunes_branches_per_iteration():
    graph = Graph()
    graph.add_node(BooleanCollectionInvocation(id="conditions", collection=[True, False, True]))
    graph.add_node(IterateInvocation(id="condition_iter"))
    graph.add_node(AnyTypeTestInvocation(id="true_branch"))
    graph.add_node(AnyTypeTestInvocation(id="false_branch"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(CollectInvocation(id="collect"))

    graph.add_edge(create_edge("conditions", "collection", "condition_iter", "collection"))
    graph.add_edge(create_edge("condition_iter", "item", "if", "condition"))
    graph.add_edge(create_edge("condition_iter", "item", "true_branch", "value"))
    graph.add_edge(create_edge("true_branch", "value", "if", "true_input"))
    graph.add_edge(create_edge("condition_iter", "item", "false_branch", "value"))
    graph.add_edge(create_edge("false_branch", "value", "if", "false_input"))
    graph.add_edge(create_edge("if", "value", "collect", "item"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_collect_id = next(iter(g.source_prepared_mapping["collect"]))
    assert g.results[prepared_collect_id].collection == [True, False, True]
    assert executed_source_ids.count("condition_iter") == 3
    assert executed_source_ids.count("true_branch") == 2
    assert executed_source_ids.count("false_branch") == 1
    assert executed_source_ids.count("if") == 3


def test_if_graph_optimized_behavior_keeps_shared_live_consumers_per_iteration():
    graph = Graph()
    graph.add_node(BooleanCollectionInvocation(id="conditions", collection=[True, False, False]))
    graph.add_node(IterateInvocation(id="condition_iter"))
    graph.add_node(AnyTypeTestInvocation(id="shared_branch"))
    graph.add_node(AnyTypeTestInvocation(id="true_leaf"))
    graph.add_node(AnyTypeTestInvocation(id="false_branch"))
    graph.add_node(AnyTypeTestInvocation(id="observer"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(CollectInvocation(id="selected_collect"))
    graph.add_node(CollectInvocation(id="observer_collect"))

    graph.add_edge(create_edge("conditions", "collection", "condition_iter", "collection"))
    graph.add_edge(create_edge("condition_iter", "item", "if", "condition"))
    graph.add_edge(create_edge("condition_iter", "item", "shared_branch", "value"))
    graph.add_edge(create_edge("shared_branch", "value", "true_leaf", "value"))
    graph.add_edge(create_edge("true_leaf", "value", "if", "true_input"))
    graph.add_edge(create_edge("condition_iter", "item", "false_branch", "value"))
    graph.add_edge(create_edge("false_branch", "value", "if", "false_input"))
    graph.add_edge(create_edge("shared_branch", "value", "observer", "value"))
    graph.add_edge(create_edge("if", "value", "selected_collect", "item"))
    graph.add_edge(create_edge("observer", "value", "observer_collect", "item"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_selected_collect_id = next(iter(g.source_prepared_mapping["selected_collect"]))
    assert g.results[prepared_selected_collect_id].collection == [True, False, False]
    prepared_observer_collect_id = next(iter(g.source_prepared_mapping["observer_collect"]))
    assert g.results[prepared_observer_collect_id].collection == [True, False, False]

    assert executed_source_ids.count("condition_iter") == 3
    assert executed_source_ids.count("shared_branch") == 3
    assert executed_source_ids.count("observer") == 3
    assert executed_source_ids.count("true_leaf") == 1
    assert executed_source_ids.count("false_branch") == 2


def test_if_graph_optimized_behavior_handles_selected_true_branch_with_shared_false_input_ancestor():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(AnyTypeTestInvocation(id="shared_item", value="shared"))
    graph.add_node(AnyTypeTestInvocation(id="true_item", value="true"))
    graph.add_node(CollectInvocation(id="shared_collect"))
    graph.add_node(CollectInvocation(id="true_collect"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(AnyTypeTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("shared_item", "value", "shared_collect", "item"))
    graph.add_edge(create_edge("shared_collect", "collection", "true_collect", "collection"))
    graph.add_edge(create_edge("true_item", "value", "true_collect", "item"))
    graph.add_edge(create_edge("shared_collect", "collection", "if", "false_input"))
    graph.add_edge(create_edge("true_collect", "collection", "if", "true_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "value"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].value == ["shared", "true"]
    assert set(executed_source_ids) == {
        "condition",
        "shared_item",
        "true_item",
        "shared_collect",
        "true_collect",
        "if",
        "selected_output",
    }


def test_if_graph_optimized_behavior_handles_selected_false_branch_with_shared_true_input_ancestor():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=False))
    graph.add_node(AnyTypeTestInvocation(id="shared_item", value="shared"))
    graph.add_node(AnyTypeTestInvocation(id="true_item", value="true"))
    graph.add_node(CollectInvocation(id="shared_collect"))
    graph.add_node(CollectInvocation(id="true_collect"))
    graph.add_node(IfInvocation(id="if"))
    graph.add_node(AnyTypeTestInvocation(id="selected_output"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("shared_item", "value", "shared_collect", "item"))
    graph.add_edge(create_edge("shared_collect", "collection", "true_collect", "collection"))
    graph.add_edge(create_edge("true_item", "value", "true_collect", "item"))
    graph.add_edge(create_edge("shared_collect", "collection", "if", "false_input"))
    graph.add_edge(create_edge("true_collect", "collection", "if", "true_input"))
    graph.add_edge(create_edge("if", "value", "selected_output", "value"))

    g = GraphExecutionState(graph=graph)
    executed_source_ids = execute_all_nodes(g)

    prepared_selected_output_id = next(iter(g.source_prepared_mapping["selected_output"]))
    assert g.results[prepared_selected_output_id].value == ["shared"]
    assert set(executed_source_ids) == {
        "condition",
        "shared_item",
        "shared_collect",
        "if",
        "selected_output",
    }
    assert "true_item" not in executed_source_ids
    assert "true_collect" not in executed_source_ids


def test_prepare_if_inputs_raises_when_selected_branch_source_has_no_result():
    graph = Graph()
    graph.add_node(BooleanInvocation(id="condition", value=True))
    graph.add_node(PromptTestInvocation(id="true_value", prompt="true branch"))
    graph.add_node(IfInvocation(id="if"))

    graph.add_edge(create_edge("condition", "value", "if", "condition"))
    graph.add_edge(create_edge("true_value", "prompt", "if", "true_input"))

    g = GraphExecutionState(graph=graph)

    condition_exec_id = g._create_execution_node("condition", [])[0]
    true_value_exec_id = g._create_execution_node("true_value", [])[0]
    if_exec_id = g._create_execution_node(
        "if",
        [("condition", condition_exec_id), ("true_value", true_value_exec_id)],
    )[0]

    g.executed.add(condition_exec_id)
    g.results[condition_exec_id] = BooleanOutput(value=True)
    g.executed.add(true_value_exec_id)
    g._resolved_if_exec_branches[if_exec_id] = "true_input"

    if_node = g.execution_graph.get_node(if_exec_id)
    with pytest.raises(RuntimeError) as exc_info:
        g._prepare_inputs(if_node)

    message = str(exc_info.value)
    assert if_exec_id in message
    assert true_value_exec_id in message
    assert "iteration_path=()" in message


def test_get_collect_iteration_mapping_groups_ignores_skipped_prepared_exec_nodes():
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="parent", value="value"))
    graph.add_node(CollectInvocation(id="collect"))
    graph.add_edge(create_edge("parent", "value", "collect", "item"))

    g = GraphExecutionState(graph=graph)

    skipped_exec_id = g._create_execution_node("parent", [])[0]
    active_exec_id = g._create_execution_node("parent", [])[0]
    g._set_prepared_exec_state(skipped_exec_id, "skipped")

    mappings = g._materializer()._get_collect_iteration_mapping_groups(graph._get_input_edges("collect"))

    assert mappings == [((), [("parent", active_exec_id)])]


def test_get_iteration_node_ignores_skipped_prepared_exec_nodes():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="value", prompt="branch value"))

    g = GraphExecutionState(graph=graph)

    skipped_exec_id = g._create_execution_node("value", [])[0]
    active_exec_id = g._create_execution_node("value", [])[0]
    g._set_prepared_exec_state(skipped_exec_id, "skipped")

    selected_exec_id = g._get_iteration_node("value", graph.nx_graph_flat(), g.execution_graph.nx_graph_flat(), [])

    assert selected_exec_id == active_exec_id


def test_get_iteration_node_returns_single_active_prepared_exec_node():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="value", prompt="branch value"))

    g = GraphExecutionState(graph=graph)

    active_exec_id = g._create_execution_node("value", [])[0]

    selected_exec_id = g._get_iteration_node("value", graph.nx_graph_flat(), g.execution_graph.nx_graph_flat(), [])

    assert selected_exec_id == active_exec_id


def test_get_iteration_node_returns_none_when_only_skipped_prepared_exec_nodes_exist():
    graph = Graph()
    graph.add_node(PromptTestInvocation(id="value", prompt="branch value"))

    g = GraphExecutionState(graph=graph)

    skipped_exec_id = g._create_execution_node("value", [])[0]
    g._set_prepared_exec_state(skipped_exec_id, "skipped")

    selected_exec_id = g._get_iteration_node("value", graph.nx_graph_flat(), g.execution_graph.nx_graph_flat(), [])

    assert selected_exec_id is None


def test_get_iteration_node_does_not_reuse_wrong_iterator_when_only_other_iteration_is_live():
    graph = Graph()
    graph.add_node(BooleanCollectionInvocation(id="conditions", collection=[True, False]))
    graph.add_node(IterateInvocation(id="condition_iter"))
    graph.add_node(AnyTypeTestInvocation(id="value"))

    graph.add_edge(create_edge("conditions", "collection", "condition_iter", "collection"))
    graph.add_edge(create_edge("condition_iter", "item", "value", "value"))

    g = GraphExecutionState(graph=graph)

    conditions_exec_id = g._create_execution_node("conditions", [])[0]
    g.executed.add(conditions_exec_id)
    g.results[conditions_exec_id] = BooleanCollectionOutput(collection=[True, False])

    iterator_exec_ids = g._create_execution_node("condition_iter", [("conditions", conditions_exec_id)])
    assert len(iterator_exec_ids) == 2
    iterator_exec_ids_by_index = {g.execution_graph.get_node(exec_id).index: exec_id for exec_id in iterator_exec_ids}
    first_iter_exec_id = iterator_exec_ids_by_index[0]
    second_iter_exec_id = iterator_exec_ids_by_index[1]

    value_exec_ids = []
    value_exec_ids.extend(g._create_execution_node("value", [("condition_iter", first_iter_exec_id)]))
    value_exec_ids.extend(g._create_execution_node("value", [("condition_iter", second_iter_exec_id)]))
    assert len(value_exec_ids) == 2

    for exec_id in value_exec_ids:
        if g._get_iteration_path(exec_id) == (1,):
            active_value_exec_id = exec_id
        else:
            skipped_value_exec_id = exec_id

    g._set_prepared_exec_state(skipped_value_exec_id, "skipped")

    selected_exec_id = g._get_iteration_node(
        "value", graph.nx_graph_flat(), g.execution_graph.nx_graph_flat(), [first_iter_exec_id]
    )

    assert selected_exec_id is None
    assert active_value_exec_id != skipped_value_exec_id


def test_mark_exec_node_skipped_does_not_hide_already_executed_results():
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="value", value="value"))

    g = GraphExecutionState(graph=graph)

    exec_id = g._create_execution_node("value", [])[0]
    g.results[exec_id] = AnyTypeTestInvocationOutput(value="value")
    g.executed.add(exec_id)
    g._set_prepared_exec_state(exec_id, "executed")

    g._if_scheduler().mark_exec_node_skipped(exec_id)

    assert g._get_prepared_exec_metadata(exec_id).state == "executed"
    assert g.results[exec_id].value == "value"


def test_mark_exec_node_skipped_is_idempotent_for_skipped_state():
    graph = Graph()
    graph.add_node(AnyTypeTestInvocation(id="value", value="value"))

    g = GraphExecutionState(graph=graph)

    exec_id = g._create_execution_node("value", [])[0]

    g._if_scheduler().mark_exec_node_skipped(exec_id)
    g._if_scheduler().mark_exec_node_skipped(exec_id)

    assert g._get_prepared_exec_metadata(exec_id).state == "skipped"
    assert g.executed_history.count("value") == 1


def test_are_connection_types_compatible_accepts_subclass_to_base():
    """A subclass output should be connectable to a base-class input.

    This test exposes the bug where non-Union targets reject valid subclass connections.
    """
    from invokeai.app.services.shared.graph import are_connection_types_compatible

    class Base:
        pass

    class Child(Base):
        pass

    assert are_connection_types_compatible(Child, Base) is True
