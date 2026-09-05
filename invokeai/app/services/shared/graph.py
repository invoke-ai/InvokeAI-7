# Copyright (c) 2022 Kyle Schouviller (https://github.com/kyle0654)

import copy
import itertools
import weakref
from collections import deque
from dataclasses import dataclass
from functools import wraps
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Concatenate,
    Deque,
    Iterable,
    Literal,
    Optional,
    ParamSpec,
    Type,
    TypeVar,
    Union,
    get_args,
    get_origin,
)

from pydantic import (
    BaseModel,
    ConfigDict,
    GetCoreSchemaHandler,
    GetJsonSchemaHandler,
    PrivateAttr,
    ValidationError,
    field_validator,
)
from pydantic.fields import Field
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import core_schema

# Importing * is bad karma but needed here for node detection
from invokeai.app.invocations import *  # noqa: F401 F403
from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    InvocationRegistry,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.call_saved_workflow import (
    CallSavedWorkflowInvocation,
    is_call_saved_workflow_dynamic_input,
)
from invokeai.app.invocations.fields import Input, InputField, OutputField, OutputScope, UIType
from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.invocations.loops import (
    LOOP_LINKAGE_FIELD,
    ForInvocation,
    ForInvocationOutput,
    ForReturnInvocation,
    ForReturnInvocationOutput,
    LoopState,
)
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.app.util.misc import uuid_string

if TYPE_CHECKING:
    import networkx as nx
else:

    class _LazyNetworkX:
        _module: Any | None = None

        def _load(self) -> Any:
            if self._module is None:
                import networkx

                self._module = networkx
                globals()["nx"] = networkx
            return self._module

        def __getattr__(self, name: str) -> Any:
            return getattr(self._load(), name)

    nx = _LazyNetworkX()


# in 3.10 this would be "from types import NoneType"
NoneType = type(None)

# Port name constants
ITEM_FIELD = "item"
COLLECTION_FIELD = "collection"


@dataclass(frozen=True)
class _SupportedNestedForBody:
    body_path_nodes: frozenset[str]
    outer_return_id: str
    inner_for_ids: tuple[str, ...]
    continuation_nodes: frozenset[str]


@dataclass(frozen=True)
class _SupportedNestedIterateBody:
    body_path_nodes: set[str]
    return_node_id: str
    iterate_node_id: str
    collect_node_id: str


class EdgeConnection(BaseModel):
    model_config = ConfigDict(frozen=True)

    node_id: str = Field(description="The id of the node for this edge connection")
    field: str = Field(description="The field for this connection")

    def __eq__(self, other):
        return (
            isinstance(other, self.__class__)
            and getattr(other, "node_id", None) == self.node_id
            and getattr(other, "field", None) == self.field
        )

    def __hash__(self):
        return hash(f"{self.node_id}.{self.field}")


