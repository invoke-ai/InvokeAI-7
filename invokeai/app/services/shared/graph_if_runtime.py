"""Activation admission helpers operating on state-owned runtime and durable records."""

from typing import TYPE_CHECKING

from invokeai.app.invocations.logic import IfInvocation
from invokeai.app.services.shared.execution_engine.primitives import ActivationGate
from invokeai.app.services.shared.execution_engine.scheduler import ActivationDependency
from invokeai.app.services.shared.graph_models import ExecutionToken

if TYPE_CHECKING:
    from invokeai.app.services.shared.graph import GraphExecutionState


def _record_activation_dependencies(
    state: "GraphExecutionState", exec_node_id: str
) -> tuple[ActivationDependency, ...]:
    dependencies = state._if_activation_dependencies_by_exec.get(exec_node_id)
    if dependencies is not None:
        return dependencies
    source_node_id = state._prepared_registry().get_source_node_id(exec_node_id)
    if any(isinstance(node, IfInvocation) for node in state.graph.nodes.values()):
        dependencies = state._get_source_activation_dependencies(
            source_node_id, state._get_iteration_path(exec_node_id)
        )
    else:
        dependencies = ()
    state._tx_set_mapping(state._if_activation_dependencies_by_exec, exec_node_id, dependencies)
    return dependencies


def _is_source_activation_admitted(
    state: "GraphExecutionState", source_node_id: str, iteration_path: tuple[int, ...] = ()
) -> bool:
    dependencies = state._get_source_activation_dependencies(source_node_id, iteration_path)
    return not dependencies or all(state._is_activation_dependency_satisfied(dependency) for dependency in dependencies)


def _is_source_inactive(
    state: "GraphExecutionState", source_node_id: str, iteration_path: tuple[int, ...] = ()
) -> bool:
    if not state._can_use_fresh_flat_if_activation():
        return state._if_activation_controller().is_source_inactive(source_node_id, iteration_path)

    dependencies = state._get_source_activation_dependencies(source_node_id, iteration_path)
    if not dependencies:
        return False
    if iteration_path:
        return any(state._is_activation_dependency_rejected(dependency) for dependency in dependencies)

    frames = {
        state._get_iteration_path(exec_node_id)
        for dependency in dependencies
        for exec_node_id in state._prepared_registry().get_prepared_ids(dependency.owner_id)
    }
    if not frames:
        return False
    return all(
        state._get_source_activation_dependencies(source_node_id, frame)
        and any(
            state._is_activation_dependency_rejected(frame_dependency)
            for frame_dependency in state._get_source_activation_dependencies(source_node_id, frame)
        )
        for frame in frames
    )


def _activation_gate(state: "GraphExecutionState", exec_node_id: str) -> ActivationGate:
    return state._generic_runtime().register_gate(
        gate_id=exec_node_id,
        owner_id=exec_node_id,
        frame=state._engine_frame(state._get_iteration_path(exec_node_id)),
        branches=("true_input", "false_input"),
    )


def _record_compatibility_activation_token(
    state: "GraphExecutionState", exec_node_id: str, selected_field: str
) -> None:
    execution_ref = state._expected_execution_ref(exec_node_id)
    activation_token_id = f"{execution_ref.reference_id}:activation:{selected_field}"
    state._tx_set_mapping(
        state.execution_tokens,
        activation_token_id,
        ExecutionToken(
            token_id=activation_token_id,
            reference_id=execution_ref.reference_id,
            owner_node_id=exec_node_id,
            port=selected_field,
            frame=execution_ref.frame,
            value=selected_field,
            token_kind="activation",
        ),
    )


def _is_activation_dependency_satisfied(state: "GraphExecutionState", dependency: ActivationDependency) -> bool:
    """Check one opaque plan requirement against durable gate and token state."""
    matching_gate_ids = [
        prepared_if_id
        for prepared_if_id in state._prepared_registry().get_prepared_ids(dependency.owner_id)
        if state._get_iteration_path(prepared_if_id) == dependency.frame
    ]
    if not matching_gate_ids:
        return False

    for gate_id in matching_gate_ids:
        expected_ref = state._expected_execution_ref(gate_id)
        gate = state._activation_gate(gate_id)
        if (
            gate.frame.state_id != expected_ref.frame.state_id
            or gate.frame.frame_id != expected_ref.frame.frame_id
            or gate.frame.iteration_path != expected_ref.frame.iteration_path
            or gate.frame.workflow_call_depth != expected_ref.frame.workflow_call_depth
            or gate.frame.iteration_path != dependency.frame
        ):
            return False
        if not gate.is_active(dependency.branch, owner_id=gate_id, frame=gate.frame):
            return False
        if not any(
            token.token_id == f"{expected_ref.reference_id}:activation:{dependency.branch}"
            and token.reference_id == expected_ref.reference_id
            and token.owner_node_id == gate_id
            and token.token_kind == "activation"
            and token.port == dependency.branch
            and token.value == dependency.branch
            and token.frame.state_id == expected_ref.frame.state_id
            and token.frame.frame_id == expected_ref.frame.frame_id
            and token.frame.iteration_path == expected_ref.frame.iteration_path
            and token.frame.workflow_call_depth == expected_ref.frame.workflow_call_depth
            for token in state.execution_tokens.values()
        ):
            return False
    return True


def _is_activation_dependency_rejected(state: "GraphExecutionState", dependency: ActivationDependency) -> bool:
    """Return whether a resolved gate explicitly selected another branch."""

    matching_gate_ids = [
        prepared_if_id
        for prepared_if_id in state._prepared_registry().get_prepared_ids(dependency.owner_id)
        if state._get_iteration_path(prepared_if_id) == dependency.frame
    ]
    for gate_id in matching_gate_ids:
        gate = state._activation_gate(gate_id)
        expected_frame = state._expected_execution_ref(gate_id).frame
        if (
            gate.frame.state_id != expected_frame.state_id
            or gate.frame.frame_id != expected_frame.frame_id
            or gate.frame.iteration_path != expected_frame.iteration_path
            or gate.frame.workflow_call_depth != expected_frame.workflow_call_depth
        ):
            return False
        if gate.resolved and gate.selected_branch != dependency.branch:
            return True
    return False


def _resolve_activation_gate(state: "GraphExecutionState", exec_node_id: str, branch: str) -> bool:
    runtime = state._generic_runtime()
    gate = state._activation_gate(exec_node_id)
    if gate.resolved and gate.selected_branch == branch:
        return False
    previous = ActivationGate.model_validate(gate.model_dump(mode="python"))
    changed = runtime.resolve_gate(
        exec_node_id,
        exec_node_id,
        gate.frame,
        branch,
    )
    if changed:
        state._completed_source_ids_cache = None
        state._tx_record(lambda: runtime.replace_gate(previous))
    return changed


def _is_deferred_by_unresolved_if(state: "GraphExecutionState", exec_node_id: str) -> bool:
    dependencies = state._get_activation_dependencies(exec_node_id)
    if not dependencies or any(state._is_activation_dependency_rejected(dependency) for dependency in dependencies):
        return False
    return not all(state._is_activation_dependency_satisfied(dependency) for dependency in dependencies)


def _has_rejected_activation_dependency(state: "GraphExecutionState", exec_node_id: str) -> bool:
    return any(
        state._is_activation_dependency_rejected(dependency)
        for dependency in state._get_activation_dependencies(exec_node_id)
    )


def _get_activation_dependencies(state: "GraphExecutionState", exec_node_id: str) -> tuple[ActivationDependency, ...]:
    return state._record_activation_dependencies(exec_node_id)
