import pytest

from invokeai.app.invocations.math import AddInvocation
from invokeai.app.services.shared.execution_state_migration import (
    CURRENT_EXECUTION_STATE_VERSION,
    UnsupportedExecutionStateVersionError,
    dump_execution_state,
    load_execution_state,
)
from invokeai.app.services.shared.graph import (
    ExecutionFrame,
    ExecutionReference,
    ExecutionToken,
    Graph,
    GraphExecutionState,
)


def _make_state() -> GraphExecutionState:
    graph = Graph()
    graph.add_node(AddInvocation(id="node-id", a=1, b=2))
    execution_graph = Graph()
    execution_graph.add_node(AddInvocation(id="exec-node", a=1, b=2))
    return GraphExecutionState(
        id="state-id",
        graph=graph,
        execution_graph=execution_graph,
        executed={"node-id"},
        executed_history=["node-id"],
        errors={"node-id": "failure"},
        prepared_source_mapping={"exec-node": "node-id"},
        source_prepared_mapping={"node-id": {"exec-node"}},
        finalized_loop_contexts={("loop", (0, 1))},
        prepared_iteration_paths={"exec-node": (0, 1)},
        ready_order=["exec-node"],
        indegree={"exec-node": 0},
    )


def test_loads_legacy_unwrapped_graph_execution_state() -> None:
    state = _make_state()
    legacy_payload = state.model_dump(mode="json", warnings=False, exclude_none=True)

    restored = load_execution_state(legacy_payload)

    assert restored.model_dump(mode="json", warnings=False, exclude_none=True) == legacy_payload


def test_dumps_and_loads_versioned_execution_state_envelope() -> None:
    state = _make_state()

    snapshot = dump_execution_state(state)
    restored = load_execution_state(snapshot)

    assert snapshot["execution_state_version"] == CURRENT_EXECUTION_STATE_VERSION
    assert "state" not in snapshot
    expected = dict(snapshot)
    expected.pop("execution_state_version")
    restored_snapshot = dump_execution_state(restored)
    restored_snapshot.pop("execution_state_version")
    assert restored_snapshot == expected


def test_loads_temporary_versioned_envelope() -> None:
    state = _make_state()
    raw = dump_execution_state(state)
    raw.pop("execution_state_version")

    restored = load_execution_state({"version": CURRENT_EXECUTION_STATE_VERSION, "state": raw})

    assert restored.id == state.id


def test_migrates_explicit_legacy_version() -> None:
    state = _make_state()
    raw = state.model_dump(mode="json", warnings=False, exclude_none=True)

    restored = load_execution_state({"version": 0, "state": raw})

    assert restored.model_dump(mode="json", warnings=False, exclude_none=True) == raw


def test_rejects_future_execution_state_versions() -> None:
    snapshot = dump_execution_state(_make_state())
    snapshot["execution_state_version"] = CURRENT_EXECUTION_STATE_VERSION + 1

    with pytest.raises(UnsupportedExecutionStateVersionError, match="newer than supported"):
        load_execution_state(snapshot)


def test_round_trips_nullable_execution_token_value() -> None:
    state = _make_state()
    token = ExecutionToken(
        token_id="token-id",
        reference_id="state-id:exec-node",
        owner_node_id="exec-node",
        port="value",
        frame=ExecutionFrame(),
        value=None,
    )
    state.execution_tokens["token-id"] = token

    snapshot = dump_execution_state(state)
    assert snapshot["execution_tokens"]["token-id"]["value"] is None
    restored = load_execution_state(snapshot)

    assert restored.execution_tokens["token-id"].value is None


def test_round_trips_nullable_execution_token_value_in_child_state() -> None:
    state = _make_state()
    child = _make_state()
    child.execution_tokens["token-id"] = ExecutionToken(
        token_id="token-id",
        reference_id="state-id:exec-node",
        owner_node_id="exec-node",
        port="value",
        frame=ExecutionFrame(),
        value=None,
    )
    state.waiting_workflow_call_child_session = child

    snapshot = dump_execution_state(state)
    child_snapshot = snapshot["waiting_workflow_call_child_session"]
    assert child_snapshot["execution_tokens"]["token-id"]["value"] is None
    restored = load_execution_state(snapshot)

    assert restored.waiting_workflow_call_child_session is not None
    assert restored.waiting_workflow_call_child_session.execution_tokens["token-id"].value is None


def test_internal_execution_fields_are_persisted_but_not_publicly_serialized() -> None:
    state = _make_state()
    execution_ref = ExecutionReference(
        reference_id="state-id:exec-node",
        state_id="state-id",
        exec_node_id="exec-node",
        source_node_id="node-id",
        frame=ExecutionFrame(state_id="state-id", frame_id="frame-id"),
    )
    state.execution_refs["exec-node"] = execution_ref
    state.execution_tokens["token-id"] = ExecutionToken(
        token_id="token-id",
        reference_id=execution_ref.reference_id,
        owner_node_id="exec-node",
        port="value",
        frame=execution_ref.frame,
        value=3,
    )

    public_payload = state.model_dump(mode="json", warnings=False, exclude_none=True)
    assert "execution_refs" not in public_payload
    assert "execution_tokens" not in public_payload
    assert "execution_effects" not in public_payload

    persisted_payload = dump_execution_state(state)
    assert persisted_payload["execution_refs"]["exec-node"]["reference_id"] == execution_ref.reference_id
    assert persisted_payload["execution_tokens"]["token-id"]["value"] == 3
    assert persisted_payload["execution_effects"] == {}