class Edge(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: Literal["default", "loop_linkage"] = Field(
        default="default",
        description="The kind of relationship represented by this edge",
    )
    source: EdgeConnection = Field(description="The connection for the edge's from node and field")
    destination: EdgeConnection = Field(description="The connection for the edge's to node and field")

    def __str__(self):
        return f"{self.source.node_id}.{self.source.field} -> {self.destination.node_id}.{self.destination.field}"


PreparedExecState = Literal["pending", "ready", "executed", "skipped"]
WorkflowCallStatus = Literal["waiting_for_child", "running_child", "completed", "failed"]


class WorkflowCallFrame(BaseModel):
    """Represents one workflow-call frame in a nested call chain."""

    prepared_call_node_id: str = Field(description="The prepared exec node id for the call site.")
    source_call_node_id: str = Field(description="The source graph node id for the call site.")
    workflow_id: str = Field(description="The saved workflow being called.")
    depth: int = Field(description="The 1-based depth of this call frame.", ge=1)


class WorkflowCallExecution(BaseModel):
    """Tracks one parent/child workflow-call relationship and its lifecycle."""

    id: str = Field(description="The workflow-call execution id.", default_factory=uuid_string)
    parent_session_id: str = Field(description="The parent graph execution state id.")
    child_session_id: Optional[str] = Field(default=None, description="The child graph execution state id, if any.")
    prepared_call_node_id: str = Field(description="The prepared exec node id for the parent call site.")
    source_call_node_id: str = Field(description="The source graph node id for the parent call site.")
    workflow_id: str = Field(description="The saved workflow being called.")
    depth: int = Field(description="The 1-based depth of this call frame.", ge=1)
    status: WorkflowCallStatus = Field(description="The current workflow-call lifecycle state.")
    error_message: Optional[str] = Field(default=None, description="Failure reason, if the call failed.")
    child_session_ids: list[str] = Field(default_factory=list, description="All child graph execution state ids.")
    child_item_ids: list[int] = Field(default_factory=list, description="Child queue item ids in enqueue order.")
    expected_child_count: int = Field(default=1, ge=1, description="The number of child executions for this call.")
    completed_child_item_ids: list[int] = Field(
        default_factory=list,
        description="The child queue item ids whose workflow_return outputs have been aggregated.",
    )
    aggregated_values: dict[str, list[Any]] = Field(
        default_factory=dict,
        description="The aggregated workflow_return values accumulated from child executions.",
    )
    child_outputs: dict[int, dict[str, Any]] = Field(
        default_factory=dict,
        description="Workflow return values keyed by child queue item id.",
    )


class WorkflowCallParentRef(BaseModel):
    """Reference from a child execution state back to its parent workflow-call relationship."""

    workflow_call_id: str = Field(description="The workflow-call execution id.")
    parent_session_id: str = Field(description="The parent graph execution state id.")
    prepared_call_node_id: str = Field(description="The prepared exec node id for the parent call site.")
    source_call_node_id: str = Field(description="The source graph node id for the parent call site.")
    workflow_id: str = Field(description="The saved workflow being called.")
    depth: int = Field(description="The 1-based depth of this call frame.", ge=1)


@dataclass
class _PreparedExecNodeMetadata:
    """Cached metadata for a materialized execution node."""

    source_node_id: str
    iteration_path: Optional[tuple[int, ...]] = None
    state: PreparedExecState = "pending"


class _PreparedExecRegistry:
    """Tracks prepared execution nodes and their relationship to source graph nodes."""

    def __init__(
        self,
        prepared_source_mapping: dict[str, str],
        source_prepared_mapping: dict[str, set[str]],
        prepared_iteration_paths: dict[str, tuple[int, ...]],
        metadata: dict[str, _PreparedExecNodeMetadata],
        on_iteration_path_change: Callable[[str], None] | None = None,
    ) -> None:
        self._prepared_source_mapping = prepared_source_mapping
        self._source_prepared_mapping = source_prepared_mapping
        self._prepared_iteration_paths = prepared_iteration_paths
        self._metadata = metadata
        self._on_iteration_path_change = on_iteration_path_change

    def register(self, exec_node_id: str, source_node_id: str) -> None:
        self._prepared_source_mapping[exec_node_id] = source_node_id
        self._prepared_iteration_paths.pop(exec_node_id, None)
        self._metadata[exec_node_id] = _PreparedExecNodeMetadata(source_node_id=source_node_id)
        if source_node_id not in self._source_prepared_mapping:
            self._source_prepared_mapping[source_node_id] = set()
        self._source_prepared_mapping[source_node_id].add(exec_node_id)

    def get_metadata(self, exec_node_id: str) -> _PreparedExecNodeMetadata:
        metadata = self._metadata.get(exec_node_id)
        if metadata is None:
            metadata = _PreparedExecNodeMetadata(source_node_id=self._prepared_source_mapping[exec_node_id])
            self._metadata[exec_node_id] = metadata
        return metadata

    def get_source_node_id(self, exec_node_id: str) -> str:
        metadata = self._metadata.get(exec_node_id)
        if metadata is not None:
            return metadata.source_node_id
        return self._prepared_source_mapping[exec_node_id]

    def get_prepared_ids(self, source_node_id: str) -> set[str]:
        return self._source_prepared_mapping.get(source_node_id, set())

    def set_state(self, exec_node_id: str, state: PreparedExecState) -> None:
        self.get_metadata(exec_node_id).state = state

    def get_iteration_path(self, exec_node_id: str) -> Optional[tuple[int, ...]]:
        metadata = self._metadata.get(exec_node_id)
        if metadata is not None and metadata.iteration_path is not None:
            return metadata.iteration_path
        iteration_path = self._prepared_iteration_paths.get(exec_node_id)
        if iteration_path is not None:
            self.get_metadata(exec_node_id).iteration_path = iteration_path
        return iteration_path

    def set_iteration_path(self, exec_node_id: str, iteration_path: tuple[int, ...]) -> None:
        self._prepared_iteration_paths[exec_node_id] = iteration_path
        self.get_metadata(exec_node_id).iteration_path = iteration_path
        if self._on_iteration_path_change is not None:
            self._on_iteration_path_change(exec_node_id)


class _IfBranchScheduler:
    """Applies lazy `If` semantics by deferring, releasing, and skipping branch-local exec nodes."""

    def __init__(self, state: "GraphExecutionState") -> None:
        self._state = state

    def _get_branch_input_sources(self, if_node_id: str, branch_field: str) -> set[str]:
        return {e.source.node_id for e in self._state.graph._get_input_edges(if_node_id, branch_field)}

    def _expand_with_ancestors(self, node_ids: set[str]) -> set[str]:
        expanded = set(node_ids)
        source_graph = self._state.graph.nx_graph_flat()
        for node_id in list(expanded):
            expanded.update(nx.ancestors(source_graph, node_id))
        return expanded

    def _node_outputs_stay_in_branch(
        self, node_id: str, if_node_id: str, branch_field: str, branch_nodes: set[str]
    ) -> bool:
        output_edges = self._state.graph._get_output_edges(node_id)
        return all(
            edge.destination.node_id in branch_nodes
            or (edge.destination.node_id == if_node_id and edge.destination.field == branch_field)
            for edge in output_edges
        )

    def _prune_nonexclusive_branch_nodes(
        self, if_node_id: str, branch_field: str, candidate_nodes: set[str]
    ) -> set[str]:
        exclusive_nodes = set(candidate_nodes)
        changed = True
        while changed:
            changed = False
            for node_id in list(exclusive_nodes):
                if self._node_outputs_stay_in_branch(node_id, if_node_id, branch_field, exclusive_nodes):
                    continue
                exclusive_nodes.remove(node_id)
                changed = True
        return exclusive_nodes

    def _get_matching_prepared_if_ids(self, if_node_id: str, iteration_path: tuple[int, ...]) -> list[str]:
        prepared_if_ids = self._state._prepared_registry().get_prepared_ids(if_node_id)
        return [pid for pid in prepared_if_ids if self._state._get_iteration_path(pid) == iteration_path]

    def _has_unresolved_matching_if(self, if_node_id: str, iteration_path: tuple[int, ...]) -> bool:
        matching_prepared_if_ids = self._get_matching_prepared_if_ids(if_node_id, iteration_path)
        if not matching_prepared_if_ids:
            return True
        return not all(pid in self._state._resolved_if_exec_branches for pid in matching_prepared_if_ids)

    def _apply_condition_inputs(self, exec_node_id: str, node: IfInvocation) -> bool:
        return self._state._apply_if_condition_inputs(exec_node_id, node)

    def _get_selected_branch_fields(self, node: IfInvocation) -> tuple[str, str]:
        selected_field = "true_input" if node.condition else "false_input"
        unselected_field = "false_input" if node.condition else "true_input"
        return selected_field, unselected_field

    def _prune_unselected_if_inputs(self, exec_node_id: str, unselected_field: str) -> None:
        for edge in self._state.execution_graph._get_input_edges(exec_node_id, unselected_field):
            if edge.source.node_id not in self._state.executed:
                if self._state.indegree[exec_node_id] == 0:
                    raise RuntimeError(f"indegree underflow for {exec_node_id} when pruning {unselected_field}")
                self._state.indegree[exec_node_id] -= 1
            self._state.execution_graph.delete_edge(edge)

    def _apply_branch_resolution(
        self,
        exec_node_id: str,
        iteration_path: tuple[int, ...],
        exclusive_sources: dict[str, set[str]],
        selected_field: str,
        unselected_field: str,
    ) -> None:
        # This iterates over the stable prepared-source mapping while mutating per-exec runtime state such as ready
        # queues, execution state, and prepared metadata. Branch resolution never adds or removes prepared exec nodes.
        for prepared_id, prepared_source in self._state.prepared_source_mapping.items():
            if prepared_id in self._state.executed:
                continue
            if self._state._get_iteration_path(prepared_id) != iteration_path:
                continue
            if prepared_source in exclusive_sources[selected_field]:
                self._state._enqueue_if_ready(prepared_id)
            elif prepared_source in exclusive_sources[unselected_field]:
                self.mark_exec_node_skipped(prepared_id)

    def get_branch_exclusive_sources(self, if_node_id: str) -> dict[str, set[str]]:
        cached = self._state._if_branch_exclusive_sources.get(if_node_id)
        if cached is not None:
            return cached

        branch_sources: dict[str, set[str]] = {}
        for branch_field in ("true_input", "false_input"):
            direct_inputs = self._get_branch_input_sources(if_node_id, branch_field)
            candidate_nodes = self._expand_with_ancestors(direct_inputs)
            branch_sources[branch_field] = self._prune_nonexclusive_branch_nodes(
                if_node_id, branch_field, candidate_nodes
            )

        self._state._if_branch_exclusive_sources[if_node_id] = branch_sources
        return branch_sources

    def is_deferred_by_unresolved_if(self, exec_node_id: str) -> bool:
        source_node_id = self._state._prepared_registry().get_source_node_id(exec_node_id)

        for source_if_id, source_if_node in self._state.graph.nodes.items():
            if not isinstance(source_if_node, IfInvocation):
                continue

            branches = self.get_branch_exclusive_sources(source_if_id)
            if source_node_id not in branches["true_input"] and source_node_id not in branches["false_input"]:
                continue

            iteration_path = self._state._get_iteration_path(exec_node_id)
            if self._has_unresolved_matching_if(source_if_id, iteration_path):
                return True
        return False

    def mark_exec_node_skipped(self, exec_node_id: str) -> None:
        state = self._state._get_prepared_exec_metadata(exec_node_id).state
        if state in ("executed", "skipped"):
            return

        self._state._remove_from_ready_queues(exec_node_id)
        self._state._set_prepared_exec_state(exec_node_id, "skipped")
        self._state.executed.add(exec_node_id)

        registry = self._state._prepared_registry()
        source_node_id = registry.get_source_node_id(exec_node_id)
        prepared_nodes = registry.get_prepared_ids(source_node_id)
        if all(n in self._state.executed for n in prepared_nodes):
            if source_node_id not in self._state.executed:
                self._state.executed.add(source_node_id)
                if source_node_id not in self._state.executed_history:
                    self._state.executed_history.append(source_node_id)

    def try_resolve_if_node(self, exec_node_id: str) -> None:
        if exec_node_id in self._state._resolved_if_exec_branches:
            return
        node = self._state.execution_graph.get_node(exec_node_id)
        if not isinstance(node, IfInvocation):
            return

        if not self._apply_condition_inputs(exec_node_id, node):
            return

        selected_field, unselected_field = self._get_selected_branch_fields(node)
        self._state._resolved_if_exec_branches[exec_node_id] = selected_field

        source_if_node_id = self._state._prepared_registry().get_source_node_id(exec_node_id)
        exclusive_sources = self.get_branch_exclusive_sources(source_if_node_id)

        iteration_path = self._state._get_iteration_path(exec_node_id)
        self._prune_unselected_if_inputs(exec_node_id, unselected_field)
        self._apply_branch_resolution(exec_node_id, iteration_path, exclusive_sources, selected_field, unselected_field)
        self._state._enqueue_if_ready(exec_node_id)


class _ExecutionMaterializer:
    """Expands source-graph nodes into concrete execution-graph nodes for the current runtime state.

    `GraphExecutionState.next()` calls into this helper when no prepared exec node is ready. The materializer chooses
    the next source node that can be expanded, creates the corresponding exec nodes in the execution graph, wires their
    inputs, and initializes their scheduler state.
    """

    def __init__(self, state: "GraphExecutionState") -> None:
        self._state = state
        self._iteration_axes_by_source: dict[str, tuple[str, ...]] = {}

    def _get_iteration_axes(self, source_node_id: str) -> tuple[str, ...]:
        cached = self._iteration_axes_by_source.get(source_node_id)
        if cached is not None:
            return cached

        axes = self._state._runtime()._get_ordered_iterator_sources(source_node_id)
        if isinstance(self._state.graph.get_node(source_node_id), IterateInvocation):
            axes.append(source_node_id)
        result = tuple(axes)
        self._iteration_axes_by_source[source_node_id] = result
        return result

    def _get_known_iteration_path(
        self,
        iteration_index: int,
        iteration_node_map: list[tuple[str, str]],
    ) -> Optional[tuple[int, ...]]:
        parent_paths: list[tuple[int, ...]] = []
        parent_iteration_axes: list[tuple[str, ...]] = []
        registry = self._state._prepared_registry()
        for source_node_id, prepared_id in iteration_node_map:
            parent_path = registry.get_iteration_path(prepared_id)
            if parent_path is None:
                return None
            if parent_path:
                parent_paths.append(parent_path)
                parent_iteration_axes.append(self._get_iteration_axes(source_node_id))

        unique_parent_paths = set(parent_paths)
        paths_share_iteration_axes = len(set(parent_iteration_axes)) <= 1

        # Materialized iteration boundaries use non-negative indexes; ordinary execution nodes use -1. Keeping this
        # generic allows other scheduler-managed loop nodes to reuse the same path cache.
        if iteration_index >= 0:
            if len(unique_parent_paths) > 1 or not paths_share_iteration_axes:
                return None
            parent_path = next(iter(unique_parent_paths), ())
            return (*parent_path, iteration_index)

        if not unique_parent_paths:
            return ()
        if len(unique_parent_paths) == 1 and paths_share_iteration_axes:
            return next(iter(unique_parent_paths))
        return None

    def _get_iterator_iteration_count(self, node_id: str, iteration_node_map: list[tuple[str, str]]) -> int:
        input_collection_edge = next(iter(self._state.graph._get_input_edges(node_id, COLLECTION_FIELD)))
        input_collection_prepared_node_id = next(
            prepared_id
            for source_id, prepared_id in iteration_node_map
            if source_id == input_collection_edge.source.node_id
        )
        input_collection_output = self._state.results[input_collection_prepared_node_id]
        input_collection = getattr(input_collection_output, input_collection_edge.source.field)
        return len(input_collection)

    def _get_for_iteration_count(self, node_id: str, iteration_node_map: list[tuple[str, str]]) -> int:
        input_collection_edges = self._state.graph._get_input_edges(node_id, COLLECTION_FIELD)
        if len(input_collection_edges) == 0:
            node = self._state.graph.get_node(node_id)
            assert isinstance(node, ForInvocation)
            return len(node.collection)

        input_collection_edge = input_collection_edges[0]
        input_collection_prepared_node_id = next(
            prepared_id
            for source_id, prepared_id in iteration_node_map
            if source_id == input_collection_edge.source.node_id
        )
        input_collection_output = self._state.results[input_collection_prepared_node_id]
        input_collection = getattr(input_collection_output, input_collection_edge.source.field)
        if not isinstance(input_collection, list):
            raise ValueError("For collection input must be a list")
        return len(input_collection)

    def _get_new_node_iterations(
        self, node: BaseInvocation, node_id: str, iteration_node_map: list[tuple[str, str]]
    ) -> list[int]:
        if isinstance(node, IterateInvocation):
            iteration_count = self._get_iterator_iteration_count(node_id, iteration_node_map)
            if iteration_count == 0:
                return []
            return list(range(iteration_count))

        if isinstance(node, ForInvocation):
            iteration_count = self._get_for_iteration_count(node_id, iteration_node_map)
            if iteration_count == 0:
                return []
            return [0]

        return [-1]

    def _build_execution_edges(self, node_id: str, iteration_node_map: list[tuple[str, str]]) -> list[Edge]:
        input_edges = self._state.graph._get_input_edges(node_id)
        new_edges: list[Edge] = []
        for edge in input_edges:
            matching_inputs = [
                prepared_id for source_id, prepared_id in iteration_node_map if source_id == edge.source.node_id
            ]
            for input_node_id in matching_inputs:
                new_edges.append(
                    Edge(
                        source=EdgeConnection(node_id=input_node_id, field=edge.source.field),
                        destination=EdgeConnection(node_id="", field=edge.destination.field),
                    )
                )
        return new_edges

    def _has_unmaterializable_for_final_input(self, node_id: str) -> bool:
        final_for_source_ids = set()
        for edge in self._state.graph._get_input_edges(node_id):
            source_node = self._state.graph.get_node(edge.source.node_id)
            if not isinstance(source_node, ForInvocation):
                continue
            if get_output_field_scope(source_node, edge.source.field) == OutputScope.Final:
                final_for_source_ids.add(edge.source.node_id)

        return any(not self._state._all_for_contexts_finalized(source_for_id) for source_for_id in final_for_source_ids)

    def _create_execution_node_copy(
        self, node: BaseInvocation, node_id: str, iteration_index: int, *, deep_copy: bool = True
    ) -> BaseInvocation:
        new_node = node.model_copy(deep=deep_copy)
        new_node.id = uuid_string()

        if isinstance(new_node, IterateInvocation):
            new_node.index = iteration_index
        if isinstance(new_node, ForInvocation):
            new_node.index = iteration_index

        # Scheduler-managed iteration boundaries and collectors are cheaper to execute than to hash, especially when
        # their inputs contain large collections. Loop body nodes retain their normal cache behavior.
        if iteration_index >= 0 or isinstance(new_node, CollectInvocation):
            new_node.use_cache = False

        self._state.execution_graph.add_node(new_node)
        self._state._register_prepared_exec_node(new_node.id, node_id)
        return new_node

    def _create_empty_for_final_output(
        self,
        source_for_id: str,
        node: "ForInvocation",
        iteration_node_map: list[tuple[str, str]],
    ) -> str:
        new_node = self._create_execution_node_copy(node, source_for_id, -1, deep_copy=False)
        assert isinstance(new_node, ForInvocation)
        new_edges = self._build_execution_edges(source_for_id, iteration_node_map)
        iteration_path = self._get_known_iteration_path(-1, iteration_node_map)
        if iteration_path is not None:
            self._state._prepared_registry().set_iteration_path(new_node.id, iteration_path)
        self._attach_execution_edges(new_node.id, new_edges)
        self._state._runtime().prepare_inputs(new_node)

        initial_state = copydeep(new_node.state or LoopState())
        new_node.collection = []
        new_node.state = initial_state

        self._state.results[new_node.id] = ForInvocationOutput(
            loop_linkage=LOOP_LINKAGE_FIELD,
            item=None,
            index=-1,
            total=0,
            state=initial_state,
            output_collection=[],
            final_state=initial_state,
        )
        self._state.executed.add(new_node.id)
        self._state._set_prepared_exec_state(new_node.id, "executed")

        return new_node.id

    def _mark_empty_for_complete(self, source_for_id: str) -> None:
        prepared_for_ids = [
            prepared_id
            for prepared_id in self._state._prepared_registry().get_prepared_ids(source_for_id)
            if isinstance(self._state.execution_graph.get_node(prepared_id), ForInvocation)
            and self._state.execution_graph.get_node(prepared_id).index == -1
        ]
        assert prepared_for_ids, f"Empty For '{source_for_id}' did not create a final execution node"
        for prepared_for_id in prepared_for_ids:
            self._state._mark_loop_context_finalized(source_for_id, prepared_for_id)

        self._state._mark_for_source_complete(source_for_id)

    def create_for_iteration(
        self,
        source_for_id: str,
        iteration_index: int,
        collection: list[Any],
        state: "LoopState",
        iteration_path: tuple[int, ...],
    ) -> str:
        node = self._state.graph.get_node(source_for_id)
        if not isinstance(node, ForInvocation):
            raise TypeError(f"Expected source ForInvocation, got {type(node).__name__}")

        new_node = self._create_execution_node_copy(node, source_for_id, iteration_index, deep_copy=False)
        assert isinstance(new_node, ForInvocation)
        new_node.collection = copydeep(collection)
        new_node.state = copydeep(state)
        self._state._prepared_registry().set_iteration_path(new_node.id, iteration_path)
        self._initialize_execution_node(new_node.id)
        return new_node.id

    def create_for_body_iteration(self, source_for_id: str, prepared_for_id: str) -> Optional[str]:
        graph = self._state.graph.nx_graph_flat()
        execution_graph = self._state.execution_graph.nx_graph_flat()
        nested_body = self._state.graph._get_supported_for_nested_iterate_body(source_for_id, graph)
        if nested_body is not None:
            return self._create_nested_iterate_body_iteration(
                source_for_id, prepared_for_id, graph, execution_graph, nested_body
            )
        nested_for_body = self._state.graph._get_supported_for_nested_for_body(source_for_id, graph)
        if nested_for_body is not None:
            return self._create_nested_for_body_iteration(
                source_for_id, prepared_for_id, graph, execution_graph, nested_for_body
            )

        body_path_to_return = self._state.graph._get_for_body_path_to_return(source_for_id, graph)
        if body_path_to_return is None:
            return None

        body_path_nodes, source_return_id = body_path_to_return
        source_to_prepared = {source_for_id: prepared_for_id}
        prepared_return_id: Optional[str] = None

        for source_node_id in nx.topological_sort(graph):
            if source_node_id not in body_path_nodes:
                continue

            node = self._state.graph.get_node(source_node_id)
            new_edges: list[Edge] = []
            for edge in self._state.graph._get_input_edges(source_node_id):
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                if prepared_source_id is None:
                    prepared_source_id = self.get_iteration_node(
                        edge.source.node_id,
                        graph,
                        execution_graph,
                        [prepared_for_id],
                    )
                if prepared_source_id is None:
                    raise RuntimeError(
                        f"Unable to rematerialize For body input {edge}: no prepared source node is available"
                    )
                new_edges.append(
                    Edge(
                        source=EdgeConnection(node_id=prepared_source_id, field=edge.source.field),
                        destination=EdgeConnection(node_id="", field=edge.destination.field),
                    )
                )

            new_node = self._create_execution_node_copy(node, source_node_id, -1)
            source_to_prepared[source_node_id] = new_node.id
            self._state._prepared_registry().set_iteration_path(
                new_node.id, self._state._get_iteration_path(prepared_for_id)
            )
            self._state.executed.discard(source_node_id)
            attached_edges = self._attach_execution_edges(new_node.id, new_edges)
            self._initialize_execution_node(new_node.id, attached_edges)

            if source_node_id == source_return_id:
                prepared_return_id = new_node.id

        return prepared_return_id

    def _is_deferred_nested_for_return(self, node_id: str, graph: "nx.DiGraph") -> bool:
        return any(
            (nested_body := self._state.graph._get_supported_for_nested_for_body(source_for_id, graph)) is not None
            and nested_body.outer_return_id == node_id
            for source_for_id, source_node in self._state.graph.nodes.items()
            if isinstance(source_node, ForInvocation)
        )

    def _get_final_prepared_for_id(self, source_for_id: str, parent_iteration_path: tuple[int, ...]) -> str:
        self._state._get_prepared_for_index()
        assert self._state._final_prepared_for_index is not None
        prepared_for_id = self._state._final_prepared_for_index.get((source_for_id, parent_iteration_path))
        if prepared_for_id is None:
            raise RuntimeError(f"Unable to find finalized nested For '{source_for_id}' for {parent_iteration_path}")
        return prepared_for_id

    def create_nested_for_return(self, inner_for_id: str, prepared_inner_for_id: str) -> Optional[str]:
        graph = self._state.graph.nx_graph_flat()
        inner_iteration_path = self._state._get_iteration_path(prepared_inner_for_id)
        outer_for_id: Optional[str] = None
        nested_body: Optional[_SupportedNestedForBody] = None
        for source_for_id, source_node in self._state.graph.nodes.items():
            if not isinstance(source_node, ForInvocation):
                continue
            candidate = self._state.graph._get_supported_for_nested_for_body(source_for_id, graph)
            if candidate is not None and inner_for_id in candidate.inner_for_ids:
                outer_for_id = source_for_id
                nested_body = candidate
                break
        if outer_for_id is None or nested_body is None:
            return None

        prepared_inner_for = self._state.execution_graph.get_node(prepared_inner_for_id)
        outer_iteration_path = (
            inner_iteration_path
            if isinstance(prepared_inner_for, ForInvocation) and prepared_inner_for.index == -1
            else inner_iteration_path[:-1]
        )
        prepared_outer_for_id = next(
            (
                prepared_id
                for prepared_id in self._state._prepared_registry().get_prepared_ids(outer_for_id)
                if self._state._get_iteration_path(prepared_id) == outer_iteration_path
            ),
            None,
        )
        if prepared_outer_for_id is None:
            raise RuntimeError("Unable to rematerialize nested ForReturn: owning outer For is unavailable")

        source_return_id = nested_body.outer_return_id
        existing_return_ids = [
            prepared_id
            for prepared_id in self._state._prepared_registry().get_prepared_ids(source_return_id)
            if self._state._get_iteration_path(prepared_id) == outer_iteration_path
        ]
        if len(existing_return_ids) > 1:
            raise RuntimeError(
                f"Multiple nested ForReturn executions exist for {source_return_id} at {outer_iteration_path}"
            )
        if existing_return_ids:
            return existing_return_ids[0]

        continuation_nodes = self._state.graph._get_for_nested_for_continuation_nodes(nested_body)
        prepared_inner_ids: dict[str, str] = {inner_for_id: prepared_inner_for_id}
        if any(
            not self._state._is_loop_context_finalized(inner_id, outer_iteration_path)
            for inner_id in nested_body.inner_for_ids
        ):
            return None
        for inner_id in nested_body.inner_for_ids:
            if inner_id in prepared_inner_ids:
                continue
            prepared_inner_ids[inner_id] = self._get_final_prepared_for_id(inner_id, outer_iteration_path)
        source_to_prepared: dict[str, str] = {
            outer_for_id: prepared_outer_for_id,
            **prepared_inner_ids,
        }
        for source_node_id in nx.topological_sort(graph):
            if source_node_id not in continuation_nodes:
                continue

            new_edges: list[Edge] = []
            for edge in self._state.graph._get_input_edges(source_node_id):
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                if prepared_source_id is None:
                    prepared_source_id = self.get_iteration_node(
                        edge.source.node_id,
                        graph,
                        self._state.execution_graph.nx_graph_flat(),
                        [prepared_outer_for_id],
                    )
                if prepared_source_id is None:
                    raise RuntimeError(
                        f"Unable to rematerialize nested For continuation input {edge}: no prepared source node is available"
                    )
                new_edges.append(
                    Edge(
                        source=EdgeConnection(node_id=prepared_source_id, field=edge.source.field),
                        destination=EdgeConnection(node_id="", field=edge.destination.field),
                    )
                )

            new_node = self._create_execution_node_copy(self._state.graph.get_node(source_node_id), source_node_id, -1)
            source_to_prepared[source_node_id] = new_node.id
            self._state._prepared_registry().set_iteration_path(new_node.id, outer_iteration_path)
            self._state.executed.discard(source_node_id)
            attached_edges = self._attach_execution_edges(new_node.id, new_edges)
            self._initialize_execution_node(new_node.id, attached_edges)

        self._state.executed.discard(source_return_id)
        return_edges: list[Edge] = []
        for edge in self._state.graph._get_input_edges(source_return_id):
            if edge.destination.field == "output":
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                source_field = edge.source.field
            elif edge.destination.field == "state":
                prepared_source_id = prepared_outer_for_id
                source_field = edge.source.field
            elif edge.destination.field == "continue_condition":
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                source_field = edge.source.field
            else:
                raise RuntimeError(f"Unable to rematerialize nested ForReturn input {edge}")
            if prepared_source_id is None:
                raise RuntimeError(f"Unable to rematerialize nested ForReturn input {edge}")
            return_edges.append(
                Edge(
                    source=EdgeConnection(node_id=prepared_source_id, field=source_field),
                    destination=EdgeConnection(node_id="", field=edge.destination.field),
                )
            )

        prepared_return_node = self._create_execution_node_copy(
            self._state.graph.get_node(source_return_id), source_return_id, -1
        )
        self._state._prepared_registry().set_iteration_path(prepared_return_node.id, outer_iteration_path)
        attached_return_edges = self._attach_execution_edges(prepared_return_node.id, return_edges)
        self._initialize_execution_node(prepared_return_node.id, attached_return_edges)
        return prepared_return_node.id

    def _create_nested_for_body_iteration(
        self,
        source_for_id: str,
        prepared_for_id: str,
        graph: "nx.DiGraph",
        execution_graph: "nx.DiGraph",
        nested_body: _SupportedNestedForBody,
    ) -> Optional[str]:
        """Materialize one nested-For body at the owning outer iteration path.

        The source graph is shaped as ``outer For -> inner For(s) -> outer ForReturn``. Existing execution nodes
        are reused at the current path; missing ordinary body nodes are copied, then each inner For is allowed to
        advance independently before the outer return is rematerialized.
        """
        body_path_nodes = nested_body.body_path_nodes
        source_return_id = nested_body.outer_return_id
        prepared_for_node = self._state.execution_graph.get_node(prepared_for_id)
        outer_iteration_path = self._state._get_iteration_path(prepared_for_id)
        if isinstance(prepared_for_node, ForInvocation) and prepared_for_node.index >= 0:
            outer_iteration_path = (
                *self._state._get_for_parent_iteration_path(prepared_for_id),
                prepared_for_node.index,
            )

        source_to_prepared: dict[str, str] = {source_for_id: prepared_for_id}
        for source_node_id in nx.topological_sort(graph):
            if source_node_id not in body_path_nodes or source_node_id in {
                *nested_body.inner_for_ids,
                source_return_id,
            }:
                continue
            if not any(nx.has_path(graph, source_node_id, inner_for_id) for inner_for_id in nested_body.inner_for_ids):
                continue

            existing_prepared_ids = [
                prepared_id
                for prepared_id in self._state._prepared_registry().get_prepared_ids(source_node_id)
                if self._state._get_iteration_path(prepared_id) == outer_iteration_path
            ]
            if len(existing_prepared_ids) == 1:
                source_to_prepared[source_node_id] = existing_prepared_ids[0]
                continue

            new_edges: list[Edge] = []
            for edge in self._state.graph._get_input_edges(source_node_id):
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                if prepared_source_id is None:
                    prepared_source_id = self.get_iteration_node(
                        edge.source.node_id, graph, execution_graph, [prepared_for_id]
                    )
                if prepared_source_id is None:
                    raise RuntimeError(
                        f"Unable to rematerialize nested For input {edge}: no prepared source node is available"
                    )
                new_edges.append(
                    Edge(
                        source=EdgeConnection(node_id=prepared_source_id, field=edge.source.field),
                        destination=EdgeConnection(node_id="", field=edge.destination.field),
                    )
                )

            new_node = self._create_execution_node_copy(self._state.graph.get_node(source_node_id), source_node_id, -1)
            source_to_prepared[source_node_id] = new_node.id
            self._state._prepared_registry().set_iteration_path(new_node.id, outer_iteration_path)
            self._state.executed.discard(source_node_id)
            attached_edges = self._attach_execution_edges(new_node.id, new_edges)
            self._initialize_execution_node(new_node.id, attached_edges)

        for body_node_id in body_path_nodes:
            if body_node_id in nested_body.inner_for_ids or not any(
                nx.has_path(graph, body_node_id, inner_for_id) for inner_for_id in nested_body.inner_for_ids
            ):
                self._state.executed.discard(body_node_id)
        self._state.executed.discard(source_return_id)

        for source_inner_for_id in nested_body.inner_for_ids:
            existing_prepared_ids = [
                prepared_id
                for prepared_id in self._state._prepared_registry().get_prepared_ids(source_inner_for_id)
                if self._state._get_for_parent_iteration_path(prepared_id) == outer_iteration_path
            ]
            if existing_prepared_ids:
                continue

            inner_input_map: list[tuple[str, str]] = []
            for edge in self._state.graph._get_input_edges(source_inner_for_id):
                prepared_source_id = source_to_prepared.get(edge.source.node_id)
                if prepared_source_id is None:
                    prepared_source_id = self.get_iteration_node(
                        edge.source.node_id, graph, execution_graph, [prepared_for_id]
                    )
                if prepared_source_id is None:
                    raise RuntimeError(
                        f"Unable to rematerialize nested For input {edge}: no prepared source node is available"
                    )
                inner_input_map.append((edge.source.node_id, prepared_source_id))

            if any(prepared_source_id not in self._state.results for _, prepared_source_id in inner_input_map):
                return None

            self._state.executed.discard(source_inner_for_id)
            inner_prepared_ids = self.create_execution_node(
                source_inner_for_id, inner_input_map, iteration_path=outer_iteration_path
            )
            if not inner_prepared_ids:
                self._mark_source_node_empty(source_inner_for_id)
            elif all(
                isinstance(self._state.execution_graph.get_node(inner_id), ForInvocation)
                and self._state.execution_graph.get_node(inner_id).index == -1
                for inner_id in inner_prepared_ids
            ):
                self._mark_empty_for_complete(source_inner_for_id)
                for inner_prepared_id in inner_prepared_ids:
                    self.create_nested_for_return(source_inner_for_id, inner_prepared_id)
            else:
                for inner_prepared_id in inner_prepared_ids:
                    self.create_for_body_iteration(
                        source_for_id=source_inner_for_id,
                        prepared_for_id=inner_prepared_id,
                    )

        return None

    def _create_nested_iterate_body_iteration(
        self,
        source_for_id: str,
        prepared_for_id: str,
        graph: "nx.DiGraph",
        execution_graph: "nx.DiGraph",
        nested_body: _SupportedNestedIterateBody,
    ) -> Optional[str]:
        body_path_nodes = nested_body.body_path_nodes
        source_return_id = nested_body.return_node_id
        source_iterate_id = nested_body.iterate_node_id
        source_collect_id = nested_body.collect_node_id
        prepared_for_node = self._state.execution_graph.get_node(prepared_for_id)
        outer_iteration_path = self._state._get_iteration_path(prepared_for_id)
        if isinstance(prepared_for_node, ForInvocation) and prepared_for_node.index >= 0:
            outer_iteration_path = (
                *self._state._get_for_parent_iteration_path(prepared_for_id),
                prepared_for_node.index,
            )
        source_to_prepared: dict[str, str] = {source_for_id: prepared_for_id}
        inner_prepared_by_source: dict[tuple[str, str], str] = {}

        def resolve_outer_input(source_node_id: str) -> Optional[str]:
            prepared_source_id = source_to_prepared.get(source_node_id)
            if prepared_source_id is not None:
                return prepared_source_id
            return self.get_iteration_node(source_node_id, graph, execution_graph, [prepared_for_id])

        def create_body_copy(source_node_id: str, input_resolver, iteration_path: tuple[int, ...]) -> str:
            new_edges: list[Edge] = []
            for edge in self._state.graph._get_input_edges(source_node_id):
                prepared_source_id = input_resolver(edge.source.node_id)
                if prepared_source_id is None:
                    raise RuntimeError(
                        f"Unable to rematerialize For body input {edge}: no prepared source node is available"
                    )
                new_edges.append(
                    Edge(
                        source=EdgeConnection(node_id=prepared_source_id, field=edge.source.field),
                        destination=EdgeConnection(node_id="", field=edge.destination.field),
                    )
                )

            new_node = self._create_execution_node_copy(self._state.graph.get_node(source_node_id), source_node_id, -1)
            self._state._prepared_registry().set_iteration_path(new_node.id, iteration_path)
            attached_edges = self._attach_execution_edges(new_node.id, new_edges)
            self._initialize_execution_node(new_node.id, attached_edges)
            return new_node.id

        def get_existing_body_node(source_node_id: str) -> Optional[str]:
            matching_ids = [
                prepared_id
                for prepared_id in self._state._prepared_registry().get_prepared_ids(source_node_id)
                if self._state._get_iteration_path(prepared_id) == outer_iteration_path
            ]
            if len(matching_ids) == 1:
                return matching_ids[0]
            return None

        for source_node_id in nx.topological_sort(graph):
            if source_node_id not in body_path_nodes or source_node_id in {
                source_iterate_id,
                source_collect_id,
                source_return_id,
            }:
                continue
            if not nx.has_path(graph, source_node_id, source_iterate_id):
                continue
            source_to_prepared[source_node_id] = get_existing_body_node(source_node_id) or create_body_copy(
                source_node_id, resolve_outer_input, outer_iteration_path
            )

        iterate_input_map: list[tuple[str, str]] = []
        for edge in self._state.graph._get_input_edges(source_iterate_id):
            prepared_source_id = resolve_outer_input(edge.source.node_id)
            if prepared_source_id is None:
                raise RuntimeError(
                    f"Unable to rematerialize For body input {edge}: no prepared source node is available"
                )
            iterate_input_map.append((edge.source.node_id, prepared_source_id))

        if any(prepared_source_id not in self._state.results for _, prepared_source_id in iterate_input_map):
            return None

        self._state.executed.discard(source_iterate_id)
        inner_prepared_ids = self.create_execution_node(
            source_iterate_id, iterate_input_map, iteration_path=outer_iteration_path
        )
        if not inner_prepared_ids:
            self._mark_source_node_empty(source_iterate_id)

        for inner_prepared_id in inner_prepared_ids:
            inner_iteration_path = self._state._get_iteration_path(inner_prepared_id)
            for source_node_id in nx.topological_sort(graph):
                if source_node_id not in body_path_nodes:
                    continue
                if source_node_id in {source_iterate_id, source_collect_id, source_return_id}:
                    continue
                if nx.has_path(graph, source_node_id, source_iterate_id):
                    continue
                if not nx.has_path(graph, source_iterate_id, source_node_id):
                    continue

                def resolve_inner_input(
                    input_source_node_id: str, current_inner_prepared_id: str = inner_prepared_id
                ) -> Optional[str]:
                    if input_source_node_id == source_iterate_id:
                        return current_inner_prepared_id
                    prepared_source_id = source_to_prepared.get(input_source_node_id)
                    if prepared_source_id is not None:
                        return prepared_source_id
                    prepared_source_id = inner_prepared_by_source.get((input_source_node_id, current_inner_prepared_id))
                    if prepared_source_id is not None:
                        return prepared_source_id
                    return self.get_iteration_node(
                        input_source_node_id, graph, execution_graph, [current_inner_prepared_id]
                    )

                self._state.executed.discard(source_node_id)
                prepared_id = create_body_copy(source_node_id, resolve_inner_input, inner_iteration_path)
                inner_prepared_by_source[(source_node_id, inner_prepared_id)] = prepared_id

        if not inner_prepared_ids:
            for source_node_id in body_path_nodes:
                if source_node_id in {source_iterate_id, source_collect_id, source_return_id}:
                    continue
                if nx.has_path(graph, source_iterate_id, source_node_id):
                    self._mark_source_node_empty(source_node_id)

        collect_item_edge = self._state.graph._get_input_edges(source_collect_id, ITEM_FIELD)[0]
        collect_edges: list[Edge] = []
        for inner_prepared_id in inner_prepared_ids:
            prepared_source_id = inner_prepared_by_source.get((collect_item_edge.source.node_id, inner_prepared_id))
            if prepared_source_id is None and collect_item_edge.source.node_id == source_iterate_id:
                prepared_source_id = inner_prepared_id
            if prepared_source_id is None:
                raise RuntimeError(
                    f"Unable to rematerialize For body input {collect_item_edge}: no prepared source node is available"
                )
            collect_edges.append(
                Edge(
                    source=EdgeConnection(node_id=prepared_source_id, field=collect_item_edge.source.field),
                    destination=EdgeConnection(node_id="", field=ITEM_FIELD),
                )
            )

        self._state.executed.discard(source_collect_id)
        collect_node = self._state.graph.get_node(source_collect_id)
        prepared_collect_node = self._create_execution_node_copy(collect_node, source_collect_id, -1)
        self._state._prepared_registry().set_iteration_path(prepared_collect_node.id, outer_iteration_path)
        attached_collect_edges = self._attach_execution_edges(prepared_collect_node.id, collect_edges)
        self._initialize_execution_node(prepared_collect_node.id, attached_collect_edges)

        return_edges: list[Edge] = []
        for edge in self._state.graph._get_input_edges(source_return_id):
            if edge.destination.field == "output":
                prepared_source_id = prepared_collect_node.id
                source_field = COLLECTION_FIELD
            else:
                prepared_source_id = resolve_outer_input(edge.source.node_id)
                source_field = edge.source.field
            if prepared_source_id is None:
                raise RuntimeError(
                    f"Unable to rematerialize For body input {edge}: no prepared source node is available"
                )
            return_edges.append(
                Edge(
                    source=EdgeConnection(node_id=prepared_source_id, field=source_field),
                    destination=EdgeConnection(node_id="", field=edge.destination.field),
                )
            )
        self._state.executed.discard(source_return_id)
        prepared_return_node = self._create_execution_node_copy(
            self._state.graph.get_node(source_return_id), source_return_id, -1
        )
        self._state._prepared_registry().set_iteration_path(prepared_return_node.id, outer_iteration_path)
        attached_return_edges = self._attach_execution_edges(prepared_return_node.id, return_edges)
        self._initialize_execution_node(prepared_return_node.id, attached_return_edges)
        return prepared_return_node.id

    def _attach_execution_edges(self, exec_node_id: str, new_edges: list[Edge]) -> list[Edge]:
        attached_edges = [
            Edge(
                source=edge.source,
                destination=EdgeConnection(node_id=exec_node_id, field=edge.destination.field),
            )
            for edge in new_edges
        ]
        self._state.execution_graph._extend_edges_unchecked(attached_edges)
        return attached_edges

    def _initialize_execution_node(self, exec_node_id: str, input_edges: Optional[list[Edge]] = None) -> None:
        inputs = input_edges if input_edges is not None else self._state.execution_graph._get_input_edges(exec_node_id)
        unmet = sum(1 for edge in inputs if edge.source.node_id not in self._state.executed)
        self._state.indegree[exec_node_id] = unmet
        self._state._try_resolve_if_node(exec_node_id)
        self._state._enqueue_if_ready(exec_node_id)

    def _get_collect_iteration_group_key(self, edge: Edge, sibling_depth: Optional[int] = None) -> tuple[int, ...]:
        path = self._state._get_iteration_path(edge.source.node_id)
        source_node = self._state.execution_graph.get_node(edge.source.node_id)
        if (
            isinstance(source_node, ForInvocation)
            and get_output_field_scope(source_node, edge.source.field) == OutputScope.Final
        ):
            return self._state._get_for_parent_iteration_path(edge.source.node_id)
        if edge.destination.field == ITEM_FIELD:
            if isinstance(source_node, ForInvocation) and source_node.index == -1:
                return path
            # Ragged siblings need the deepest path to identify their shared outer group.
            depth = len(path) if sibling_depth is None else sibling_depth
            return path[: max(depth - 1, 0)]
        return path

    def _get_collect_source_iterator_ids(self, source_node_id: str) -> list[str]:
        iterator_node_ids = self.get_node_iterators(source_node_id)
        if isinstance(self._state.graph.get_node(source_node_id), IterateInvocation):
            iterator_node_ids.append(source_node_id)
        return iterator_node_ids

    def _get_ordered_prepared_nodes_for_source(self, source_node_id: str) -> list[str]:
        return sorted(
            self._get_prepared_nodes_for_source(source_node_id),
            key=lambda exec_node_id: (self._state._get_iteration_path(exec_node_id), exec_node_id),
        )

    def _get_ordered_prepared_nodes_for_edge(self, edge: Edge) -> list[str]:
        prepared_nodes = self._get_ordered_prepared_nodes_for_source(edge.source.node_id)
        source_node = self._state.graph.get_node(edge.source.node_id)
        if not (
            isinstance(source_node, ForInvocation)
            and get_output_field_scope(source_node, edge.source.field) == OutputScope.Final
        ):
            return prepared_nodes

        final_nodes_by_parent_path: dict[tuple[int, ...], str] = {}
        for prepared_id in prepared_nodes:
            parent_path = self._state._get_for_parent_iteration_path(prepared_id)
            previous_id = final_nodes_by_parent_path.get(parent_path)
            if previous_id is None:
                final_nodes_by_parent_path[parent_path] = prepared_id
                continue
            previous_node = self._state.execution_graph.get_node(previous_id)
            prepared_node = self._state.execution_graph.get_node(prepared_id)
            assert isinstance(previous_node, ForInvocation)
            assert isinstance(prepared_node, ForInvocation)
            if prepared_node.index > previous_node.index:
                final_nodes_by_parent_path[parent_path] = prepared_id

        return [final_nodes_by_parent_path[parent_path] for parent_path in sorted(final_nodes_by_parent_path)]

    def _get_prepared_edge_iteration_path(self, edge: Edge, prepared_id: str) -> tuple[int, ...]:
        source_node = self._state.graph.get_node(edge.source.node_id)
        if (
            isinstance(source_node, ForInvocation)
            and get_output_field_scope(source_node, edge.source.field) == OutputScope.Final
        ):
            return self._state._get_for_parent_iteration_path(prepared_id)
        return self._state._get_iteration_path(prepared_id)

    def _get_iterator_input_iteration_paths(self, iterator_node_id: str) -> set[tuple[int, ...]]:
        iteration_paths: set[tuple[int, ...]] = set()
        for edge in self._state.graph._get_input_edges(iterator_node_id, COLLECTION_FIELD):
            source_node_id = edge.source.node_id
            prepared_nodes = self._get_ordered_prepared_nodes_for_source(source_node_id)
            iteration_paths.update(
                self._get_prepared_edge_iteration_path(edge, prepared_id) for prepared_id in prepared_nodes
            )
        return iteration_paths

    def _get_collect_candidate_group_keys(self, edge: Edge) -> set[tuple[int, ...]]:
        source_node_id = edge.source.node_id
        iterator_node_ids = self._get_collect_source_iterator_ids(source_node_id)

        group_depth = len(iterator_node_ids)
        if edge.destination.field == ITEM_FIELD:
            group_depth = max(group_depth - 1, 0)

        group_keys: set[tuple[int, ...]] = set()
        for iterator_node_id in iterator_node_ids:
            prepared_nodes = self._get_ordered_prepared_nodes_for_source(iterator_node_id)
            # Prepared paths use the active group depth. Input paths stay full to preserve scope across collectors.
            if prepared_nodes and group_depth:
                group_keys.update(
                    iteration_path[:group_depth]
                    for prepared_id in prepared_nodes
                    if len(iteration_path := self._state._get_iteration_path(prepared_id)) >= group_depth
                )
            group_keys.update(self._get_iterator_input_iteration_paths(iterator_node_id))

        if group_keys:
            return group_keys
        if group_depth == 0:
            return {()}
        return set()

    def _get_collect_iteration_mapping_groups(
        self, input_edges: list[Edge]
    ) -> list[tuple[tuple[int, ...], list[tuple[str, str]]]]:
        prepared_inputs: list[tuple[Edge, str, str, tuple[int, ...]]] = []
        group_keys: set[tuple[int, ...]] = set()
        for edge in input_edges:
            group_keys.update(self._get_collect_candidate_group_keys(edge))
            prepared_nodes = self._get_ordered_prepared_nodes_for_edge(edge)
            sibling_depth = max(
                (len(self._get_prepared_edge_iteration_path(edge, prepared_id)) for prepared_id in prepared_nodes),
                default=0,
            )
            for prepared_id in prepared_nodes:
                prepared_edge = Edge(
                    source=EdgeConnection(node_id=prepared_id, field=edge.source.field),
                    destination=edge.destination,
                )
                group_key = self._get_collect_iteration_group_key(prepared_edge, sibling_depth)
                group_keys.add(group_key)
                prepared_inputs.append(
                    (
                        prepared_edge,
                        edge.source.node_id,
                        prepared_id,
                        self._get_prepared_edge_iteration_path(edge, prepared_id),
                    )
                )

        if not group_keys:
            group_keys.add(())

        final_group_keys = sorted(
            group_key
            for group_key in group_keys
            if not any(
                group_key != other_group_key and other_group_key[: len(group_key)] == group_key
                for other_group_key in group_keys
            )
        )

        return [
            (
                group_key,
                [
                    (source_node_id, prepared_id)
                    for prepared_edge, source_node_id, prepared_id, iteration_path in prepared_inputs
                    if (
                        prepared_edge.destination.field == ITEM_FIELD
                        and (
                            group_key[: len(iteration_path)] == iteration_path
                            or iteration_path[: len(group_key)] == group_key
                        )
                    )
                    or (
                        prepared_edge.destination.field != ITEM_FIELD
                        and group_key[: len(iteration_path)] == iteration_path
                    )
                ],
            )
            for group_key in final_group_keys
        ]

    def _get_parent_iteration_mappings_without_iterators(self, next_node_id: str) -> list[list[tuple[str, str]]]:
        input_edges = self._state.graph._get_input_edges(next_node_id)
        parent_node_ids = list(dict.fromkeys(edge.source.node_id for edge in input_edges))
        parent_prepared_nodes = {
            node_id: list(
                dict.fromkeys(
                    (prepared_id, self._get_prepared_edge_iteration_path(edge, prepared_id))
                    for edge in input_edges
                    if edge.source.node_id == node_id
                    for prepared_id in self._get_ordered_prepared_nodes_for_edge(edge)
                )
            )
            for node_id in parent_node_ids
        }
        all_iteration_paths = {
            iteration_path
            for prepared_nodes in parent_prepared_nodes.values()
            for _prepared_id, iteration_path in prepared_nodes
            if iteration_path != ()
        }
        iteration_paths = sorted(
            iteration_path
            for iteration_path in all_iteration_paths
            if not any(
                iteration_path != other_path and other_path[: len(iteration_path)] == iteration_path
                for other_path in all_iteration_paths
            )
        )
        if not iteration_paths:
            iteration_paths = [()]

        mappings: list[list[tuple[str, str]]] = []
        for iteration_path in iteration_paths:
            mapping: list[tuple[str, str]] = []
            for node_id, prepared_nodes in parent_prepared_nodes.items():
                matching_prepared = next(
                    iter(
                        sorted(
                            (
                                (prepared_id, prepared_path)
                                for prepared_id, prepared_path in prepared_nodes
                                if iteration_path[: len(prepared_path)] == prepared_path
                            ),
                            key=lambda prepared: (-len(prepared[1]), prepared[0]),
                        )
                    ),
                    None,
                )
                if matching_prepared is None:
                    break
                mapping.append((node_id, matching_prepared[0]))
            if len(mapping) == len(parent_node_ids):
                mappings.append(mapping)
        return mappings

    def _mark_source_node_empty(self, source_node_id: str) -> None:
        self._state.source_prepared_mapping[source_node_id] = set()
        self._state.executed.add(source_node_id)
        if source_node_id not in self._state.executed_history:
            self._state.executed_history.append(source_node_id)

    def _index_prepared_nodes_by_iteration_path(
        self, prepared_nodes: set[str], input_edges: list[Edge]
    ) -> dict[tuple[int, ...], list[str]]:
        prepared_nodes_by_iteration_path: dict[tuple[int, ...], list[str]] = {}
        for prepared_id in prepared_nodes:
            iteration_path = self._get_prepared_edge_iteration_path(input_edges[0], prepared_id)
            prepared_nodes_by_iteration_path.setdefault(iteration_path, []).append(prepared_id)
        return prepared_nodes_by_iteration_path

    def _get_target_iteration_path(
        self, source_node_id: str, graph: "nx.DiGraph", prepared_iterator_nodes: tuple[str, ...]
    ) -> Optional[tuple[int, ...]]:
        parent_iterators = self._get_parent_iterator_exec_nodes(source_node_id, graph, list(prepared_iterator_nodes))
        parent_paths = [self._state._get_iteration_path(prepared_id) for prepared_id, _ in parent_iterators]
        if not parent_paths:
            return ()

        target_path = max(parent_paths, key=len)
        if all(target_path[: len(parent_path)] == parent_path for parent_path in parent_paths):
            return target_path
        return None

    def _get_indexed_iteration_node(
        self,
        source_node_id: str,
        graph: "nx.DiGraph",
        prepared_iterator_nodes: tuple[str, ...],
        prepared_nodes_by_iteration_path: dict[tuple[int, ...], list[str]],
    ) -> Optional[str]:
        target_path = self._get_target_iteration_path(source_node_id, graph, prepared_iterator_nodes)
        if target_path is None:
            return None

        for path_length in range(len(target_path), -1, -1):
            candidates = prepared_nodes_by_iteration_path.get(target_path[:path_length], [])
            if len(candidates) == 1:
                return candidates[0]
            if len(candidates) > 1:
                return None
        return None

    def _get_parent_iteration_mappings(self, next_node_id: str, graph: "nx.DiGraph") -> Iterable[list[tuple[str, str]]]:
        parent_node_ids = [source_id for source_id, _ in graph.in_edges(next_node_id)]
        iterator_graph = self.iterator_graph(graph)
        iterator_nodes = self.get_node_iterators(next_node_id, iterator_graph)
        if not iterator_nodes:
            return iter(self._get_parent_iteration_mappings_without_iterators(next_node_id))

        iterator_nodes_prepared = [
            sorted(self._state.source_prepared_mapping[node_id], key=self._state._get_iteration_path)
            for node_id in iterator_nodes
        ]
        prepared_nodes_by_source = {
            node_id: self._get_prepared_nodes_for_source(node_id) for node_id in parent_node_ids
        }
        prepared_nodes_by_source_and_path = {
            node_id: self._index_prepared_nodes_by_iteration_path(
                prepared_nodes,
                [edge for edge in self._state.graph._get_input_edges(next_node_id) if edge.source.node_id == node_id],
            )
            for node_id, prepared_nodes in prepared_nodes_by_source.items()
        }

        def iter_mappings() -> Iterable[list[tuple[str, str]]]:
            execution_graph: Optional["nx.DiGraph"] = None
            for prepared_iterators in itertools.product(*iterator_nodes_prepared):
                mapping: list[tuple[str, str]] = []
                for node_id in parent_node_ids:
                    prepared_id = self._get_indexed_iteration_node(
                        node_id,
                        graph,
                        prepared_iterators,
                        prepared_nodes_by_source_and_path[node_id],
                    )
                    if prepared_id is None:
                        if execution_graph is None:
                            execution_graph = self._state.execution_graph.nx_graph_flat()
                        prepared_id = self.get_iteration_node(
                            node_id,
                            graph,
                            execution_graph,
                            list(prepared_iterators),
                            prepared_nodes_by_source[node_id],
                        )
                    if prepared_id is None:
                        break
                    mapping.append((node_id, prepared_id))
                if len(mapping) == len(parent_node_ids):
                    yield mapping

        return iter(iter_mappings())

    def create_execution_node(
        self,
        node_id: str,
        iteration_node_map: list[tuple[str, str]],
        iteration_path: Optional[tuple[int, ...]] = None,
    ) -> list[str]:
        """Prepares an iteration node and connects all edges, returning the new node id"""

        node = self._state.graph.get_node(node_id)
        iteration_indexes = self._get_new_node_iterations(node, node_id, iteration_node_map)
        if not iteration_indexes:
            if isinstance(node, ForInvocation):
                return [self._create_empty_for_final_output(node_id, node, iteration_node_map)]
            return []

        new_edges = self._build_execution_edges(node_id, iteration_node_map)
        new_nodes: list[str] = []
        for iteration_index in iteration_indexes:
            new_node = self._create_execution_node_copy(node, node_id, iteration_index)
            new_node_iteration_path = iteration_path
            if new_node_iteration_path is None:
                new_node_iteration_path = self._get_known_iteration_path(iteration_index, iteration_node_map)
            elif isinstance(node, (ForInvocation, IterateInvocation)):
                new_node_iteration_path += (iteration_index,)
            if new_node_iteration_path is not None:
                self._state._prepared_registry().set_iteration_path(new_node.id, new_node_iteration_path)
            attached_edges = self._attach_execution_edges(new_node.id, new_edges)
            self._initialize_execution_node(new_node.id, attached_edges)
            new_nodes.append(new_node.id)

        return new_nodes

    def iterator_graph(self, base: Optional["nx.DiGraph"] = None) -> "nx.DiGraph":
        """Gets a DiGraph with edges to collectors removed so an ancestor search produces all active iterators for any node"""
        g = base.copy() if base is not None else self._state.graph.nx_graph_flat()
        collectors = (
            n for n in self._state.graph.nodes if isinstance(self._state.graph.get_node(n), CollectInvocation)
        )
        for c in collectors:
            g.remove_edges_from(list(g.in_edges(c)))
        for edge in self._state.graph.edges:
            source_node = self._state.graph.get_node(edge.source.node_id)
            if (
                isinstance(source_node, ForInvocation)
                and get_output_field_scope(source_node, edge.source.field) == OutputScope.Final
            ):
                if g.has_edge(edge.source.node_id, edge.destination.node_id):
                    g.remove_edge(edge.source.node_id, edge.destination.node_id)
        return g

    def get_node_iterators(self, node_id: str, it_graph: Optional["nx.DiGraph"] = None) -> list[str]:
        g = it_graph or self.iterator_graph()
        return [
            n
            for n in nx.ancestors(g, node_id)
            if isinstance(self._state.graph.get_node(n), (ForInvocation, IterateInvocation))
        ]

    def _get_prepared_nodes_for_source(self, source_node_id: str) -> set[str]:
        return {
            exec_node_id
            for exec_node_id in self._state.source_prepared_mapping[source_node_id]
            if self._state._get_prepared_exec_metadata(exec_node_id).state != "skipped"
        }

    def _get_parent_iterator_exec_nodes(
        self, source_node_id: str, graph: "nx.DiGraph", prepared_iterator_nodes: list[str]
    ) -> list[tuple[str, str]]:
        iterator_source_node_mapping = [
            (prepared_exec_node_id, self._state.prepared_source_mapping[prepared_exec_node_id])
            for prepared_exec_node_id in prepared_iterator_nodes
        ]
        return [
            iterator_mapping
            for iterator_mapping in iterator_source_node_mapping
            if nx.has_path(graph, iterator_mapping[1], source_node_id)
        ]

    def _matches_parent_iterators(
        self, candidate_exec_node_id: str, parent_iterators: list[tuple[str, str]], execution_graph: "nx.DiGraph"
    ) -> bool:
        return all(
            nx.has_path(execution_graph, parent_iterator_exec_id, candidate_exec_node_id)
            for parent_iterator_exec_id, _ in parent_iterators
        )

    def _get_direct_prepared_iterator_match(
        self,
        prepared_nodes: set[str],
        prepared_iterator_nodes: list[str],
        parent_iterators: list[tuple[str, str]],
        execution_graph: "nx.DiGraph",
    ) -> Optional[str]:
        prepared_iterator = next((node_id for node_id in prepared_iterator_nodes if node_id in prepared_nodes), None)
        if prepared_iterator is None:
            return None
        if self._matches_parent_iterators(prepared_iterator, parent_iterators, execution_graph):
            return prepared_iterator
        return None

    def _find_prepared_node_matching_iterators(
        self, prepared_nodes: set[str], parent_iterators: list[tuple[str, str]], execution_graph: "nx.DiGraph"
    ) -> Optional[str]:
        return next(
            (
                node_id
                for node_id in prepared_nodes
                if self._matches_parent_iterators(node_id, parent_iterators, execution_graph)
            ),
            None,
        )

    def _get_final_for_exec_node(self, prepared_nodes: set[str]) -> Optional[str]:
        prepared_for_nodes = [(node_id, self._state.execution_graph.nodes.get(node_id)) for node_id in prepared_nodes]
        prepared_for_nodes = [
            (node_id, node) for node_id, node in prepared_for_nodes if isinstance(node, ForInvocation)
        ]
        if not prepared_for_nodes:
            return None
        return max(prepared_for_nodes, key=lambda item: item[1].index)[0]

    def get_iteration_node(
        self,
        source_node_id: str,
        graph: "nx.DiGraph",
        execution_graph: "nx.DiGraph",
        prepared_iterator_nodes: list[str],
        prepared_nodes: Optional[set[str]] = None,
    ) -> Optional[str]:
        if prepared_nodes is None:
            prepared_nodes = self._get_prepared_nodes_for_source(source_node_id)
        if len(prepared_nodes) == 1 and not prepared_iterator_nodes:
            return next(iter(prepared_nodes))

        parent_iterators = self._get_parent_iterator_exec_nodes(source_node_id, graph, prepared_iterator_nodes)
        if not parent_iterators and isinstance(self._state.graph.get_node(source_node_id), ForInvocation):
            return self._get_final_for_exec_node(prepared_nodes)
        if len(prepared_nodes) == 1:
            prepared_node_id = next(iter(prepared_nodes))
            if self._matches_parent_iterators(prepared_node_id, parent_iterators, execution_graph):
                return prepared_node_id
            return None

        direct_iterator_match = self._get_direct_prepared_iterator_match(
            prepared_nodes, prepared_iterator_nodes, parent_iterators, execution_graph
        )
        if direct_iterator_match is not None:
            return direct_iterator_match

        return self._find_prepared_node_matching_iterators(prepared_nodes, parent_iterators, execution_graph)

    def prepare(self, base_g: Optional["nx.DiGraph"] = None) -> Optional[str]:
        g = base_g or self._state.graph.nx_graph_flat()
        next_node_id = next(
            (
                node_id
                for node_id in nx.topological_sort(g)
                if node_id not in self._state.source_prepared_mapping
                and node_id not in self._state.executed
                and not (
                    isinstance(self._state.graph.get_node(node_id), ForReturnInvocation)
                    and self._is_deferred_nested_for_return(node_id, g)
                )
                and not self._has_unmaterializable_for_final_input(node_id)
                and all(
                    source_id in self._state.source_prepared_mapping or source_id in self._state.executed
                    for source_id, _ in g.in_edges(node_id)
                )
                and (
                    not isinstance(self._state.graph.get_node(node_id), (ForInvocation, IterateInvocation))
                    or all(source_id in self._state.executed for source_id, _ in g.in_edges(node_id))
                )
                and not any(
                    isinstance(self._state.graph.get_node(ancestor_id), (ForInvocation, IterateInvocation))
                    and ancestor_id not in self._state.executed
                    for ancestor_id in nx.ancestors(g, node_id)
                )
            ),
            None,
        )

        if next_node_id is None:
            return None

        next_node = self._state.graph.get_node(next_node_id)
        new_node_ids: list[str] = []

        if isinstance(next_node, CollectInvocation):
            iteration_mapping_groups = self._get_collect_iteration_mapping_groups(
                self._state.graph._get_input_edges(next_node_id)
            )
            for iteration_path, iteration_mappings in iteration_mapping_groups:
                create_results = self.create_execution_node(next_node_id, iteration_mappings, iteration_path)
                new_node_ids.extend(create_results)
        else:
            parent_iterator_nodes = self.get_node_iterators(next_node_id)
            for iteration_mappings in self._get_parent_iteration_mappings(next_node_id, g):
                iteration_path = None
                if not parent_iterator_nodes:
                    input_edges = self._state.graph._get_input_edges(next_node_id)
                    iteration_path = max(
                        (
                            self._get_prepared_edge_iteration_path(edge, prepared_id)
                            for source_id, prepared_id in iteration_mappings
                            for edge in input_edges
                            if edge.source.node_id == source_id
                        ),
                        key=lambda path: (len(path), path),
                        default=(),
                    )
                create_results = self.create_execution_node(next_node_id, iteration_mappings, iteration_path)
                new_node_ids.extend(create_results)

        if not new_node_ids:
            # No parent mappings means zero loop contexts, unlike a context with an empty collection.
            self._mark_source_node_empty(next_node_id)
            self._state._invalidate_loop_caches_for_source(next_node_id)
            return next_node_id

        if isinstance(next_node, ForInvocation) and all(
            self._state.execution_graph.get_node(exec_node_id).index == -1 for exec_node_id in new_node_ids
        ):
            self._mark_empty_for_complete(next_node_id)

        return new_node_ids[0]


class _ExecutionScheduler:
    """Owns ready-queue ordering and indegree-driven execution transitions."""

    def __init__(self, state: "GraphExecutionState") -> None:
        self._state = state

    def _validate_exec_node_ready_state(self, exec_node_id: str) -> None:
        if exec_node_id not in self._state.execution_graph.nodes:
            raise KeyError(f"exec node {exec_node_id} missing from execution_graph")
        if exec_node_id not in self._state.indegree:
            raise KeyError(f"indegree missing for exec node {exec_node_id}")

    def _should_skip_ready_enqueue(self, exec_node_id: str) -> bool:
        return (
            self._state.indegree[exec_node_id] != 0
            or exec_node_id in self._state.executed
            or self._state._is_deferred_by_unresolved_if(exec_node_id)
        )

    def _get_ready_queue(self, exec_node_id: str) -> Deque[str]:
        node_obj = self._state.execution_graph.nodes[exec_node_id]
        return self.queue_for(self._state._type_key(node_obj))

    def _insert_ready_node(self, queue: Deque[str], exec_node_id: str) -> None:
        exec_node_path = self._state._get_iteration_path(exec_node_id)
        if not queue or self._state._get_iteration_path(queue[-1]) <= exec_node_path:
            queue.append(exec_node_id)
            return
        for i, existing in enumerate(queue):
            if self._state._get_iteration_path(existing) > exec_node_path:
                queue.insert(i, exec_node_id)
                return
        queue.append(exec_node_id)

    def _record_completed_node(self, exec_node_id: str, output: BaseInvocationOutput) -> None:
        self._state._set_prepared_exec_state(exec_node_id, "executed")
        self._state.executed.add(exec_node_id)
        self._state.results[exec_node_id] = output
        node = self._state.execution_graph.nodes[exec_node_id]
        if isinstance(node, (IterateInvocation, CollectInvocation)):
            node.collection = []

    def _mark_source_node_complete(self, exec_node_id: str) -> None:
        registry = self._state._prepared_registry()
        source_node_id = registry.get_source_node_id(exec_node_id)
        prepared_nodes = registry.get_prepared_ids(source_node_id)
        if (
            all(node_id in self._state.executed for node_id in prepared_nodes)
            and source_node_id not in self._state.executed
        ):
            self._state.executed.add(source_node_id)
            if source_node_id not in self._state.executed_history:
                self._state.executed_history.append(source_node_id)

    def _get_for_parent(self, exec_node_id: str) -> Optional[str]:
        source_return_id = self._state._prepared_registry().get_source_node_id(exec_node_id)
        iteration_path = self._state._get_iteration_path(exec_node_id)
        source_for_id = self._state._get_for_source_by_return_id().get(source_return_id)
        if source_for_id is not None:
            prepared_for_id = self._state._get_prepared_for_index().get((source_for_id, iteration_path))
            if prepared_for_id is not None:
                return prepared_for_id

        # The indexed source/path lookup is the normal path. The ancestor fallback only covers legacy execution
        # graphs whose durable linkage was not materialized; keep it explicit so an unexpected miss is diagnosable.
        execution_graph = self._state.execution_graph.nx_graph_flat()
        for ancestor_id in nx.ancestors(execution_graph, exec_node_id):
            source_node = self._state.execution_graph.get_node(ancestor_id)
            if isinstance(source_node, ForInvocation):
                return ancestor_id

        # An empty nested Iterate has no item execution node, so its synthetic Collect and ForReturn have no
        # execution-graph edge back to their owning For. The same indexed lookup handles this case when the
        # synthetic node has been assigned its durable parent path.
        if source_for_id is not None:
            for prepared_for_id in self._state._prepared_registry().get_prepared_ids(source_for_id):
                prepared_for_node = self._state.execution_graph.get_node(prepared_for_id)
                if not isinstance(prepared_for_node, ForInvocation) or prepared_for_node.index < 0:
                    continue
                if self._state._get_iteration_path(prepared_for_id) == iteration_path:
                    return prepared_for_id
        return None

    def _get_loop_state_for_next_iteration(
        self, for_exec_node_id: str, return_output: "ForReturnInvocationOutput"
    ) -> "LoopState":
        if return_output.state is not None:
            return return_output.state

        for_output = self._state.results.get(for_exec_node_id)
        if isinstance(for_output, ForInvocationOutput):
            return for_output.state

        return LoopState()

    def _get_ordered_for_return_outputs(
        self, for_exec_node_id: str, source_return_id: str
    ) -> list["ForReturnInvocationOutput"]:
        parent_iteration_path = self._state._get_for_parent_iteration_path(for_exec_node_id)
        prepared_return_ids = self._state._prepared_registry().get_prepared_ids(source_return_id)
        prepared_return_ids = [
            prepared_return_id
            for prepared_return_id in prepared_return_ids
            if self._state._get_iteration_path(prepared_return_id)[:-1] == parent_iteration_path
        ]
        prepared_return_ids = sorted(prepared_return_ids, key=self._state._get_iteration_path)
        return [
            output
            for prepared_return_id in prepared_return_ids
            if isinstance((output := self._state.results.get(prepared_return_id)), ForReturnInvocationOutput)
        ]

    def _finalize_for_outputs(
        self,
        for_exec_node_id: str,
        source_for_id: str,
        source_return_id: str,
        return_output: "ForReturnInvocationOutput",
    ) -> None:
        for_output = self._state.results.get(for_exec_node_id)
        if not isinstance(for_output, ForInvocationOutput):
            return

        return_outputs = self._get_ordered_for_return_outputs(for_exec_node_id, source_return_id)
        for_output.output_collection = [output.output for output in return_outputs]
        for_output.final_state = self._get_loop_state_for_next_iteration(for_exec_node_id, return_output)
        self._state._mark_loop_context_finalized(source_for_id, for_exec_node_id)

    def _try_schedule_next_for_iteration(self, exec_node_id: str, output: BaseInvocationOutput) -> Optional[str]:
        if not isinstance(output, ForReturnInvocationOutput):
            return None
        if not isinstance(self._state.execution_graph.get_node(exec_node_id), ForReturnInvocation):
            return None

        for_exec_node_id = self._get_for_parent(exec_node_id)
        if for_exec_node_id is None:
            return None

        for_node = self._state.execution_graph.get_node(for_exec_node_id)
        if not isinstance(for_node, ForInvocation):
            return None

        registry = self._state._prepared_registry()
        source_for_id = registry.get_source_node_id(for_exec_node_id)
        source_return_id = registry.get_source_node_id(exec_node_id)

        next_index = for_node.index + 1
        for_return_node = self._state.execution_graph.get_node(exec_node_id)
        assert isinstance(for_return_node, ForReturnInvocation)
        if next_index >= len(for_node.collection) or for_return_node.continue_condition is False:
            self._finalize_for_outputs(for_exec_node_id, source_for_id, source_return_id, output)
            self._state._materializer().create_nested_for_return(
                inner_for_id=source_for_id,
                prepared_inner_for_id=for_exec_node_id,
            )
            for_node.collection = []
            return for_exec_node_id

        next_state = self._get_loop_state_for_next_iteration(for_exec_node_id, output)
        parent_iteration_path = self._state._get_for_parent_iteration_path(for_exec_node_id)

        next_for_id = self._state._materializer().create_for_iteration(
            source_for_id=source_for_id,
            iteration_index=next_index,
            collection=for_node.collection,
            state=next_state,
            iteration_path=(*parent_iteration_path, next_index),
        )
        self._state.executed.discard(source_for_id)
        self._state._materializer().create_for_body_iteration(source_for_id=source_for_id, prepared_for_id=next_for_id)
        for_node.collection = []
        return None

    def _try_materialize_deferred_nested_for_body(self, exec_node_id: str) -> None:
        completed_source_id = self._state._prepared_registry().get_source_node_id(exec_node_id)
        graph = self._state.graph.nx_graph_flat()
        for source_for_id, source_node in self._state.graph.nodes.items():
            if not isinstance(source_node, ForInvocation):
                continue
            nested_body = self._state.graph._get_supported_for_nested_iterate_body(source_for_id, graph)
            nested_for_body = self._state.graph._get_supported_for_nested_for_body(source_for_id, graph)
            if nested_body is not None:
                body_path_nodes = nested_body.body_path_nodes
                deferred_node_ids = (nested_body.iterate_node_id,)
            elif nested_for_body is None:
                continue
            else:
                body_path_nodes = nested_for_body.body_path_nodes
                deferred_node_ids = nested_for_body.inner_for_ids
            if completed_source_id != source_for_id and (
                completed_source_id not in body_path_nodes
                or not any(
                    nx.has_path(graph, completed_source_id, deferred_node_id) for deferred_node_id in deferred_node_ids
                )
            ):
                continue
            for prepared_for_id in self._state._prepared_registry().get_prepared_ids(source_for_id):
                prepared_for_node = self._state.execution_graph.get_node(prepared_for_id)
                prepared_for_path = self._state._get_iteration_path(prepared_for_id)
                if isinstance(prepared_for_node, ForInvocation) and prepared_for_node.index >= 0:
                    prepared_for_path = (
                        *self._state._get_for_parent_iteration_path(prepared_for_id),
                        prepared_for_node.index,
                    )
                if prepared_for_path != self._state._get_iteration_path(exec_node_id):
                    continue
                if nested_for_body is not None:
                    if not all(
                        any(
                            self._state._get_for_parent_iteration_path(prepared_child_id) == prepared_for_path
                            for prepared_child_id in self._state._prepared_registry().get_prepared_ids(child_id)
                        )
                        for child_id in deferred_node_ids
                    ):
                        self._state._materializer().create_for_body_iteration(
                            source_for_id=source_for_id, prepared_for_id=prepared_for_id
                        )
                        return
                    continue
                if any(
                    (iterate_path := self._state._get_iteration_path(prepared_iterate_id))[: len(prepared_for_path)]
                    == prepared_for_path
                    and len(iterate_path) > len(prepared_for_path)
                    for prepared_iterate_id in self._state._prepared_registry().get_prepared_ids(deferred_node_ids[0])
                ):
                    continue
                self._state._materializer().create_for_body_iteration(
                    source_for_id=source_for_id, prepared_for_id=prepared_for_id
                )
                return

    def _decrement_child_indegree(self, child_exec_node_id: str, parent_exec_node_id: str) -> None:
        if child_exec_node_id not in self._state.indegree:
            raise KeyError(f"indegree missing for exec node {child_exec_node_id}")
        if self._state.indegree[child_exec_node_id] == 0:
            raise RuntimeError(f"indegree underflow for {child_exec_node_id} from parent {parent_exec_node_id}")
        self._state.indegree[child_exec_node_id] -= 1

    def _release_downstream_nodes(self, exec_node_id: str) -> None:
        for edge in self._state.execution_graph._get_output_edges(exec_node_id):
            child = edge.destination.node_id
            self._decrement_child_indegree(child, exec_node_id)
            self._state._try_resolve_if_node(child)
            if self._state.indegree[child] == 0:
                self.enqueue_if_ready(child)

    def queue_for(self, cls_name: str) -> Deque[str]:
        q = self._state._ready_queues.get(cls_name)
        if q is None:
            q = deque()
            self._state._ready_queues[cls_name] = q
        return q

    def remove_from_ready_queues(self, exec_node_id: str) -> None:
        for q in self._state._ready_queues.values():
            try:
                q.remove(exec_node_id)
            except ValueError:
                continue
        self._state._ready_node_ids.discard(exec_node_id)

    def enqueue_if_ready(self, exec_node_id: str) -> None:
        """Push exec_node_id to its class queue if unmet inputs == 0."""
        self._validate_exec_node_ready_state(exec_node_id)
        if self._should_skip_ready_enqueue(exec_node_id):
            return
        queue = self._get_ready_queue(exec_node_id)
        if exec_node_id in self._state._ready_node_ids:
            return
        self._state._set_prepared_exec_state(exec_node_id, "ready")
        self._insert_ready_node(queue, exec_node_id)
        self._state._ready_node_ids.add(exec_node_id)

    def get_next_node(self) -> Optional[BaseInvocation]:
        """Gets the next ready node: FIFO within class, drain class before switching."""
        while True:
            if self._state._active_class:
                q = self._state._ready_queues.get(self._state._active_class)
                while q:
                    exec_node_id = q.popleft()
                    self._state._ready_node_ids.discard(exec_node_id)
                    if exec_node_id not in self._state.executed:
                        return self._state.execution_graph.nodes[exec_node_id]
                self._state._active_class = None
                continue

            seen = set(self._state.ready_order)
            next_class = next(
                (cls_name for cls_name in self._state.ready_order if self._state._ready_queues.get(cls_name)),
                None,
            )
            if next_class is None:
                next_class = next(
                    (
                        cls_name
                        for cls_name in sorted(k for k in self._state._ready_queues.keys() if k not in seen)
                        if self._state._ready_queues[cls_name]
                    ),
                    None,
                )
            if next_class is None:
                return None

            self._state._active_class = next_class

    def complete(
        self, exec_node_id: str, output: BaseInvocationOutput
    ) -> list[tuple[BaseInvocation, BaseInvocationOutput]]:
        if exec_node_id not in self._state.execution_graph.nodes:
            return []

        self._record_completed_node(exec_node_id, output)
        finalized_for_exec_node_id = self._try_schedule_next_for_iteration(exec_node_id, output)
        self._mark_source_node_complete(exec_node_id)
        self._release_downstream_nodes(exec_node_id)
        completed_node = self._state.execution_graph.get_node(exec_node_id)
        if isinstance(completed_node, ForInvocation) and completed_node.index >= 0:
            source_for_id = self._state._prepared_registry().get_source_node_id(exec_node_id)
            nested_body = self._state.graph._get_supported_for_nested_iterate_body(
                source_for_id, self._state.graph.nx_graph_flat()
            )
            prepared_for_node = self._state.execution_graph.get_node(exec_node_id)
            prepared_for_path = self._state._get_iteration_path(exec_node_id)
            if isinstance(prepared_for_node, ForInvocation) and prepared_for_node.index >= 0:
                prepared_for_path = (
                    *self._state._get_for_parent_iteration_path(exec_node_id),
                    prepared_for_node.index,
                )
            if nested_body is not None and not any(
                (iterate_path := self._state._get_iteration_path(prepared_iterate_id))[: len(prepared_for_path)]
                == prepared_for_path
                and len(iterate_path) > len(prepared_for_path)
                for prepared_iterate_id in self._state._prepared_registry().get_prepared_ids(
                    nested_body.iterate_node_id
                )
            ):
                self._state._materializer().create_for_body_iteration(
                    source_for_id=source_for_id, prepared_for_id=exec_node_id
                )
            elif nested_body is None:
                self._try_materialize_deferred_nested_for_body(exec_node_id)
        else:
            self._try_materialize_deferred_nested_for_body(exec_node_id)
        if self._state.is_complete():
            self._state.execution_graph._invalidate_edge_indexes()
            self._state._ready_queues = {}
            self._state._ready_node_ids = set()
            self._state._active_class = None

        if finalized_for_exec_node_id is None:
            return []
        finalized_for_node = self._state.execution_graph.get_node(finalized_for_exec_node_id)
        finalized_for_output = self._state.results.get(finalized_for_exec_node_id)
        if not isinstance(finalized_for_node, ForInvocation) or not isinstance(
            finalized_for_output, ForInvocationOutput
        ):
            return []
        return [(finalized_for_node, finalized_for_output)]


class _ExecutionRuntime:
    """Provides runtime-only helpers such as iteration-path lookup and input hydration."""

    def __init__(self, state: "GraphExecutionState") -> None:
        self._state = state

    def _get_cached_iteration_path(self, exec_node_id: str) -> Optional[tuple[int, ...]]:
        return self._state._prepared_registry().get_iteration_path(exec_node_id)

    def _get_iteration_source_node_id(self, exec_node_id: str) -> Optional[str]:
        if exec_node_id not in self._state.prepared_source_mapping:
            return None
        return self._state._prepared_registry().get_source_node_id(exec_node_id)

    def _get_ordered_iterator_sources(self, source_node_id: str) -> list[str]:
        iterator_graph = self._state._iterator_graph(self._state.graph.nx_graph())
        iterator_sources = [
            node_id
            for node_id in nx.ancestors(iterator_graph, source_node_id)
            if isinstance(self._state.graph.get_node(node_id), (ForInvocation, IterateInvocation))
        ]

        topo = list(nx.topological_sort(iterator_graph))
        topo_index = {node_id: i for i, node_id in enumerate(topo)}
        iterator_sources.sort(key=lambda node_id: topo_index.get(node_id, 0))
        return iterator_sources

    def _get_iterator_exec_id(
        self, iterator_source_id: str, exec_node_id: str, execution_graph: "nx.DiGraph"
    ) -> Optional[str]:
        prepared = self._state.source_prepared_mapping.get(iterator_source_id)
        if not prepared:
            return None
        return next((pid for pid in prepared if nx.has_path(execution_graph, pid, exec_node_id)), None)

    def _build_iteration_path(self, exec_node_id: str, source_node_id: str) -> tuple[int, ...]:
        iterator_sources = self._get_ordered_iterator_sources(source_node_id)
        execution_graph = self._state.execution_graph.nx_graph()
        path: list[int] = []
        for iterator_source_id in iterator_sources:
            iterator_exec_id = self._get_iterator_exec_id(iterator_source_id, exec_node_id, execution_graph)
            if iterator_exec_id is None:
                continue
            iterator_node = self._state.execution_graph.nodes.get(iterator_exec_id)
            if isinstance(iterator_node, (ForInvocation, IterateInvocation)):
                path.append(iterator_node.index)

        node_obj = self._state.execution_graph.nodes.get(exec_node_id)
        if isinstance(node_obj, (ForInvocation, IterateInvocation)):
            path.append(node_obj.index)

        return tuple(path)

    def _cache_iteration_path(self, exec_node_id: str, iteration_path: tuple[int, ...]) -> tuple[int, ...]:
        self._state._prepared_registry().set_iteration_path(exec_node_id, iteration_path)
        return iteration_path

    def get_iteration_path(self, exec_node_id: str) -> tuple[int, ...]:
        """Best-effort outer->inner iteration indices for an execution node, stopping at collectors."""
        cached = self._get_cached_iteration_path(exec_node_id)
        if cached is not None:
            return cached

        source_node_id = self._get_iteration_source_node_id(exec_node_id)
        if source_node_id is None:
            return self._cache_iteration_path(exec_node_id, ())

        return self._cache_iteration_path(exec_node_id, self._build_iteration_path(exec_node_id, source_node_id))

    def _sort_collect_input_edges(self, input_edges: list[Edge], field_name: str) -> list[Edge]:
        matching_edges = [edge for edge in input_edges if edge.destination.field == field_name]
        matching_edges.sort(key=lambda edge: (self.get_iteration_path(edge.source.node_id), edge.source.node_id))
        return matching_edges

    def _get_copied_result_value(self, edge: Edge) -> Any:
        return copydeep(getattr(self._state.results[edge.source.node_id], edge.source.field))

    def _try_get_copied_result_value(self, edge: Edge) -> tuple[bool, Any]:
        source_output = self._state.results.get(edge.source.node_id)
        if source_output is None:
            return False, None
        return True, copydeep(getattr(source_output, edge.source.field))

    def _build_collect_collection(self, input_edges: list[Edge]) -> list[Any]:
        item_edges = self._sort_collect_input_edges(input_edges, ITEM_FIELD)
        collection_edges = self._sort_collect_input_edges(input_edges, COLLECTION_FIELD)

        output_collection = []
        for edge in collection_edges:
            source_value = self._get_copied_result_value(edge)
            if isinstance(source_value, list):
                output_collection.extend(source_value)
            else:
                output_collection.append(source_value)
        output_collection.extend(self._get_copied_result_value(edge) for edge in item_edges)
        return output_collection

    def _set_node_inputs(
        self, node: BaseInvocation, input_edges: list[Edge], allowed_fields: Optional[set[str]] = None
    ) -> None:
        for edge in input_edges:
            if allowed_fields is not None and edge.destination.field not in allowed_fields:
                continue
            if isinstance(node, CallSavedWorkflowInvocation) and is_call_saved_workflow_dynamic_input(
                edge.destination.field
            ):
                continue
            setattr(node, edge.destination.field, self._get_copied_result_value(edge))

    def _prepare_collect_inputs(self, node: "CollectInvocation", input_edges: list[Edge]) -> None:
        node.collection = self._build_collect_collection(input_edges)

    def _prepare_iterate_inputs(self, node: "IterateInvocation", input_edges: list[Edge]) -> None:
        for edge in input_edges:
            if edge.destination.field != COLLECTION_FIELD:
                continue
            source_output = self._state.results[edge.source.node_id]
            object.__setattr__(node, COLLECTION_FIELD, getattr(source_output, edge.source.field))
            return

    def _prepare_if_inputs(self, node: IfInvocation, input_edges: list[Edge]) -> None:
        selected_field = self._state._resolved_if_exec_branches.get(node.id)
        allowed_fields = {"condition", selected_field} if selected_field is not None else {"condition"}

        for edge in input_edges:
            if edge.destination.field not in allowed_fields:
                continue

            found_value, copied_value = self._try_get_copied_result_value(edge)
            if not found_value:
                iteration_path = self._state._get_iteration_path(node.id)
                raise RuntimeError(
                    "IfInvocation selected input edge points at an exec node with no stored result output: "
                    f"if_exec_id={node.id}, source_exec_id={edge.source.node_id}, iteration_path={iteration_path}"
                )

            setattr(node, edge.destination.field, copied_value)

    def _prepare_default_inputs(self, node: BaseInvocation, input_edges: list[Edge]) -> None:
        self._set_node_inputs(node, input_edges)

    def prepare_inputs(self, node: BaseInvocation) -> None:
        input_edges = self._state.execution_graph._get_input_edges(node.id)

        if isinstance(node, IterateInvocation):
            self._prepare_iterate_inputs(node, input_edges)
            return

        if isinstance(node, CollectInvocation):
            self._prepare_collect_inputs(node, input_edges)
            return

        if isinstance(node, IfInvocation):
            self._prepare_if_inputs(node, input_edges)
            return

        self._prepare_default_inputs(node, input_edges)


def get_output_field_type(node: BaseInvocation, field: str) -> Any:
    # TODO(psyche): This is awkward - if field_info is None, it means the field is not defined in the output, which
    # really should raise. The consumers of this utility expect it to never raise, and return None instead. Fixing this
    # would require some fairly significant changes and I don't want risk breaking anything.
    try:
        invocation_class = type(node)
        invocation_output_class = invocation_class.get_output_annotation()
        field_info = invocation_output_class.model_fields.get(field)
        assert field_info is not None, f"Output field '{field}' not found in {invocation_output_class.get_type()}"
        output_field_type = field_info.annotation
        return output_field_type
    except Exception:
        return None


def get_output_field_scope(node: BaseInvocation, field: str) -> OutputScope | None:
    try:
        invocation_class = type(node)
        invocation_output_class = invocation_class.get_output_annotation()
        field_info = invocation_output_class.model_fields.get(field)
        assert field_info is not None, f"Output field '{field}' not found in {invocation_output_class.get_type()}"
        json_schema_extra = field_info.json_schema_extra
        if not isinstance(json_schema_extra, dict):
            return None
        output_scope = json_schema_extra.get("output_scope")
        if output_scope is None:
            return None
        return OutputScope(output_scope)
    except Exception:
        return None


def get_input_field_type(node: BaseInvocation, field: str) -> Any:
    # TODO(psyche): This is awkward - if field_info is None, it means the field is not defined in the output, which
    # really should raise. The consumers of this utility expect it to never raise, and return None instead. Fixing this
    # would require some fairly significant changes and I don't want risk breaking anything.
    try:
        invocation_class = type(node)
        field_info = invocation_class.model_fields.get(field)
        assert field_info is not None, f"Input field '{field}' not found in {invocation_class.get_type()}"
        input_field_type = field_info.annotation
        return input_field_type
    except Exception:
        return None


def is_union_subtype(t1, t2):
    t1_args = get_args(t1)
    t2_args = get_args(t2)
    if not t1_args:
        # t1 is a single type
        return t1 in t2_args
    else:
        # t1 is a Union, check that all of its types are in t2_args
        return all(arg in t2_args for arg in t1_args)


def is_list_or_contains_list(t):
    t_args = get_args(t)

    # If the type is a List
    if get_origin(t) is list:
        return True

    # If the type is a Union
    elif t_args:
        # Check if any of the types in the Union is a List
        for arg in t_args:
            if get_origin(arg) is list:
                return True
    return False


def is_any(t: Any) -> bool:
    return t == Any or Any in get_args(t)


def extract_collection_item_types(t: Any) -> set[Any]:
    """Extracts list item types from a collection annotation, including unions containing list branches."""
    if is_any(t):
        return {Any}

    if get_origin(t) is list:
        return {arg for arg in get_args(t) if arg != NoneType}

    item_types: set[Any] = set()
    for arg in get_args(t):
        if is_any(arg):
            item_types.add(Any)
        elif get_origin(arg) is list:
            item_types.update(item_arg for item_arg in get_args(arg) if item_arg != NoneType)
    return item_types


def are_connection_types_compatible(from_type: Any, to_type: Any) -> bool:
    if not from_type or not to_type:
        return False

    # Ports are compatible
    if from_type == to_type or is_any(from_type) or is_any(to_type):
        return True

    if from_type in get_args(to_type):
        return True

    if to_type in get_args(from_type):
        return True

    # allow int -> float, pydantic will cast for us
    if from_type is int and to_type is float:
        return True

    # allow int|float -> str, pydantic will cast for us
    if (from_type is int or from_type is float) and to_type is str:
        return True

    # Prefer issubclass when both are real classes
    try:
        if isinstance(from_type, type) and isinstance(to_type, type):
            return issubclass(from_type, to_type)
    except TypeError:
        pass

    # Union-to-Union (or Union-to-non-Union) handling
    return is_union_subtype(from_type, to_type)


def are_connections_compatible(
    from_node: BaseInvocation, from_field: str, to_node: BaseInvocation, to_field: str
) -> bool:
    """Determines if a connection between fields of two nodes is compatible."""

    # TODO: handle iterators and collectors
    from_type = get_output_field_type(from_node, from_field)
    to_type = get_input_field_type(to_node, to_field)

    return are_connection_types_compatible(from_type, to_type)


T = TypeVar("T")


def copydeep(obj: T) -> T:
    """Deep-copies an object. If it is a pydantic model, use the model's copy method."""
    if isinstance(obj, BaseModel):
        return obj.model_copy(deep=True)
    return copy.deepcopy(obj)


class NodeAlreadyInGraphError(ValueError):
    pass


class InvalidEdgeError(ValueError):
    pass


class NodeNotFoundError(ValueError):
    pass


class NodeAlreadyExecutedError(ValueError):
    pass


class DuplicateNodeIdError(ValueError):
    pass


class NodeFieldNotFoundError(ValueError):
    pass


class NodeIdMismatchError(ValueError):
    pass


class CyclicalGraphError(ValueError):
    pass


class UnknownGraphValidationError(ValueError):
    pass


class NodeInputError(ValueError):
    """Raised when a node fails preparation. This occurs when a node's inputs are being set from its incomers, but an
    input fails validation.

    Attributes:
        node: The node that failed preparation. Note: only successfully set fields will be accurate. Review the error to
            determine which field caused the failure.
    """

    def __init__(self, node: BaseInvocation, e: ValidationError):
        self.original_error = e
        self.node = node
        # When preparing a node, we set each input one-at-a-time. We may thus safely assume that the first error
        # represents the first input that failed.
        self.failed_input = loc_to_dot_sep(e.errors()[0]["loc"])
        super().__init__(f"Node {node.id} has invalid incoming input for {self.failed_input}")


def loc_to_dot_sep(loc: tuple[Union[str, int], ...]) -> str:
    """Helper to pretty-print pydantic error locations as dot-separated strings.
    Taken from https://docs.pydantic.dev/latest/errors/errors/#customize-error-messages
    """
    path = ""
    for i, x in enumerate(loc):
        if isinstance(x, str):
            if i > 0:
                path += "."
            path += x
        else:
            path += f"[{x}]"
    return path


@invocation_output("iterate_output")
class IterateInvocationOutput(BaseInvocationOutput):
    """Used to connect iteration outputs. Will be expanded to a specific output."""

    item: Any = OutputField(
        description="The item being iterated over", title="Collection Item", ui_type=UIType._CollectionItem
    )
    index: int = OutputField(description="The index of the item", title="Index")
    total: int = OutputField(description="The total number of items", title="Total")


# TODO: Fill this out and move to invocations
@invocation("iterate", version="1.1.0", use_cache=False)
class IterateInvocation(BaseInvocation):
    """Iterates over a list of items"""

    collection: list[Any] = InputField(
        description="The list of items to iterate over", default=[], ui_type=UIType._Collection
    )
    index: int = InputField(description="The index, will be provided on executed iterators", default=0, ui_hidden=True)

    def invoke(self, context: InvocationContext) -> IterateInvocationOutput:
        """Produces the outputs as values"""
        return IterateInvocationOutput(item=self.collection[self.index], index=self.index, total=len(self.collection))

    def get_event_invocation(self) -> "IterateInvocation":
        event_invocation = self.model_copy()
        event_invocation.collection = []
        return event_invocation


@invocation_output("collect_output")
class CollectInvocationOutput(BaseInvocationOutput):
    collection: list[Any] = OutputField(
        description="The collection of input items", title="Collection", ui_type=UIType._Collection
    )


@invocation("collect", version="1.1.0", use_cache=False)
class CollectInvocation(BaseInvocation):
    """Collects values into a collection"""

    item: Optional[Any] = InputField(
        default=None,
        description="The item to collect (all inputs must be of the same type)",
        ui_type=UIType._CollectionItem,
        title="Collection Item",
        input=Input.Connection,
    )
    collection: list[Any] = InputField(
        description="An optional collection to append to",
        default=[],
        ui_type=UIType._Collection,
        input=Input.Connection,
    )

    def invoke(self, context: InvocationContext) -> CollectInvocationOutput:
        """Invoke with provided services and return outputs."""
        return CollectInvocationOutput(collection=copy.copy(self.collection))

    def get_event_invocation(self) -> "CollectInvocation":
        event_invocation = self.model_copy()
        event_invocation.collection = []
        return event_invocation


class AnyInvocation(BaseInvocation):
    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: GetCoreSchemaHandler) -> core_schema.CoreSchema:
        def validate_invocation(v: Any) -> "AnyInvocation":
            return InvocationRegistry.get_invocation_typeadapter().validate_python(v)

        return core_schema.no_info_plain_validator_function(validate_invocation)

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: core_schema.CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        # Nodes are too powerful, we have to make our own OpenAPI schema manually
        # No but really, because the schema is dynamic depending on loaded nodes, we need to generate it manually
        oneOf: list[dict[str, str]] = []
        names = [i.__name__ for i in InvocationRegistry.get_invocation_classes()]
        for name in sorted(names):
            oneOf.append({"$ref": f"#/components/schemas/{name}"})
        return {"oneOf": oneOf}


class AnyInvocationOutput(BaseInvocationOutput):
    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: GetCoreSchemaHandler):
        def validate_invocation_output(v: Any) -> "AnyInvocationOutput":
            return InvocationRegistry.get_output_typeadapter().validate_python(v)

        return core_schema.no_info_plain_validator_function(validate_invocation_output)

    @classmethod
    def __get_pydantic_json_schema__(
        cls, core_schema: core_schema.CoreSchema, handler: GetJsonSchemaHandler
    ) -> JsonSchemaValue:
        # Nodes are too powerful, we have to make our own OpenAPI schema manually
        # No but really, because the schema is dynamic depending on loaded nodes, we need to generate it manually

        oneOf: list[dict[str, str]] = []
        names = [i.__name__ for i in InvocationRegistry.get_output_classes()]
        for name in sorted(names):
            oneOf.append({"$ref": f"#/components/schemas/{name}"})
        return {"oneOf": oneOf}


_EdgeListMutationParams = ParamSpec("_EdgeListMutationParams")
_EdgeListMutationResult = TypeVar("_EdgeListMutationResult")


def _invalidates_edge_indexes(
    method: Callable[Concatenate["_EdgeList", _EdgeListMutationParams], _EdgeListMutationResult],
) -> Callable[Concatenate["_EdgeList", _EdgeListMutationParams], _EdgeListMutationResult]:
    @wraps(method)
    def wrapped(
        self: "_EdgeList", *args: _EdgeListMutationParams.args, **kwargs: _EdgeListMutationParams.kwargs
    ) -> _EdgeListMutationResult:
        try:
            return method(self, *args, **kwargs)
        finally:
            self._invalidate_indexes()

    return wrapped


class _EdgeList(list[Edge]):
    """A graph-owned edge list that invalidates adjacency indexes after direct mutation."""

    def __init__(self, edges: Iterable[Edge], owner: "Graph") -> None:
        super().__init__(edges)
        self._owner_ref = weakref.ref(owner)

    def _invalidate_indexes(self) -> None:
        owner_ref = getattr(self, "_owner_ref", None)
        owner = owner_ref() if owner_ref is not None else None
        if owner is not None:
            owner._invalidate_edge_indexes()

    def __getstate__(self) -> dict[str, Any]:
        return {}

    @_invalidates_edge_indexes
    def append(self, edge: Edge) -> None:
        super().append(edge)

    @_invalidates_edge_indexes
    def extend(self, edges: Iterable[Edge]) -> None:
        super().extend(edges)

    @_invalidates_edge_indexes
    def insert(self, index: int, edge: Edge) -> None:
        super().insert(index, edge)

    @_invalidates_edge_indexes
    def __setitem__(self, index: Any, value: Any) -> None:
        super().__setitem__(index, value)

    @_invalidates_edge_indexes
    def __delitem__(self, index: Any) -> None:
        super().__delitem__(index)

    @_invalidates_edge_indexes
    def __iadd__(self, edges: Iterable[Edge]):
        return super().__iadd__(edges)

    @_invalidates_edge_indexes
    def __imul__(self, value: int):
        return super().__imul__(value)

    @_invalidates_edge_indexes
    def clear(self) -> None:
        super().clear()

    @_invalidates_edge_indexes
    def pop(self, index: int = -1) -> Edge:
        return super().pop(index)

    @_invalidates_edge_indexes
    def remove(self, edge: Edge) -> None:
        super().remove(edge)

    @_invalidates_edge_indexes
    def reverse(self) -> None:
        super().reverse()

    @_invalidates_edge_indexes
    def sort(self, *, key=None, reverse: bool = False) -> None:
        super().sort(key=key, reverse=reverse)


class Graph(BaseModel):
    """A validated invocation graph made of nodes and typed edges."""

    id: str = Field(description="The id of this graph", default_factory=uuid_string)
    # TODO: use a list (and never use dict in a BaseModel) because pydantic/fastapi hates me
    nodes: dict[str, AnyInvocation] = Field(description="The nodes in this graph", default_factory=dict)
    edges: list[Edge] = Field(
        description="The connections between nodes and their fields in this graph",
        default_factory=list,
    )
    _input_edges_by_node: Optional[dict[str, list[Edge]]] = PrivateAttr(default=None)
    _output_edges_by_node: Optional[dict[str, list[Edge]]] = PrivateAttr(default=None)

    def _rebind_edge_list(self) -> None:
        object.__setattr__(self, "edges", _EdgeList(self.edges, self))
        self._invalidate_edge_indexes()

    def model_post_init(self, __context: Any) -> None:
        self._rebind_edge_list()

    def model_copy(self, *, update: Optional[dict[str, Any]] = None, deep: bool = False) -> "Graph":
        copied = super().model_copy(update=update, deep=deep)
        copied._rebind_edge_list()
        return copied

    def __copy__(self) -> "Graph":
        copied = super().__copy__()
        copied._rebind_edge_list()
        return copied

    def __deepcopy__(self, memo: Optional[dict[int, Any]] = None) -> "Graph":
        copied = super().__deepcopy__(memo)
        copied._rebind_edge_list()
        return copied

    def __setstate__(self, state: dict[str, Any]) -> None:
        super().__setstate__(state)
        self._rebind_edge_list()

    def __setattr__(self, name: str, value: Any) -> None:
        if name == "edges":
            value = _EdgeList(value, self)
            super().__setattr__(name, value)
            self._invalidate_edge_indexes()
            return
        super().__setattr__(name, value)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Graph):
            return NotImplemented
        return self.id == other.id and self.nodes == other.nodes and self.edges == other.edges

    def _invalidate_edge_indexes(self) -> None:
        self._input_edges_by_node = None
        self._output_edges_by_node = None

    def _ensure_edge_indexes(self) -> None:
        if self._input_edges_by_node is not None and self._output_edges_by_node is not None:
            return

        input_edges_by_node: dict[str, list[Edge]] = {}
        output_edges_by_node: dict[str, list[Edge]] = {}
        for edge in self.edges:
            input_edges_by_node.setdefault(edge.destination.node_id, []).append(edge)
            output_edges_by_node.setdefault(edge.source.node_id, []).append(edge)
        self._input_edges_by_node = input_edges_by_node
        self._output_edges_by_node = output_edges_by_node

    def _add_edge_to_indexes(self, edge: Edge) -> None:
        if self._input_edges_by_node is not None:
            self._input_edges_by_node.setdefault(edge.destination.node_id, []).append(edge)
        if self._output_edges_by_node is not None:
            self._output_edges_by_node.setdefault(edge.source.node_id, []).append(edge)

    def _remove_edge_from_indexes(self, edge: Edge) -> None:
        if self._input_edges_by_node is not None:
            input_edges = self._input_edges_by_node.get(edge.destination.node_id)
            if input_edges is not None:
                input_edges.remove(edge)
        if self._output_edges_by_node is not None:
            output_edges = self._output_edges_by_node.get(edge.source.node_id)
            if output_edges is not None:
                output_edges.remove(edge)

    def add_node(self, node: BaseInvocation) -> None:
        """Adds a node to a graph

        :raises NodeAlreadyInGraphError: the node is already present in the graph.
        """

        if node.id in self.nodes:
            raise NodeAlreadyInGraphError()

        self.nodes[node.id] = node

    def delete_node(self, node_id: str) -> None:
        """Deletes a node from a graph"""

        try:
            # Delete edges for this node
            input_edges = self._get_input_edges(node_id, include_loop_linkage=True)
            output_edges = self._get_output_edges(node_id, include_loop_linkage=True)

            for edge in input_edges:
                self.delete_edge(edge)

            for edge in output_edges:
                self.delete_edge(edge)

            del self.nodes[node_id]

        except NodeNotFoundError:
            pass  # Ignore, not doesn't exist (should this throw?)

    def add_edge(self, edge: Edge) -> None:
        """Adds an edge to a graph

        :raises InvalidEdgeError: the provided edge is invalid.
        """

        self._add_edge(edge, allow_inputless_source_collector=False)

    def _add_execution_edge(self, edge: Edge) -> None:
        self._add_edge(edge, allow_inputless_source_collector=True)

    def _add_edge(self, edge: Edge, allow_inputless_source_collector: bool) -> None:
        self._validate_edge(edge, allow_inputless_source_collector)
        if edge not in self.edges:
            list.append(self.edges, edge)
            self._add_edge_to_indexes(edge)
        else:
            raise InvalidEdgeError()

    def _extend_edges_unchecked(self, edges: Iterable[Edge]) -> None:
        """Adds trusted runtime edges without author-time graph validation.

        This is only for execution edges derived from an already-validated source graph. Runtime materialization
        preserves the source graph's direction and field connections, so repeating cycle, uniqueness, and type checks
        for every expanded edge is redundant and prohibitively expensive for large iterator collections.
        """
        new_edges = list(edges)
        list.extend(self.edges, new_edges)
        for edge in new_edges:
            self._add_edge_to_indexes(edge)

    def delete_edge(self, edge: Edge) -> None:
        """Deletes an edge from a graph"""

        try:
            list.remove(self.edges, edge)
            self._remove_edge_from_indexes(edge)
        except ValueError:
            pass

    def _validate_unique_node_ids(self) -> None:
        node_ids = [n.id for n in self.nodes.values()]
        seen = set()
        duplicate_node_ids = {nid for nid in node_ids if (nid in seen) or seen.add(nid)}
        if duplicate_node_ids:
            raise DuplicateNodeIdError(f"Node ids must be unique, found duplicates {duplicate_node_ids}")

    def _validate_node_id_mapping(self) -> None:
        for node_dict_id, node in self.nodes.items():
            if node_dict_id != node.id:
                raise NodeIdMismatchError(f"Node ids must match, got {node_dict_id} and {node.id}")

    def _validate_edge_nodes_and_fields(self) -> None:
        for edge in self.edges:
            self._validate_reserved_edge_fields(edge)
            source_node = self.nodes.get(edge.source.node_id, None)
            if source_node is None:
                raise NodeNotFoundError(f"Edge source node {edge.source.node_id} does not exist in the graph")

            destination_node = self.nodes.get(edge.destination.node_id, None)
            if destination_node is None:
                raise NodeNotFoundError(f"Edge destination node {edge.destination.node_id} does not exist in the graph")

            if edge.source.field not in source_node.get_output_annotation().model_fields:
                raise NodeFieldNotFoundError(
                    f"Edge source field {edge.source.field} does not exist in node {edge.source.node_id}"
                )

            if edge.destination.field not in type(destination_node).model_fields:
                if isinstance(destination_node, CallSavedWorkflowInvocation) and is_call_saved_workflow_dynamic_input(
                    edge.destination.field
                ):
                    continue
                raise NodeFieldNotFoundError(
                    f"Edge destination field {edge.destination.field} does not exist in node {edge.destination.node_id}"
                )

    def _validate_graph_is_acyclic(self) -> None:
        graph = self.nx_graph_flat()
        if not nx.is_directed_acyclic_graph(graph):
            raise CyclicalGraphError("Graph contains cycles")

    def _validate_edge_type_compatibility(self) -> None:
        for edge in self.edges:
            destination_node = self.get_node(edge.destination.node_id)
            if isinstance(destination_node, CallSavedWorkflowInvocation) and is_call_saved_workflow_dynamic_input(
                edge.destination.field
            ):
                continue
            self._validate_edge_not_to_direct_input(edge, destination_node)
            if not are_connections_compatible(
                self.get_node(edge.source.node_id),
                edge.source.field,
                destination_node,
                edge.destination.field,
            ):
                raise InvalidEdgeError(f"Edge source and target types do not match ({edge})")

    def _validate_special_nodes(self) -> None:
        # TODO: may need to validate all iterators & collectors in subgraphs so edge connections in parent graphs will be available
        self._validate_for_loop_linkages()
        for node in self.nodes.values():
            if isinstance(node, IterateInvocation):
                err = self._is_iterator_connection_valid(node.id)
                if err is not None:
                    raise InvalidEdgeError(f"Invalid iterator node ({node.id}): {err}")
            if isinstance(node, CollectInvocation):
                err = self._is_collector_connection_valid(node.id)
                if err is not None:
                    raise InvalidEdgeError(f"Invalid collector node ({node.id}): {err}")
            if isinstance(node, ForInvocation):
                err = self._is_for_connection_valid(node.id)
                if err is not None:
                    raise InvalidEdgeError(f"Invalid For node ({node.id}): {err}")
            if isinstance(node, ForReturnInvocation):
                err = self._is_for_return_connection_valid(node.id)
                if err is not None:
                    raise InvalidEdgeError(f"Invalid ForReturn node ({node.id}): {err}")

    def _validate_for_loop_linkages(self) -> None:
        """Validates the required non-data association between each For and its ForReturn."""
        for_nodes = [node for node in self.nodes.values() if isinstance(node, ForInvocation)]
        return_nodes = [node for node in self.nodes.values() if isinstance(node, ForReturnInvocation)]
        linkage_edges = self._get_loop_linkage_edges()

        for edge in linkage_edges:
            source_node = self.nodes.get(edge.source.node_id)
            destination_node = self.nodes.get(edge.destination.node_id)
            if (
                not isinstance(source_node, ForInvocation)
                or not isinstance(destination_node, ForReturnInvocation)
                or edge.source.field != LOOP_LINKAGE_FIELD
                or edge.destination.field != LOOP_LINKAGE_FIELD
            ):
                raise InvalidEdgeError(f"Invalid loop linkage ({edge})")

        for node in for_nodes:
            matching_edges = [edge for edge in linkage_edges if edge.source.node_id == node.id]
            if len(matching_edges) != 1:
                raise InvalidEdgeError(f"For '{node.id}' must have exactly one loop linkage")
        for node in return_nodes:
            matching_edges = [edge for edge in linkage_edges if edge.destination.node_id == node.id]
            if len(matching_edges) != 1:
                raise InvalidEdgeError(f"ForReturn '{node.id}' must have exactly one loop linkage")

    def validate_self(self) -> None:
        """
        Validates the graph.

        Raises an exception if the graph is invalid:
        - `DuplicateNodeIdError`
        - `NodeIdMismatchError`
        - `InvalidSubGraphError`
        - `NodeNotFoundError`
        - `NodeFieldNotFoundError`
        - `CyclicalGraphError`
        - `InvalidEdgeError`
        """

        self._validate_unique_node_ids()
        self._validate_node_id_mapping()
        self._validate_edge_nodes_and_fields()
        self._validate_graph_is_acyclic()
        self._validate_edge_type_compatibility()
        self._validate_special_nodes()
        return None

    def is_valid(self) -> bool:
        """
        Checks if the graph is valid.

        Raises `UnknownGraphValidationError` if there is a problem validating the graph (not a validation error).
        """
        try:
            self.validate_self()
            return True
        except (
            DuplicateNodeIdError,
            NodeIdMismatchError,
            NodeNotFoundError,
            NodeFieldNotFoundError,
            CyclicalGraphError,
            InvalidEdgeError,
        ):
            return False
        except Exception as e:
            raise UnknownGraphValidationError(f"Problem validating graph {e}") from e

    def _is_destination_field_Any(self, edge: Edge) -> bool:
        """Checks if the destination field for an edge is of type typing.Any"""
        return get_input_field_type(self.get_node(edge.destination.node_id), edge.destination.field) == Any

    def _is_destination_field_list_of_Any(self, edge: Edge) -> bool:
        """Checks if the destination field for an edge is of type typing.Any"""
        return get_input_field_type(self.get_node(edge.destination.node_id), edge.destination.field) == list[Any]

    def _get_edge_nodes(self, edge: Edge) -> tuple[BaseInvocation, BaseInvocation]:
        try:
            return self.get_node(edge.source.node_id), self.get_node(edge.destination.node_id)
        except NodeNotFoundError:
            raise InvalidEdgeError(f"One or both nodes don't exist ({edge})")

    def _validate_edge_destination_uniqueness(self, edge: Edge, destination_node: BaseInvocation) -> None:
        input_edges = self._get_input_edges(edge.destination.node_id, edge.destination.field)
        if len(input_edges) > 0 and (
            not isinstance(destination_node, CollectInvocation) or edge.destination.field != ITEM_FIELD
        ):
            raise InvalidEdgeError(f"Edge already exists ({edge})")

    def _validate_edge_would_not_create_cycle(self, edge: Edge) -> None:
        graph = self.nx_graph_flat()
        graph.add_edge(edge.source.node_id, edge.destination.node_id)
        if not nx.is_directed_acyclic_graph(graph):
            raise InvalidEdgeError(f"Edge creates a cycle in the graph ({edge})")

    def _validate_edge_field_compatibility(
        self, edge: Edge, source_node: BaseInvocation, destination_node: BaseInvocation
    ) -> None:
        if isinstance(destination_node, CallSavedWorkflowInvocation) and is_call_saved_workflow_dynamic_input(
            edge.destination.field
        ):
            return
        self._validate_edge_not_to_direct_input(edge, destination_node)
        if not are_connections_compatible(source_node, edge.source.field, destination_node, edge.destination.field):
            raise InvalidEdgeError(f"Field types are incompatible ({edge})")

    def _validate_edge_not_to_direct_input(self, edge: Edge, destination_node: BaseInvocation) -> None:
        destination_field = type(destination_node).model_fields.get(edge.destination.field)
        if destination_field is not None:
            json_schema_extra = destination_field.json_schema_extra
            if isinstance(json_schema_extra, dict) and json_schema_extra.get("input") == Input.Direct:
                raise InvalidEdgeError(f"Cannot connect to direct input ({edge})")

    def _validate_reserved_edge_fields(self, edge: Edge) -> None:
        if edge.type == "default" and (
            edge.source.field == LOOP_LINKAGE_FIELD or edge.destination.field == LOOP_LINKAGE_FIELD
        ):
            raise InvalidEdgeError(f"The loop_linkage field must use a loop_linkage edge ({edge})")

    def _validate_loop_linkage_edge(
        self, edge: Edge, source_node: BaseInvocation, destination_node: BaseInvocation
    ) -> None:
        if (
            not isinstance(source_node, ForInvocation)
            or not isinstance(destination_node, ForReturnInvocation)
            or edge.source.field != LOOP_LINKAGE_FIELD
            or edge.destination.field != LOOP_LINKAGE_FIELD
        ):
            raise InvalidEdgeError(f"Invalid loop linkage ({edge})")

        if any(existing_edge.source.node_id == source_node.id for existing_edge in self._get_loop_linkage_edges()):
            raise InvalidEdgeError(f"For node already has a loop linkage ({edge})")
        if any(
            existing_edge.destination.node_id == destination_node.id for existing_edge in self._get_loop_linkage_edges()
        ):
            raise InvalidEdgeError(f"ForReturn node already has a loop linkage ({edge})")

    def _validate_iterator_edge_rules(
        self, edge: Edge, source_node: BaseInvocation, destination_node: BaseInvocation
    ) -> None:
        if isinstance(destination_node, IterateInvocation) and edge.destination.field == COLLECTION_FIELD:
            err = self._is_iterator_connection_valid(edge.destination.node_id, new_input=edge.source)
            if err is not None:
                raise InvalidEdgeError(f"Iterator input type does not match iterator output type ({edge}): {err}")

        if isinstance(source_node, IterateInvocation) and edge.source.field == ITEM_FIELD:
            err = self._is_iterator_connection_valid(edge.source.node_id, new_output=edge.destination)
            if err is not None:
                raise InvalidEdgeError(f"Iterator output type does not match iterator input type ({edge}): {err}")

    def _validate_collector_edge_rules(
        self,
        edge: Edge,
        source_node: BaseInvocation,
        destination_node: BaseInvocation,
        allow_inputless_source_collector: bool,
    ) -> None:
        if isinstance(destination_node, CollectInvocation) and edge.destination.field in (ITEM_FIELD, COLLECTION_FIELD):
            err = self._is_collector_connection_valid(
                edge.destination.node_id, new_input=edge.source, new_input_field=edge.destination.field
            )
            if err is not None:
                raise InvalidEdgeError(f"Collector output type does not match collector input type ({edge}): {err}")

        if (
            isinstance(source_node, CollectInvocation)
            and edge.source.field == COLLECTION_FIELD
            and not self._is_destination_field_list_of_Any(edge)
            and not self._is_destination_field_Any(edge)
        ):
            if allow_inputless_source_collector and not any(
                edge.destination.node_id == source_node.id for edge in self.edges
            ):
                return
            err = self._is_collector_connection_valid(edge.source.node_id, new_output=edge.destination)
            if err is not None:
                raise InvalidEdgeError(f"Collector input type does not match collector output type ({edge}): {err}")

    def _validate_edge(self, edge: Edge, allow_inputless_source_collector: bool = False):
        """Validates that a new edge doesn't create a cycle in the graph"""
        self._validate_reserved_edge_fields(edge)
        source_node, destination_node = self._get_edge_nodes(edge)
        if edge.type == "loop_linkage":
            self._validate_loop_linkage_edge(edge, source_node, destination_node)
            return
        self._validate_edge_destination_uniqueness(edge, destination_node)
        self._validate_edge_would_not_create_cycle(edge)
        self._validate_edge_field_compatibility(edge, source_node, destination_node)
        self._validate_iterator_edge_rules(edge, source_node, destination_node)
        self._validate_collector_edge_rules(edge, source_node, destination_node, allow_inputless_source_collector)

    def has_node(self, node_id: str) -> bool:
        """Determines whether or not a node exists in the graph."""
        try:
            _ = self.get_node(node_id)
            return True
        except NodeNotFoundError:
            return False

    def get_node(self, node_id: str) -> BaseInvocation:
        """Gets a node from the graph."""
        try:
            return self.nodes[node_id]
        except KeyError as e:
            raise NodeNotFoundError(f"Node {node_id} not found in graph") from e

    def update_node(self, node_id: str, new_node: BaseInvocation) -> None:
        """Updates a node in the graph."""
        node = self.nodes[node_id]

        # Ensure the node type matches the new node
        if type(node) is not type(new_node):
            raise TypeError(f"Node {node_id} is type {type(node)} but new node is type {type(new_node)}")

        # Ensure the new id is either the same or is not in the graph
        if new_node.id != node.id and self.has_node(new_node.id):
            raise NodeAlreadyInGraphError(f"Node with id {new_node.id} already exists in graph")

        # Set the new node in the graph
        self.nodes[new_node.id] = new_node
        if new_node.id != node.id:
            input_edges = self._get_input_edges(node_id, include_loop_linkage=True)
            output_edges = self._get_output_edges(node_id, include_loop_linkage=True)

            # Delete node and all edges
            self.delete_node(node_id)

            # Create new edges for each input and output
            for edge in input_edges:
                self.add_edge(
                    Edge(
                        type=edge.type,
                        source=edge.source,
                        destination=EdgeConnection(node_id=new_node.id, field=edge.destination.field),
                    )
                )

            for edge in output_edges:
                self.add_edge(
                    Edge(
                        type=edge.type,
                        source=EdgeConnection(node_id=new_node.id, field=edge.source.field),
                        destination=edge.destination,
                    )
                )

    def _get_input_edges(
        self, node_id: str, field: Optional[str] = None, *, include_loop_linkage: bool = False
    ) -> list[Edge]:
        """Gets all input edges for a node. If field is provided, only edges to that field are returned."""

        self._ensure_edge_indexes()
        assert self._input_edges_by_node is not None
        edges = self._input_edges_by_node.get(node_id, [])
        if not include_loop_linkage:
            edges = [edge for edge in edges if edge.type == "default"]

        if field is None:
            return list(edges)

        filtered_edges = [e for e in edges if e.destination.field == field]

        return filtered_edges

    def _get_output_edges(
        self, node_id: str, field: Optional[str] = None, *, include_loop_linkage: bool = False
    ) -> list[Edge]:
        """Gets all output edges for a node. If field is provided, only edges from that field are returned."""
        self._ensure_edge_indexes()
        assert self._output_edges_by_node is not None
        edges = self._output_edges_by_node.get(node_id, [])
        if not include_loop_linkage:
            edges = [edge for edge in edges if edge.type == "default"]

        if field is None:
            return list(edges)

        filtered_edges = [e for e in edges if e.source.field == field]

        return filtered_edges

    def _get_loop_linkage_edges(self, node_id: str | None = None) -> list[Edge]:
        edges = [edge for edge in self.edges if edge.type == "loop_linkage"]
        if node_id is None:
            return edges
        return [edge for edge in edges if edge.source.node_id == node_id or edge.destination.node_id == node_id]

    def _get_linked_for_return_id(self, for_node_id: str) -> str | None:
        linkage_edges = [
            edge for edge in self._get_loop_linkage_edges(for_node_id) if edge.source.node_id == for_node_id
        ]
        if len(linkage_edges) != 1:
            return None
        return linkage_edges[0].destination.node_id

    def _get_linked_for_id(self, return_node_id: str) -> str | None:
        linkage_edges = [
            edge for edge in self._get_loop_linkage_edges(return_node_id) if edge.destination.node_id == return_node_id
        ]
        if len(linkage_edges) != 1:
            return None
        return linkage_edges[0].source.node_id

    def _get_for_iteration_output_edges(self, node_id: str) -> list[Edge]:
        node = self.get_node(node_id)
        return [
            edge
            for edge in self._get_output_edges(node_id)
            if get_output_field_scope(node, edge.source.field) == OutputScope.Iteration
        ]

    def _get_for_final_output_edges(self, node_id: str) -> list[Edge]:
        node = self.get_node(node_id)
        return [
            edge
            for edge in self._get_output_edges(node_id)
            if get_output_field_scope(node, edge.source.field) == OutputScope.Final
        ]

    def _get_for_reachable_body_nodes(self, iteration_edges: list[Edge], graph: "nx.DiGraph") -> set[str]:
        body_nodes: set[str] = set()
        for edge in iteration_edges:
            body_nodes.add(edge.destination.node_id)
            body_nodes.update(nx.descendants(graph, edge.destination.node_id))
        return body_nodes

    def _get_for_body_path_nodes(
        self, reachable_body_nodes: set[str], return_node_id: str, graph: "nx.DiGraph"
    ) -> set[str]:
        return (reachable_body_nodes & nx.ancestors(graph, return_node_id)) | {return_node_id}

    def _get_for_body_path_to_return(self, node_id: str, graph: "nx.DiGraph") -> tuple[set[str], str] | None:
        """Resolve the runtime body path to its owning ForReturn.

        The loop linkage identifies the return endpoint. The ordinary body graph still determines whether that return
        is reachable from an iteration output and which nodes belong to the body.
        """
        iteration_edges = self._get_for_iteration_output_edges(node_id)
        if len(iteration_edges) == 0:
            return None

        reachable_body_nodes = self._get_for_reachable_body_nodes(iteration_edges, graph)
        return_node_id = self._get_linked_for_return_id(node_id)
        if return_node_id is None or return_node_id not in reachable_body_nodes:
            return None

        return self._get_for_body_path_nodes(reachable_body_nodes, return_node_id, graph), return_node_id

    def _get_supported_for_nested_iterate_body(
        self, node_id: str, graph: "nx.DiGraph"
    ) -> _SupportedNestedIterateBody | None:
        """Return the bounded internal Iterate body contract, if this For uses it.

        Supported shape::

            For.item -> Iterate.item -> body -> Collect.item
                                             Collect.collection -> ForReturn.output

        The Iterate and Collect nodes are scheduler-managed, so no other branch or final For output may escape this
        body contract.
        """
        body_path_to_return = self._get_for_body_path_to_return(node_id, graph)
        if body_path_to_return is None:
            return None

        body_path_nodes, return_node_id = body_path_to_return
        iterate_node_ids = [
            body_node_id
            for body_node_id in body_path_nodes
            if isinstance(self.get_node(body_node_id), IterateInvocation)
        ]
        collect_node_ids = [
            body_node_id
            for body_node_id in body_path_nodes
            if isinstance(self.get_node(body_node_id), CollectInvocation)
        ]
        if len(iterate_node_ids) != 1 or len(collect_node_ids) != 1:
            return None

        iterate_node_id = iterate_node_ids[0]
        collect_node_id = collect_node_ids[0]
        if not nx.has_path(graph, iterate_node_id, collect_node_id):
            return None
        iterate_input_edges = self._get_input_edges(iterate_node_id, COLLECTION_FIELD)
        if len(iterate_input_edges) != 1:
            return None
        iterate_input_source_id = iterate_input_edges[0].source.node_id
        if iterate_input_source_id != node_id and iterate_input_source_id not in body_path_nodes:
            return None

        return_output_edges = self._get_input_edges(return_node_id, "output")
        if len(return_output_edges) != 1 or (
            return_output_edges[0].source.node_id != collect_node_id
            or return_output_edges[0].source.field != COLLECTION_FIELD
        ):
            return None
        if any(
            edge.destination.field != "output"
            and edge.destination.field != "continue_condition"
            and (edge.destination.field != "state" or edge.source.node_id != node_id or edge.source.field != "state")
            for edge in self._get_input_edges(return_node_id)
        ):
            return None

        if self._get_input_edges(collect_node_id, COLLECTION_FIELD):
            return None
        collect_item_edges = self._get_input_edges(collect_node_id, ITEM_FIELD)
        if len(collect_item_edges) != 1:
            return None
        collect_item_source_id = collect_item_edges[0].source.node_id
        if not nx.has_path(graph, iterate_node_id, collect_item_source_id):
            return None

        for body_node_id in body_path_nodes:
            if body_node_id in {iterate_node_id, collect_node_id, return_node_id}:
                continue
            if not nx.has_path(graph, body_node_id, collect_node_id):
                return None
            if not (
                nx.has_path(graph, body_node_id, iterate_node_id) or nx.has_path(graph, iterate_node_id, body_node_id)
            ):
                return None

        return _SupportedNestedIterateBody(
            body_path_nodes=body_path_nodes,
            return_node_id=return_node_id,
            iterate_node_id=iterate_node_id,
            collect_node_id=collect_node_id,
        )

    def _get_supported_for_nested_for_body(self, node_id: str, graph: "nx.DiGraph") -> _SupportedNestedForBody | None:
        """Returns the supported recursive nested For contract, if this For uses it.

        Each direct child loop has its own ForReturn. A single child may close the parent directly or through a
        continuation. Multiple independent child loops must all feed an ordinary parent-scoped continuation, which acts
        as an explicit fan-in barrier after every child has finalized for the current parent iteration.

        Accepted shape (the child body can recursively contain this same shape)::

            outer For -> preparation -> inner For(s) -> continuation -> outer ForReturn
                                           |    ^
                                           v    |
                                         child body -> inner ForReturn

        Preparation, child bodies, and continuation partition the reachable outer body. Only finalized child outputs
        may cross into the continuation; iteration outputs stay inside their owning child body.
        """
        outer_node = self.get_node(node_id)
        if not isinstance(outer_node, ForInvocation):
            return None

        iteration_edges = self._get_for_iteration_output_edges(node_id)
        if len(iteration_edges) == 0:
            return None
        reachable_body_nodes = self._get_for_reachable_body_nodes(iteration_edges, graph)
        reachable_return_ids = [
            body_node_id
            for body_node_id in reachable_body_nodes
            if isinstance(self.get_node(body_node_id), ForReturnInvocation)
        ]
        outer_return_id = self._get_linked_for_return_id(node_id)
        if outer_return_id is None or outer_return_id not in reachable_return_ids:
            return None

        nested_for_ids = [
            body_node_id
            for body_node_id in reachable_body_nodes
            if isinstance(self.get_node(body_node_id), ForInvocation) and body_node_id != node_id
        ]
        direct_nested_for_ids = [
            nested_for_id
            for nested_for_id in nested_for_ids
            if not any(
                other_nested_for_id != nested_for_id and nx.has_path(graph, other_nested_for_id, nested_for_id)
                for other_nested_for_id in nested_for_ids
            )
        ]
        if not direct_nested_for_ids:
            return None
        direct_nested_for_ids = tuple(
            nested_for_id for nested_for_id in nx.topological_sort(graph) if nested_for_id in direct_nested_for_ids
        )

        inner_body_path_nodes: set[str] = set()
        for inner_for_id in direct_nested_for_ids:
            inner_for = self.get_node(inner_for_id)
            assert isinstance(inner_for, ForInvocation)
            inner_return_id = self._get_linked_for_return_id(inner_for_id)
            if inner_return_id is None:
                return None

            inner_body_path_to_return = self._get_for_body_path_to_return(inner_for_id, graph)
            if inner_body_path_to_return is None:
                return None
            child_body_path_nodes, resolved_inner_return_id = inner_body_path_to_return
            if resolved_inner_return_id != inner_return_id:
                return None
            if inner_return_id not in reachable_return_ids:
                return None

            inner_nested_for_ids = [
                body_node_id
                for body_node_id in child_body_path_nodes
                if isinstance(self.get_node(body_node_id), ForInvocation)
            ]
            if any(
                isinstance(self.get_node(body_node_id), IterateInvocation) for body_node_id in child_body_path_nodes
            ):
                return None
            inner_nested_body = (
                self._get_supported_for_nested_for_body(inner_for_id, graph) if inner_nested_for_ids else None
            )
            if inner_nested_for_ids and inner_nested_body is None:
                return None
            if inner_nested_body is not None:
                child_body_path_nodes = child_body_path_nodes | inner_nested_body.body_path_nodes
            if any(
                edge.destination.field == "state"
                and edge.source.node_id != inner_for_id
                and edge.source.node_id not in child_body_path_nodes
                for edge in self._get_input_edges(inner_return_id)
            ):
                return None

            inner_collection_edges = self._get_input_edges(inner_for_id, COLLECTION_FIELD)
            if len(inner_collection_edges) != 1:
                return None
            inner_collection_source_id = inner_collection_edges[0].source.node_id
            if inner_collection_source_id != node_id and inner_collection_source_id not in reachable_body_nodes:
                return None

            inner_body_path_nodes.update(child_body_path_nodes)

        if set(reachable_return_ids) - inner_body_path_nodes != {outer_return_id}:
            return None

        outer_output_edges = self._get_input_edges(outer_return_id, "output")
        if len(outer_output_edges) != 1:
            return None
        if any(
            edge.destination.field != "output"
            and edge.destination.field != "continue_condition"
            and (edge.destination.field != "state" or edge.source.node_id != node_id or edge.source.field != "state")
            for edge in self._get_input_edges(outer_return_id)
        ):
            return None

        outer_preparation_nodes = {
            body_node_id
            for inner_for_id in direct_nested_for_ids
            for body_node_id in reachable_body_nodes & nx.ancestors(graph, inner_for_id)
        } | set(direct_nested_for_ids)
        inner_final_descendants: set[str] = set()
        for inner_for_id in direct_nested_for_ids:
            for edge in self._get_for_final_output_edges(inner_for_id):
                inner_final_descendants.add(edge.destination.node_id)
                inner_final_descendants.update(nx.descendants(graph, edge.destination.node_id))
        continuation_nodes = reachable_body_nodes - outer_preparation_nodes - inner_body_path_nodes - {outer_return_id}
        if any(
            edge.destination.field == "continue_condition"
            and edge.source.node_id != node_id
            and edge.source.node_id not in continuation_nodes
            and not (
                edge.source.node_id in direct_nested_for_ids
                and edge.source.field in {"output_collection", "final_state"}
            )
            for edge in self._get_input_edges(outer_return_id)
        ):
            return None
        if not continuation_nodes <= inner_final_descendants:
            return None
        if any(not nx.has_path(graph, body_node_id, outer_return_id) for body_node_id in continuation_nodes):
            return None
        if any(
            isinstance(self.get_node(body_node_id), (ForInvocation, IterateInvocation, ForReturnInvocation))
            for body_node_id in continuation_nodes
        ):
            return None
        if any(
            edge.source.node_id in inner_body_path_nodes
            or (edge.source.node_id in direct_nested_for_ids and edge.source.field != "output_collection")
            for body_node_id in continuation_nodes
            for edge in self._get_input_edges(body_node_id)
        ):
            return None
        output_source_id = outer_output_edges[0].source.node_id
        if output_source_id in direct_nested_for_ids:
            if (
                len(direct_nested_for_ids) != 1
                or outer_output_edges[0].source.field != "output_collection"
                or continuation_nodes
            ):
                return None
        elif output_source_id not in continuation_nodes:
            return None

        if any(
            not any(
                edge.destination.node_id in continuation_nodes or edge.destination.node_id == outer_return_id
                for edge in self._get_for_final_output_edges(inner_for_id)
            )
            for inner_for_id in direct_nested_for_ids
        ):
            return None

        allowed_body_nodes = outer_preparation_nodes | inner_body_path_nodes | continuation_nodes | {outer_return_id}
        if reachable_body_nodes != allowed_body_nodes:
            return None

        if any(
            isinstance(self.get_node(body_node_id), (ForInvocation, IterateInvocation))
            for body_node_id in outer_preparation_nodes
            if body_node_id not in direct_nested_for_ids
        ):
            return None

        for body_node_id in allowed_body_nodes - {outer_return_id, *direct_nested_for_ids}:
            if body_node_id in inner_body_path_nodes or body_node_id in continuation_nodes:
                continue
            if not any(nx.has_path(graph, body_node_id, inner_for_id) for inner_for_id in direct_nested_for_ids):
                return None
        return _SupportedNestedForBody(
            body_path_nodes=frozenset(allowed_body_nodes),
            outer_return_id=outer_return_id,
            inner_for_ids=direct_nested_for_ids,
            continuation_nodes=frozenset(continuation_nodes),
        )

    def _get_for_nested_for_continuation_nodes(self, nested_body: _SupportedNestedForBody) -> set[str]:
        return set(nested_body.continuation_nodes)

    def _is_for_connection_valid(self, node_id: str) -> str | None:
        if len(self._get_input_edges(node_id, COLLECTION_FIELD)) > 1:
            return "For loop may have only one collection input edge"
        if len(self._get_input_edges(node_id, "state")) > 1:
            return "For loop may have only one state input edge"

        iteration_edges = self._get_for_iteration_output_edges(node_id)
        if len(iteration_edges) == 0:
            return "For loop must have at least one iteration output edge"

        graph = self.nx_graph_flat()
        reachable_body_nodes = self._get_for_reachable_body_nodes(iteration_edges, graph)

        nested_for_node_ids = [
            body_node_id
            for body_node_id in reachable_body_nodes
            if body_node_id != node_id
            and isinstance(self.get_node(body_node_id), ForInvocation)
            and not any(
                other_body_node_id != body_node_id
                and isinstance(self.get_node(other_body_node_id), ForInvocation)
                and nx.has_path(graph, other_body_node_id, body_node_id)
                for other_body_node_id in reachable_body_nodes
            )
        ]
        nested_body = self._get_supported_for_nested_for_body(node_id, graph) if nested_for_node_ids else None
        if nested_for_node_ids and nested_body is None:
            return "Nested For loops require one linked inner For with a matching ForReturn"

        if nested_body is not None:
            body_path_nodes = nested_body.body_path_nodes
            return_node_id = nested_body.outer_return_id
        else:
            return_node_id = self._get_linked_for_return_id(node_id)
            if return_node_id is None or return_node_id not in reachable_body_nodes:
                return "For loop body must expose exactly one matching ForReturn"
            body_path_nodes = self._get_for_body_path_nodes(reachable_body_nodes, return_node_id, graph)

        unterminated_body_nodes = reachable_body_nodes - body_path_nodes
        if len(unterminated_body_nodes) > 0:
            return "For loop body paths must terminate at the matching ForReturn and not escape the loop body"

        if any(isinstance(self.get_node(body_node_id), IterateInvocation) for body_node_id in body_path_nodes):
            if self._get_supported_for_nested_iterate_body(node_id, graph) is None:
                return "Iterate nodes inside For loop bodies are unsupported"

        for body_node_id in body_path_nodes:
            for edge in self._get_input_edges(body_node_id):
                source_node_id = edge.source.node_id
                if source_node_id == node_id or source_node_id in body_path_nodes:
                    continue
                active_source_scope = nx.ancestors(graph, source_node_id) | {source_node_id}
                if any(isinstance(self.get_node(source_id), IterateInvocation) for source_id in active_source_scope):
                    return "For loop body does not support iterator-derived external inputs"

        for edge in self._get_for_final_output_edges(node_id):
            if edge.destination.node_id in body_path_nodes or nx.has_path(
                graph, edge.destination.node_id, return_node_id
            ):
                return "final-scoped For outputs cannot feed the loop body"

        for body_node_id in body_path_nodes:
            if body_node_id == return_node_id:
                continue
            for edge in self._get_output_edges(body_node_id):
                if edge.destination.node_id not in body_path_nodes:
                    return "For loop body paths must not escape before the matching ForReturn"

        return None

    def _is_for_return_connection_valid(self, node_id: str) -> str | None:
        graph = self.nx_graph_flat()
        matching_for_node_ids = []
        for loop_node_id, loop_node in self.nodes.items():
            if not isinstance(loop_node, ForInvocation):
                continue
            body_path_to_return = self._get_for_body_path_to_return(loop_node_id, graph)
            if body_path_to_return is None:
                continue
            body_path_nodes, return_node_id = body_path_to_return
            if node_id == return_node_id and node_id in body_path_nodes:
                matching_for_node_ids.append(loop_node_id)

        if len(matching_for_node_ids) != 1:
            return "ForReturn must belong to exactly one matching For"

        if (
            len(self._get_input_edges(node_id, "output")) > 1
            or len(self._get_input_edges(node_id, "state")) > 1
            or len(self._get_input_edges(node_id, "continue_condition")) > 1
        ):
            return "ForReturn may have only one input edge per field"
        return None

    def _is_iterator_connection_valid(
        self,
        node_id: str,
        new_input: Optional[EdgeConnection] = None,
        new_output: Optional[EdgeConnection] = None,
    ) -> str | None:
        inputs = [e.source for e in self._get_input_edges(node_id, COLLECTION_FIELD)]
        outputs = [e.destination for e in self._get_output_edges(node_id, ITEM_FIELD)]

        if new_input is not None:
            inputs.append(new_input)
        if new_output is not None:
            outputs.append(new_output)

        return self._validate_iterator_connections(inputs, outputs)

    def _validate_iterator_connections(self, inputs: list[EdgeConnection], outputs: list[EdgeConnection]) -> str | None:
        presence_error = self._validate_iterator_input_presence(inputs)
        if presence_error is not None:
            return presence_error

        input_node = self.get_node(inputs[0].node_id)
        input_field_type = get_output_field_type(input_node, inputs[0].field)
        output_field_types = self._get_iterator_output_field_types(outputs)

        input_type_error = self._validate_iterator_input_type(input_field_type)
        if input_type_error is not None:
            return input_type_error

        output_type_error = self._validate_iterator_output_types(input_field_type, output_field_types)
        if output_type_error is not None:
            return output_type_error

        return self._validate_iterator_collector_input(input_node, output_field_types)

    def _validate_iterator_input_presence(self, inputs: list[EdgeConnection]) -> str | None:
        if len(inputs) == 0:
            return "Iterator must have a collection input edge"
        if len(inputs) > 1:
            return "Iterator may only have one input edge"
        return None

    def _get_iterator_output_field_types(self, outputs: list[EdgeConnection]) -> list[Any]:
        return [get_input_field_type(self.get_node(e.node_id), e.field) for e in outputs]

    def _validate_iterator_input_type(self, input_field_type: Any) -> str | None:
        if get_origin(input_field_type) is not list:
            return "Iterator input must be a collection"
        return None

    def _validate_iterator_output_types(self, input_field_type: Any, output_field_types: list[Any]) -> str | None:
        input_field_item_type = get_args(input_field_type)[0]
        if not all(are_connection_types_compatible(input_field_item_type, t) for t in output_field_types):
            return "Iterator outputs must connect to an input with a matching type"
        return None

    def _validate_iterator_collector_input(
        self, input_node: BaseInvocation, output_field_types: list[Any]
    ) -> str | None:
        if not isinstance(input_node, CollectInvocation):
            return None

        input_root_type = self._get_collector_input_root_type(input_node.id)
        if input_root_type is None:
            return "Iterator input collector must have at least one item or collection input edge"
        if not all(are_connection_types_compatible(input_root_type, t) for t in output_field_types):
            return "Iterator collection type must match all iterator output types"
        return None

    def _resolve_collector_input_types(self, node_id: str, visited: Optional[set[str]] = None) -> set[Any]:
        """Resolves possible item types for a collector's inputs, recursively following chained collectors."""
        visited = visited or set()
        if node_id in visited:
            return set()
        visited.add(node_id)

        input_types: set[Any] = set()

        for edge in self._get_input_edges(node_id, ITEM_FIELD):
            input_field_type = get_output_field_type(self.get_node(edge.source.node_id), edge.source.field)
            resolved_types = [input_field_type] if get_origin(input_field_type) is None else get_args(input_field_type)
            input_types.update(t for t in resolved_types if t != NoneType)

        for edge in self._get_input_edges(node_id, COLLECTION_FIELD):
            source_node = self.get_node(edge.source.node_id)
            if isinstance(source_node, CollectInvocation) and edge.source.field == COLLECTION_FIELD:
                input_types.update(self._resolve_collector_input_types(source_node.id, visited.copy()))
                continue

            input_field_type = get_output_field_type(source_node, edge.source.field)
            input_types.update(extract_collection_item_types(input_field_type))

        return input_types

    def _get_type_tree_root_types(self, input_types: set[Any]) -> list[Any]:
        type_tree = nx.DiGraph()
        type_tree.add_nodes_from(input_types)
        type_tree.add_edges_from([e for e in itertools.permutations(input_types, 2) if issubclass(e[1], e[0])])
        type_degrees = type_tree.in_degree(type_tree.nodes)
        return [t[0] for t in type_degrees if t[1] == 0]  # type: ignore

    def _get_collector_input_root_type(self, node_id: str) -> Any | None:
        input_types = self._resolve_collector_input_types(node_id)
        non_any_input_types = {t for t in input_types if t != Any}
        if len(non_any_input_types) == 0 and Any in input_types:
            return Any
        if len(non_any_input_types) == 0:
            return None

        root_types = self._get_type_tree_root_types(non_any_input_types)
        if len(root_types) != 1:
            return Any
        return root_types[0]

    def _get_collector_connections(
        self,
        node_id: str,
        new_input: Optional[EdgeConnection] = None,
        new_input_field: Optional[str] = None,
        new_output: Optional[EdgeConnection] = None,
    ) -> tuple[list[EdgeConnection], list[EdgeConnection], list[EdgeConnection]]:
        item_inputs = [e.source for e in self._get_input_edges(node_id, ITEM_FIELD)]
        collection_inputs = [e.source for e in self._get_input_edges(node_id, COLLECTION_FIELD)]
        outputs = [e.destination for e in self._get_output_edges(node_id, COLLECTION_FIELD)]

        if new_input is not None:
            field = new_input_field or ITEM_FIELD
            if field == ITEM_FIELD:
                item_inputs.append(new_input)
            elif field == COLLECTION_FIELD:
                collection_inputs.append(new_input)

        if new_output is not None:
            outputs.append(new_output)

        return item_inputs, collection_inputs, outputs

    def _get_collector_port_types(
        self,
        item_inputs: list[EdgeConnection],
        collection_inputs: list[EdgeConnection],
        outputs: list[EdgeConnection],
    ) -> tuple[list[Any], list[Any], list[Any]]:
        item_input_field_types = [get_output_field_type(self.get_node(e.node_id), e.field) for e in item_inputs]
        collection_input_field_types = [
            get_output_field_type(self.get_node(e.node_id), e.field) for e in collection_inputs
        ]
        output_field_types = [get_input_field_type(self.get_node(e.node_id), e.field) for e in outputs]
        return item_input_field_types, collection_input_field_types, output_field_types

    def _resolve_item_input_types(self, item_input_field_types: list[Any]) -> set[Any]:
        return {
            resolved_type
            for input_field_type in item_input_field_types
            for resolved_type in (
                [input_field_type] if get_origin(input_field_type) is None else get_args(input_field_type)
            )
            if resolved_type != NoneType
        }

    def _resolve_collection_input_types(
        self, collection_inputs: list[EdgeConnection], collection_input_field_types: list[Any]
    ) -> set[Any]:
        input_field_types: set[Any] = set()
        for input_conn, input_field_type in zip(collection_inputs, collection_input_field_types, strict=False):
            source_node = self.get_node(input_conn.node_id)
            if isinstance(source_node, CollectInvocation) and input_conn.field == COLLECTION_FIELD:
                input_field_types.update(self._resolve_collector_input_types(source_node.id))
                continue
            input_field_types.update(extract_collection_item_types(input_field_type))
        return input_field_types

    def _validate_collector_collection_inputs(self, collection_input_field_types: list[Any]) -> str | None:
        if not all((is_list_or_contains_list(t) or is_any(t) for t in collection_input_field_types)):
            return "Collector collection input must be a collection"
        return None

    def _get_collector_input_root_type_from_resolved_types(
        self, input_field_types: set[Any]
    ) -> tuple[bool, Any | None]:
        non_any_input_field_types = {t for t in input_field_types if t != Any}
        root_types = self._get_type_tree_root_types(non_any_input_field_types)
        if len(root_types) > 1:
            return True, None
        return False, root_types[0] if len(root_types) == 1 else None

    def _validate_collector_output_types(
        self, output_field_types: list[Any], input_root_type: Any | None
    ) -> str | None:
        if not all(is_list_or_contains_list(t) or is_any(t) for t in output_field_types):
            return "Collector output must connect to a collection input"

        if input_root_type is not None:
            if not all(
                is_any(t)
                or is_union_subtype(input_root_type, get_args(t)[0])
                or issubclass(input_root_type, get_args(t)[0])
                for t in output_field_types
            ):
                return "Collector outputs must connect to a collection input with a matching type"
        elif any(not is_any(t) and get_args(t)[0] != Any for t in output_field_types):
            return "Collector outputs must connect to a collection input with a matching type"

        return None

    def _validate_downstream_collector_outputs(
        self, outputs: list[EdgeConnection], input_root_type: Any | None
    ) -> str | None:
        for output in outputs:
            output_node = self.get_node(output.node_id)
            if not isinstance(output_node, CollectInvocation) or output.field != COLLECTION_FIELD:
                continue
            output_root_type = self._get_collector_input_root_type(output_node.id)
            if output_root_type is None:
                continue
            if input_root_type is None:
                if output_root_type != Any:
                    return "Collector outputs must connect to a collection input with a matching type"
                continue
            if not are_connection_types_compatible(input_root_type, output_root_type):
                return "Collector outputs must connect to a collection input with a matching type"
        return None

    def _is_collector_connection_valid(
        self,
        node_id: str,
        new_input: Optional[EdgeConnection] = None,
        new_input_field: Optional[str] = None,
        new_output: Optional[EdgeConnection] = None,
    ) -> str | None:
        item_inputs, collection_inputs, outputs = self._get_collector_connections(
            node_id, new_input=new_input, new_input_field=new_input_field, new_output=new_output
        )

        if len(item_inputs) == 0 and len(collection_inputs) == 0:
            return "Collector must have at least one item or collection input edge"

        item_input_field_types, collection_input_field_types, output_field_types = self._get_collector_port_types(
            item_inputs, collection_inputs, outputs
        )

        collection_input_error = self._validate_collector_collection_inputs(collection_input_field_types)
        if collection_input_error is not None:
            return collection_input_error

        input_field_types = self._resolve_item_input_types(item_input_field_types)
        input_field_types.update(self._resolve_collection_input_types(collection_inputs, collection_input_field_types))

        has_multiple_root_types, input_root_type = self._get_collector_input_root_type_from_resolved_types(
            input_field_types
        )
        if has_multiple_root_types:
            return "Collector input collection items must be of a single type"

        output_type_error = self._validate_collector_output_types(output_field_types, input_root_type)
        if output_type_error is not None:
            return output_type_error

        downstream_output_error = self._validate_downstream_collector_outputs(outputs, input_root_type)
        if downstream_output_error is not None:
            return downstream_output_error

        return None

    def nx_graph(self) -> "nx.DiGraph":
        """Returns a NetworkX DiGraph representing the layout of this graph"""
        # TODO: Cache this?
        g = nx.DiGraph()
        g.add_nodes_from(list(self.nodes.keys()))
        g.add_edges_from({(e.source.node_id, e.destination.node_id) for e in self.edges if e.type == "default"})
        return g

    def nx_graph_flat(self, nx_graph: Optional["nx.DiGraph"] = None) -> "nx.DiGraph":
        """Returns a flattened NetworkX DiGraph, including all subgraphs (but not with iterations expanded)"""
        g = nx_graph or nx.DiGraph()

        # Add all nodes from this graph except graph/iteration nodes
        g.add_nodes_from([n.id for n in self.nodes.values()])

        unique_edges = {(e.source.node_id, e.destination.node_id) for e in self.edges if e.type == "default"}
        g.add_edges_from(unique_edges)
        return g


class GraphExecutionState(BaseModel):
    """Tracks source-graph expansion, execution progress, and runtime results."""

    id: str = Field(description="The id of the execution state", default_factory=uuid_string)
    # TODO: Store a reference to the graph instead of the actual graph?
    graph: Graph = Field(description="The graph being executed")

    # The graph of materialized nodes
    execution_graph: Graph = Field(
        description="The expanded graph of activated and executed nodes",
        default_factory=Graph,
    )

    # Nodes that have been executed
    executed: set[str] = Field(description="The set of node ids that have been executed", default_factory=set)
    executed_history: list[str] = Field(
        description="The list of node ids that have been executed, in order of execution",
        default_factory=list,
    )

    # The results of executed nodes
    results: dict[str, AnyInvocationOutput] = Field(description="The results of node executions", default_factory=dict)

    # Errors raised when executing nodes
    errors: dict[str, str] = Field(description="Errors raised when executing nodes", default_factory=dict)

    workflow_call_stack: list[WorkflowCallFrame] = Field(
        description="The nested workflow call stack inherited by this execution state.",
        default_factory=list,
    )
    workflow_call_history: list[WorkflowCallExecution] = Field(
        description="Completed or failed workflow-call relationships observed by this execution state.",
        default_factory=list,
    )
    workflow_call_parent: Optional[WorkflowCallParentRef] = Field(
        default=None,
        description="Parent workflow-call relationship metadata when this execution state is a child workflow session.",
    )
    waiting_workflow_call: Optional[WorkflowCallFrame] = Field(
        default=None,
        description="The child workflow call this execution state is currently waiting on, if any.",
    )
    waiting_workflow_call_execution: Optional[WorkflowCallExecution] = Field(
        default=None,
        description="The active workflow-call relationship metadata for the current waiting child workflow, if any.",
    )
    waiting_workflow_call_child_session: Optional["GraphExecutionState"] = Field(
        default=None,
        description="The child workflow execution state spawned by the current waiting workflow call, if any.",
    )
    max_workflow_call_depth: int = Field(
        default=4,
        ge=1,
        description="The maximum permitted workflow call depth for nested workflow execution.",
    )

    # Map of prepared/executed nodes to their original nodes
    prepared_source_mapping: dict[str, str] = Field(
        description="The map of prepared nodes to original graph nodes",
        default_factory=dict,
    )

    # Map of original nodes to prepared nodes
    source_prepared_mapping: dict[str, set[str]] = Field(
        description="The map of original graph nodes to prepared nodes",
        default_factory=dict,
    )
    finalized_loop_contexts: set[tuple[str, tuple[int, ...]]] = Field(
        description="The finalized loop source and parent iteration contexts",
        default_factory=set,
    )
    prepared_iteration_paths: dict[str, tuple[int, ...]] = Field(
        description="The iteration coordinates of each prepared execution node",
        default_factory=dict,
    )
    # Ready queues grouped by node class name (internal only)
    _ready_queues: dict[str, Deque[str]] = PrivateAttr(default_factory=dict)
    _ready_node_ids: set[str] = PrivateAttr(default_factory=set)
    # Current class being drained; stays until its queue empties
    _active_class: Optional[str] = PrivateAttr(default=None)
    # Optional priority; others follow in name order
    ready_order: list[str] = Field(default_factory=list)
    indegree: dict[str, int] = Field(default_factory=dict, description="Remaining unmet input count for exec nodes")
    _if_branch_exclusive_sources: dict[str, dict[str, set[str]]] = PrivateAttr(default_factory=dict)
    _resolved_if_exec_branches: dict[str, str] = PrivateAttr(default_factory=dict)
    _prepared_exec_metadata: dict[str, _PreparedExecNodeMetadata] = PrivateAttr(default_factory=dict)
    _prepared_exec_registry: Optional[_PreparedExecRegistry] = PrivateAttr(default=None)
    _if_branch_scheduler: Optional[_IfBranchScheduler] = PrivateAttr(default=None)
    _execution_materializer: Optional[_ExecutionMaterializer] = PrivateAttr(default=None)
    _execution_scheduler: Optional[_ExecutionScheduler] = PrivateAttr(default=None)
    _execution_runtime: Optional[_ExecutionRuntime] = PrivateAttr(default=None)
    _for_parent_iteration_paths_cache: dict[str, set[tuple[int, ...]]] = PrivateAttr(default_factory=dict)
    _all_for_contexts_finalized_cache: dict[str, bool] = PrivateAttr(default_factory=dict)
    _prepared_for_index: Optional[dict[tuple[str, tuple[int, ...]], str]] = PrivateAttr(default=None)
    _final_prepared_for_index: Optional[dict[tuple[str, tuple[int, ...]], str]] = PrivateAttr(default=None)
    _prepared_for_index_by_exec: dict[str, tuple[str, tuple[int, ...], tuple[int, ...]]] = PrivateAttr(
        default_factory=dict
    )
    _source_graph_flat: Any | None = PrivateAttr(default=None)
    _for_source_by_return_id: Optional[dict[str, str]] = PrivateAttr(default=None)

    def _type_key(self, node_obj: BaseInvocation) -> str:
        return node_obj.__class__.__name__

    def _prepared_registry(self) -> _PreparedExecRegistry:
        if self._prepared_exec_registry is None:
            self._prepared_exec_registry = _PreparedExecRegistry(
                prepared_source_mapping=self.prepared_source_mapping,
                source_prepared_mapping=self.source_prepared_mapping,
                prepared_iteration_paths=self.prepared_iteration_paths,
                metadata=self._prepared_exec_metadata,
                on_iteration_path_change=self._invalidate_loop_caches_for_exec_node,
            )
        return self._prepared_exec_registry

    def _if_scheduler(self) -> _IfBranchScheduler:
        if self._if_branch_scheduler is None:
            self._if_branch_scheduler = _IfBranchScheduler(self)
        return self._if_branch_scheduler

    def _get_source_graph_flat(self) -> Any:
        if self._source_graph_flat is None:
            self._source_graph_flat = self.graph.nx_graph_flat()
        return self._source_graph_flat

    def _get_for_source_by_return_id(self) -> dict[str, str]:
        if self._for_source_by_return_id is None:
            source_graph = self._get_source_graph_flat()
            self._for_source_by_return_id = {
                body_path_to_return[1]: source_for_id
                for source_for_id, source_for_node in self.graph.nodes.items()
                if isinstance(source_for_node, ForInvocation)
                and (body_path_to_return := self.graph._get_for_body_path_to_return(source_for_id, source_graph))
                is not None
            }
        return self._for_source_by_return_id

    def _invalidate_source_graph_cache(self) -> None:
        self._source_graph_flat = None
        self._for_source_by_return_id = None

    def _materializer(self) -> _ExecutionMaterializer:
        if self._execution_materializer is None:
            self._execution_materializer = _ExecutionMaterializer(self)
        return self._execution_materializer

    def _scheduler(self) -> _ExecutionScheduler:
        if self._execution_scheduler is None:
            self._execution_scheduler = _ExecutionScheduler(self)
        return self._execution_scheduler

    def _runtime(self) -> _ExecutionRuntime:
        if self._execution_runtime is None:
            self._execution_runtime = _ExecutionRuntime(self)
        return self._execution_runtime

    def _register_prepared_exec_node(self, exec_node_id: str, source_node_id: str) -> None:
        self._prepared_registry().register(exec_node_id, source_node_id)
        self._invalidate_loop_caches_for_source(source_node_id)
        if (
            self._prepared_for_index is not None
            and self._prepared_registry().get_iteration_path(exec_node_id) is not None
        ):
            self._update_prepared_for_index(exec_node_id)

    def _invalidate_loop_caches_for_source(self, source_node_id: str) -> None:
        self._all_for_contexts_finalized_cache.pop(source_node_id, None)

    def _invalidate_loop_caches_for_exec_node(self, exec_node_id: str) -> None:
        source_node_id = self.prepared_source_mapping.get(exec_node_id)
        if source_node_id is not None:
            self._invalidate_loop_caches_for_source(source_node_id)
            prepared_node = self.execution_graph.nodes.get(exec_node_id)
            if isinstance(prepared_node, ForInvocation):
                parent_iteration_path = self._get_for_parent_iteration_path(exec_node_id)
                cached_paths = self._for_parent_iteration_paths_cache.get(source_node_id)
                if cached_paths is not None:
                    cached_paths.add(parent_iteration_path)
        self._update_prepared_for_index(exec_node_id)

    def _get_prepared_exec_metadata(self, exec_node_id: str) -> _PreparedExecNodeMetadata:
        return self._prepared_registry().get_metadata(exec_node_id)

    def _set_prepared_exec_state(self, exec_node_id: str, state: PreparedExecState) -> None:
        self._prepared_registry().set_state(exec_node_id, state)

    def _get_iteration_path(self, exec_node_id: str) -> tuple[int, ...]:
        return self._runtime().get_iteration_path(exec_node_id)

    def _get_for_parent_iteration_path(self, exec_node_id: str) -> tuple[int, ...]:
        iteration_path = self._get_iteration_path(exec_node_id)
        node = self.execution_graph.get_node(exec_node_id)
        if isinstance(node, ForInvocation) and node.index == -1:
            return iteration_path
        return iteration_path[:-1]

    def _get_prepared_for_index(self) -> dict[tuple[str, tuple[int, ...]], str]:
        """Index For executions by exact iteration path and final candidates by parent context.

        The scheduler creates For executions in iteration order, so the highest index in a context is the current
        final candidate. Indexes are built lazily once and maintained as prepared paths are registered; repeated
        completion checks then use constant-time context lookups.
        """
        if self._prepared_for_index is not None:
            return self._prepared_for_index

        index: dict[tuple[str, tuple[int, ...]], str] = {}
        self._prepared_for_index_by_exec = {}
        self._final_prepared_for_index = {}
        for source_for_id, prepared_ids in self.source_prepared_mapping.items():
            for prepared_for_id in prepared_ids:
                self._prepared_for_index_by_exec[prepared_for_id] = (
                    source_for_id,
                    self._get_iteration_path(prepared_for_id),
                    self._get_for_parent_iteration_path(prepared_for_id),
                )

        self._prepared_for_index = index
        for prepared_for_id in list(self._prepared_for_index_by_exec):
            self._update_prepared_for_index(prepared_for_id)
        assert self._prepared_for_index is not None
        return self._prepared_for_index

    def _update_prepared_for_index(self, prepared_for_id: str) -> None:
        if self._prepared_for_index is None:
            return

        old_key = self._prepared_for_index_by_exec.pop(prepared_for_id, None)
        if old_key is not None:
            old_source_id, old_path, old_parent_path = old_key
            if self._prepared_for_index.get((old_source_id, old_path)) == prepared_for_id:
                del self._prepared_for_index[(old_source_id, old_path)]
            if (
                self._final_prepared_for_index is not None
                and self._final_prepared_for_index.get((old_source_id, old_parent_path)) == prepared_for_id
            ):
                del self._final_prepared_for_index[(old_source_id, old_parent_path)]

        prepared_for_node = self.execution_graph.nodes.get(prepared_for_id)
        source_for_id = self.prepared_source_mapping.get(prepared_for_id)
        if not isinstance(prepared_for_node, ForInvocation) or source_for_id is None:
            return

        iteration_path = self._get_iteration_path(prepared_for_id)
        parent_iteration_path = self._get_for_parent_iteration_path(prepared_for_id)
        key = (source_for_id, iteration_path)
        existing_id = self._prepared_for_index.get(key)
        if existing_id is None:
            self._prepared_for_index[key] = prepared_for_id
        else:
            existing_node = self.execution_graph.get_node(existing_id)
            if isinstance(existing_node, ForInvocation) and prepared_for_node.index > existing_node.index:
                self._prepared_for_index[key] = prepared_for_id
        assert self._final_prepared_for_index is not None
        final_key = (source_for_id, parent_iteration_path)
        final_existing_id = self._final_prepared_for_index.get(final_key)
        if final_existing_id is None:
            self._final_prepared_for_index[final_key] = prepared_for_id
        else:
            final_existing_node = self.execution_graph.get_node(final_existing_id)
            if isinstance(final_existing_node, ForInvocation) and prepared_for_node.index > final_existing_node.index:
                self._final_prepared_for_index[final_key] = prepared_for_id
        self._prepared_for_index_by_exec[prepared_for_id] = (source_for_id, iteration_path, parent_iteration_path)

    def _mark_loop_context_finalized(self, source_for_id: str, prepared_for_id: str) -> None:
        parent_iteration_path = self._get_for_parent_iteration_path(prepared_for_id)
        self.finalized_loop_contexts.add((source_for_id, parent_iteration_path))
        self._all_for_contexts_finalized_cache.pop(source_for_id, None)

    def _mark_for_source_complete(self, source_for_id: str) -> None:
        if not self._all_for_contexts_finalized(source_for_id):
            return

        source_node_ids = {source_for_id}
        body_path_to_return = self.graph._get_for_body_path_to_return(source_for_id, self.graph.nx_graph_flat())
        if body_path_to_return is not None:
            body_path_nodes, _return_node_id = body_path_to_return
            source_node_ids.update(body_path_nodes)

        for source_node_id in source_node_ids:
            if source_node_id not in self.executed:
                self.executed.add(source_node_id)
                if source_node_id not in self.executed_history:
                    self.executed_history.append(source_node_id)

    def _get_for_parent_iteration_paths(self, source_for_id: str) -> set[tuple[int, ...]]:
        cached = self._for_parent_iteration_paths_cache.get(source_for_id)
        if cached is not None:
            return cached

        paths = {
            self._get_for_parent_iteration_path(prepared_for_id)
            for prepared_for_id in self._prepared_registry().get_prepared_ids(source_for_id)
            if isinstance(self.execution_graph.get_node(prepared_for_id), ForInvocation)
        }
        self._for_parent_iteration_paths_cache[source_for_id] = paths
        return paths

    def _is_loop_context_finalized(self, source_for_id: str, parent_iteration_path: tuple[int, ...]) -> bool:
        return (source_for_id, parent_iteration_path) in self.finalized_loop_contexts

    def _all_for_contexts_finalized(self, source_for_id: str) -> bool:
        cached = self._all_for_contexts_finalized_cache.get(source_for_id)
        if cached is not None:
            return cached

        parent_iteration_paths = self._get_for_parent_iteration_paths(source_for_id)
        finalized = (bool(parent_iteration_paths) or source_for_id in self.executed) and all(
            self._is_loop_context_finalized(source_for_id, parent_iteration_path)
            for parent_iteration_path in parent_iteration_paths
        )
        self._all_for_contexts_finalized_cache[source_for_id] = finalized
        return finalized

    def _queue_for(self, cls_name: str) -> Deque[str]:
        return self._scheduler().queue_for(cls_name)

    def _is_deferred_by_unresolved_if(self, exec_node_id: str) -> bool:
        return self._if_scheduler().is_deferred_by_unresolved_if(exec_node_id)

    def _remove_from_ready_queues(self, exec_node_id: str) -> None:
        self._scheduler().remove_from_ready_queues(exec_node_id)

    def _try_resolve_if_node(self, exec_node_id: str) -> None:
        self._if_scheduler().try_resolve_if_node(exec_node_id)

    def set_ready_order(self, order: Iterable[Type[BaseInvocation] | str]) -> None:
        names: list[str] = []
        for x in order:
            names.append(x.__name__ if hasattr(x, "__name__") else str(x))
        self.ready_order = names

    def _enqueue_if_ready(self, nid: str) -> None:
        self._scheduler().enqueue_if_ready(nid)

    def _prepare_until_node_ready(self) -> Optional[BaseInvocation]:
        base_graph = self.graph.nx_graph_flat()
        prepared_id = self._materializer().prepare(base_graph)
        next_node: Optional[BaseInvocation] = None

        while prepared_id is not None:
            prepared_id = self._materializer().prepare(base_graph)
            if next_node is None:
                next_node = self._get_next_node()

        return next_node

    def _reset_runtime_caches(self) -> None:
        self._ready_queues = {}
        self._ready_node_ids = set()
        self._active_class = None
        self._if_branch_exclusive_sources = {}
        self._resolved_if_exec_branches = {}
        self._prepared_exec_metadata = {}
        self._prepared_exec_registry = None
        self._if_branch_scheduler = None
        self._execution_materializer = None
        self._execution_scheduler = None
        self._execution_runtime = None
        self._for_parent_iteration_paths_cache = {}
        self._all_for_contexts_finalized_cache = {}
        self._prepared_for_index = None
        self._final_prepared_for_index = None
        self._prepared_for_index_by_exec = {}

    def _rehydrate_prepared_exec_metadata(self) -> None:
        registry = self._prepared_registry()
        for exec_node_id, source_node_id in self.prepared_source_mapping.items():
            metadata = registry.get_metadata(exec_node_id)
            metadata.source_node_id = source_node_id
            iteration_path = registry.get_iteration_path(exec_node_id)
            if iteration_path is None:
                iteration_path = self._get_iteration_path(exec_node_id)
            metadata.iteration_path = iteration_path
            if exec_node_id in self.executed:
                metadata.state = "executed" if exec_node_id in self.results else "skipped"
            elif self.indegree.get(exec_node_id) == 0:
                metadata.state = "ready"
            else:
                metadata.state = "pending"

    def _apply_if_condition_inputs(self, exec_node_id: str, node: IfInvocation) -> bool:
        condition_edges = self.execution_graph._get_input_edges(exec_node_id, "condition")
        if any(edge.source.node_id not in self.executed for edge in condition_edges):
            return False

        for edge in condition_edges:
            setattr(
                node,
                edge.destination.field,
                copydeep(getattr(self.results[edge.source.node_id], edge.source.field)),
            )
        return True

    def _rehydrate_resolved_if_exec_branches(self) -> None:
        for exec_node_id, node in self.execution_graph.nodes.items():
            if not isinstance(node, IfInvocation):
                continue

            if not self._apply_if_condition_inputs(exec_node_id, node):
                continue

            self._resolved_if_exec_branches[exec_node_id] = "true_input" if node.condition else "false_input"

    def _rehydrate_ready_queues(self) -> None:
        if self.has_error():
            return

        execution_graph = self.execution_graph.nx_graph_flat()
        for exec_node_id in nx.topological_sort(execution_graph):
            if exec_node_id in self.executed:
                continue
            if self.indegree.get(exec_node_id) != 0:
                continue
            self._enqueue_if_ready(exec_node_id)

    def _rehydrate_runtime_state(self) -> None:
        self._reset_runtime_caches()
        self._rehydrate_prepared_exec_metadata()
        self._rehydrate_resolved_if_exec_branches()
        self._rehydrate_ready_queues()

    def model_post_init(self, __context: Any) -> None:
        self._rehydrate_runtime_state()

    model_config = ConfigDict(
        json_schema_extra={
            "required": [
                "id",
                "graph",
                "execution_graph",
                "executed",
                "executed_history",
                "results",
                "errors",
                "workflow_call_stack",
                "workflow_call_history",
                "prepared_source_mapping",
                "source_prepared_mapping",
            ]
        }
    )

    @field_validator("graph")
    def graph_is_valid(cls, v: Graph):
        """Validates that the graph is valid"""
        v.validate_self()
        return v

    def next(self) -> Optional[BaseInvocation]:
        """Gets the next node ready to execute."""

        # TODO: enable multiple nodes to execute simultaneously by tracking currently executing nodes
        #       possibly with a timeout?

        if self.is_waiting_on_workflow_call():
            return None
        # Failed graphs stop scheduling immediately; is_complete() treats the error as terminal as well.
        if self.has_error():
            return None

        # If there are no prepared nodes, prepare some nodes
        next_node = self._get_next_node()
        if next_node is None:
            next_node = self._prepare_until_node_ready()

        # Get values from edges
        if next_node is not None:
            try:
                self._prepare_inputs(next_node)
            except ValidationError as e:
                raise NodeInputError(next_node, e)

        # If next is still none, there's no next node, return None
        return next_node

    def complete(self, node_id: str, output: BaseInvocationOutput) -> list[tuple[BaseInvocation, BaseInvocationOutput]]:
        """Marks a node as complete"""
        finalized_outputs = self._scheduler().complete(node_id, output)
        self._mark_completed_sources()
        return finalized_outputs

    def set_node_error(self, node_id: str, error: str):
        """Marks a node as errored"""
        self.errors[node_id] = error

    def is_complete(self) -> bool:
        """Returns true if the graph is complete"""
        if self.is_waiting_on_workflow_call():
            return False
        return self._is_complete_with_completed_sources()

    def _completed_source_ids(self) -> set[str]:
        completed_source_ids = set(self.executed)
        for source_node_id, source_node in self.graph.nodes.items():
            prepared_node_ids = self._prepared_registry().get_prepared_ids(source_node_id)
            if not prepared_node_ids or not all(node_id in self.executed for node_id in prepared_node_ids):
                continue
            if isinstance(source_node, ForInvocation) and not self._all_for_contexts_finalized(source_node_id):
                continue
            completed_source_ids.add(source_node_id)
        return completed_source_ids

    def _is_complete_with_completed_sources(self) -> bool:
        if self.has_error():
            return True
        completed_source_ids = self._completed_source_ids()
        node_ids = set(self.graph.nx_graph_flat().nodes)
        return all(node_id in completed_source_ids for node_id in node_ids)

    def _mark_completed_sources(self) -> None:
        if not self._is_complete_with_completed_sources():
            return

        completed_source_ids = self._completed_source_ids()
        for source_node_id in nx.topological_sort(self.graph.nx_graph_flat()):
            if source_node_id in completed_source_ids and source_node_id not in self.executed:
                self.executed.add(source_node_id)
                if source_node_id not in self.executed_history:
                    self.executed_history.append(source_node_id)

    def has_error(self) -> bool:
        """Returns true if the graph has any errors"""
        return len(self.errors) > 0

    def get_workflow_call_depth(self) -> int:
        return len(self.workflow_call_stack)

    def is_waiting_on_workflow_call(self) -> bool:
        return self.waiting_workflow_call is not None

    def build_workflow_call_frame(self, exec_node_id: str, workflow_id: str) -> WorkflowCallFrame:
        if exec_node_id not in self.execution_graph.nodes:
            raise NodeNotFoundError(f"Node {exec_node_id} not found in execution graph")
        if exec_node_id not in self.prepared_source_mapping:
            raise ValueError(f"Node {exec_node_id} is not a prepared execution node")

        next_depth = self.get_workflow_call_depth() + 1
        if next_depth > self.max_workflow_call_depth:
            raise ValueError(
                f"Maximum workflow call depth exceeded ({self.max_workflow_call_depth}) for workflow '{workflow_id}'"
            )

        return WorkflowCallFrame(
            prepared_call_node_id=exec_node_id,
            source_call_node_id=self.prepared_source_mapping[exec_node_id],
            workflow_id=workflow_id,
            depth=next_depth,
        )

    def begin_waiting_on_workflow_call(self, frame: WorkflowCallFrame) -> None:
        if self.waiting_workflow_call is not None:
            raise ValueError("Execution state is already waiting on a workflow call")
        self.waiting_workflow_call = frame
        self.waiting_workflow_call_execution = WorkflowCallExecution(
            parent_session_id=self.id,
            prepared_call_node_id=frame.prepared_call_node_id,
            source_call_node_id=frame.source_call_node_id,
            workflow_id=frame.workflow_id,
            depth=frame.depth,
            status="waiting_for_child",
        )

    def attach_waiting_workflow_call_child_session(self, child_session: "GraphExecutionState") -> None:
        if self.waiting_workflow_call is None:
            raise ValueError("Execution state must be waiting on a workflow call before attaching a child session")
        if self.waiting_workflow_call_execution is None:
            raise ValueError("Execution state is waiting on a workflow call but has no workflow call execution")
        self.waiting_workflow_call_child_session = child_session
        self.waiting_workflow_call_execution.child_session_id = child_session.id
        self.waiting_workflow_call_execution.child_session_ids = [child_session.id]
        self.waiting_workflow_call_execution.expected_child_count = 1
        self.waiting_workflow_call_execution.status = "running_child"
        child_session.workflow_call_parent = WorkflowCallParentRef(
            workflow_call_id=self.waiting_workflow_call_execution.id,
            parent_session_id=self.waiting_workflow_call_execution.parent_session_id,
            prepared_call_node_id=self.waiting_workflow_call_execution.prepared_call_node_id,
            source_call_node_id=self.waiting_workflow_call_execution.source_call_node_id,
            workflow_id=self.waiting_workflow_call_execution.workflow_id,
            depth=self.waiting_workflow_call_execution.depth,
        )

    def attach_waiting_workflow_call_child_sessions(self, child_sessions: list["GraphExecutionState"]) -> None:
        if not child_sessions:
            raise ValueError("Workflow call must attach at least one child session")
        if self.waiting_workflow_call_execution is None:
            raise ValueError("Execution state is waiting on a workflow call but has no workflow call execution")
        self.waiting_workflow_call_child_session = child_sessions[0] if len(child_sessions) == 1 else None
        self.waiting_workflow_call_execution.child_session_id = child_sessions[0].id
        self.waiting_workflow_call_execution.child_session_ids = [child_session.id for child_session in child_sessions]
        self.waiting_workflow_call_execution.expected_child_count = len(child_sessions)
        self.waiting_workflow_call_execution.status = "running_child"
        for child_session in child_sessions:
            child_session.workflow_call_parent = WorkflowCallParentRef(
                workflow_call_id=self.waiting_workflow_call_execution.id,
                parent_session_id=self.waiting_workflow_call_execution.parent_session_id,
                prepared_call_node_id=self.waiting_workflow_call_execution.prepared_call_node_id,
                source_call_node_id=self.waiting_workflow_call_execution.source_call_node_id,
                workflow_id=self.waiting_workflow_call_execution.workflow_id,
                depth=self.waiting_workflow_call_execution.depth,
            )

    def set_waiting_workflow_call_child_item_ids(self, child_item_ids: list[int]) -> None:
        if self.waiting_workflow_call_execution is None:
            raise ValueError("Execution state is not waiting on a workflow call.")
        if len(child_item_ids) != self.waiting_workflow_call_execution.expected_child_count:
            raise ValueError("Workflow call child item count does not match expected child count.")
        if len(set(child_item_ids)) != len(child_item_ids):
            raise ValueError("Workflow call child item ids must be unique.")
        self.waiting_workflow_call_execution.child_item_ids = list(child_item_ids)

    def record_waiting_workflow_call_child_completion(
        self, child_item_id: int, output_values: dict[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        if self.waiting_workflow_call_execution is None:
            raise ValueError("Execution state is not waiting on a workflow call.")
        execution = self.waiting_workflow_call_execution
        if execution.child_item_ids and child_item_id not in execution.child_item_ids:
            raise ValueError(f"Child queue item {child_item_id} does not belong to the active workflow call.")
        if child_item_id not in execution.completed_child_item_ids:
            if (
                execution.expected_child_count > 1
                and execution.child_outputs
                and set(output_values.keys()) != set(next(iter(execution.child_outputs.values())).keys())
            ):
                raise ValueError("Batched child workflows returned different workflow return keys.")
            execution.completed_child_item_ids.append(child_item_id)
            execution.child_outputs[child_item_id] = dict(output_values)

            ordered_item_ids = execution.child_item_ids or execution.completed_child_item_ids
            execution.aggregated_values = {
                key: [
                    execution.child_outputs[item_id][key]
                    for item_id in ordered_item_ids
                    if item_id in execution.child_outputs
                ]
                for key in output_values
            }
        is_complete = len(execution.completed_child_item_ids) >= execution.expected_child_count
        if execution.expected_child_count == 1:
            return (
                is_complete,
                {key: values[0] for key, values in execution.aggregated_values.items()},
            )
        return (
            is_complete,
            {key: list(values) for key, values in execution.aggregated_values.items()},
        )

    def end_waiting_on_workflow_call(
        self,
        status: Literal["completed", "failed"] = "completed",
        error_message: Optional[str] = None,
    ) -> None:
        if self.waiting_workflow_call_execution is not None:
            self.waiting_workflow_call_execution.status = status
            self.waiting_workflow_call_execution.error_message = error_message
            self.workflow_call_history.append(self.waiting_workflow_call_execution.model_copy(deep=True))
        self.waiting_workflow_call = None
        self.waiting_workflow_call_execution = None
        self.waiting_workflow_call_child_session = None

    def create_child_workflow_execution_state(self, graph: Graph, frame: WorkflowCallFrame) -> "GraphExecutionState":
        return GraphExecutionState(
            graph=graph,
            workflow_call_stack=[*self.workflow_call_stack, frame],
            max_workflow_call_depth=self.max_workflow_call_depth,
        )

    def _create_execution_node(self, node_id: str, iteration_node_map: list[tuple[str, str]]) -> list[str]:
        return self._materializer().create_execution_node(node_id, iteration_node_map)

    def _iterator_graph(self, base: Optional["nx.DiGraph"] = None) -> "nx.DiGraph":
        return self._materializer().iterator_graph(base)

    def _get_node_iterators(self, node_id: str, it_graph: Optional["nx.DiGraph"] = None) -> list[str]:
        return self._materializer().get_node_iterators(node_id, it_graph)

    def _prepare(self, base_g: Optional["nx.DiGraph"] = None) -> Optional[str]:
        return self._materializer().prepare(base_g)

    def _get_iteration_node(
        self,
        source_node_id: str,
        graph: "nx.DiGraph",
        execution_graph: "nx.DiGraph",
        prepared_iterator_nodes: list[str],
    ) -> Optional[str]:
        return self._materializer().get_iteration_node(source_node_id, graph, execution_graph, prepared_iterator_nodes)

    def _get_next_node(self) -> Optional[BaseInvocation]:
        return self._scheduler().get_next_node()

    def _prepare_inputs(self, node: BaseInvocation):
        self._runtime().prepare_inputs(node)

    # TODO: Add API for modifying underlying graph that checks if the change will be valid given the current execution state
    def _is_edge_valid(self, edge: Edge) -> bool:
        try:
            self.graph._validate_edge(edge)
        except InvalidEdgeError:
            return False

        # Invalid if destination has already been prepared or executed
        if edge.destination.node_id in self.source_prepared_mapping:
            return False

        # Otherwise, the edge is valid
        return True

    def _is_node_updatable(self, node_id: str) -> bool:
        # The node is updatable as long as it hasn't been prepared or executed
        return node_id not in self.source_prepared_mapping

    def add_node(self, node: BaseInvocation) -> None:
        self.graph.add_node(node)
        self._invalidate_source_graph_cache()

    def update_node(self, node_id: str, new_node: BaseInvocation) -> None:
        if not self._is_node_updatable(node_id):
            raise NodeAlreadyExecutedError(
                f"Node {node_id} has already been prepared or executed and cannot be updated"
            )
        self.graph.update_node(node_id, new_node)
        self._invalidate_source_graph_cache()

    def delete_node(self, node_id: str) -> None:
        if not self._is_node_updatable(node_id):
            raise NodeAlreadyExecutedError(
                f"Node {node_id} has already been prepared or executed and cannot be deleted"
            )
        self.graph.delete_node(node_id)
        self._invalidate_source_graph_cache()

    def add_edge(self, edge: Edge) -> None:
        if not self._is_node_updatable(edge.destination.node_id):
            raise NodeAlreadyExecutedError(
                f"Destination node {edge.destination.node_id} has already been prepared or executed and cannot be linked to"
            )
        self.graph.add_edge(edge)
        self._invalidate_source_graph_cache()

    def delete_edge(self, edge: Edge) -> None:
        if not self._is_node_updatable(edge.destination.node_id):
            raise NodeAlreadyExecutedError(
                f"Destination node {edge.destination.node_id} has already been prepared or executed and cannot have a source edge deleted"
            )
        self.graph.delete_edge(edge)
        self._invalidate_source_graph_cache()
