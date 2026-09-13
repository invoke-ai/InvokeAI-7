"""Compatibility helpers for persisted internal execution-state snapshots."""

from collections.abc import Callable, Mapping
from typing import Any, Final

from invokeai.app.services.shared.graph import GraphExecutionState

CURRENT_EXECUTION_STATE_VERSION: Final[int] = 1
LEGACY_EXECUTION_STATE_VERSION: Final[int] = 0


def _retain_nullable_execution_token_values(snapshot: dict[str, Any]) -> None:
    """Retain omitted null execution values in this state and any embedded child state."""
    for output in snapshot.get("results", {}).values():
        if isinstance(output, dict) and output.get("type") == "iterate_output":
            output.setdefault("item", None)

    for token in snapshot.get("execution_tokens", {}).values():
        token.setdefault("value", None)

    child_snapshot = snapshot.get("waiting_workflow_call_child_session")
    if isinstance(child_snapshot, dict):
        _retain_nullable_execution_token_values(child_snapshot)


def _append_runtime_fields(snapshot: dict[str, Any], state: GraphExecutionState) -> None:
    """Add private runtime ledgers to an internal snapshot, including child states."""
    snapshot["execution_refs"] = {
        reference_id: reference.model_dump(mode="json") for reference_id, reference in state.execution_refs.items()
    }
    snapshot["execution_tokens"] = {
        token_id: token.model_dump(mode="json") for token_id, token in state.execution_tokens.items()
    }
    snapshot["execution_effects"] = {
        reference_id: [
            effect.model_dump(mode="json") if hasattr(effect, "model_dump") else effect for effect in effects
        ]
        for reference_id, effects in state.execution_effects.items()
    }
    for reference_id, effects in state._legacy_execution_effects_for_snapshot().items():
        snapshot["execution_effects"][reference_id] = [
            effect.model_dump(mode="json") if hasattr(effect, "model_dump") else effect for effect in effects
        ]

    child_snapshot = snapshot.get("waiting_workflow_call_child_session")
    child_state = state.waiting_workflow_call_child_session
    if isinstance(child_snapshot, dict) and child_state is not None:
        _append_runtime_fields(child_snapshot, child_state)


class UnsupportedExecutionStateVersionError(ValueError):
    """Raised when an execution-state snapshot cannot be read by this runtime."""


def dump_execution_state(state: GraphExecutionState) -> dict[str, Any]:
    """Dump an internal execution state with an additive version marker.

    The marker stays alongside the existing state fields so rolling deployments
    and diagnostic tools that still deserialize the legacy raw shape continue
    to work. The loader also accepts the temporary envelope form used by early
    migration experiments.
    """
    snapshot = state.model_dump(mode="json", warnings=False, exclude_none=True)
    _append_runtime_fields(snapshot, state)
    # Persist nullable output tokens explicitly. `ExecutionToken.value` remains required in the
    # public model/schema, but an output port may legitimately carry None and the general
    # exclude_none policy would otherwise make the snapshot impossible to hydrate.
    _retain_nullable_execution_token_values(snapshot)
    snapshot["execution_state_version"] = CURRENT_EXECUTION_STATE_VERSION
    return snapshot


def _migrate_legacy_snapshot(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Convert the original unmarked raw snapshot into the current payload shape."""

    return dict(payload)


def _migrate_v1_snapshot(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the v1 payload boundary before a future migration is added."""

    return dict(payload)


# Each key is the source version. A future version bump must add its v1 -> v2
# converter here before changing CURRENT_EXECUTION_STATE_VERSION.
_SNAPSHOT_MIGRATIONS: dict[int, Callable[[Mapping[str, Any]], dict[str, Any]]] = {
    LEGACY_EXECUTION_STATE_VERSION: _migrate_legacy_snapshot,
    CURRENT_EXECUTION_STATE_VERSION: _migrate_v1_snapshot,
}


def load_execution_state(snapshot: Mapping[str, Any]) -> GraphExecutionState:
    """Load a versioned snapshot or a legacy unwrapped execution state."""
    if not isinstance(snapshot, Mapping):
        raise TypeError("Execution state snapshot must be a mapping")

    if "version" not in snapshot and "execution_state_version" not in snapshot:
        version = LEGACY_EXECUTION_STATE_VERSION
        payload = snapshot
    elif "version" in snapshot:
        version = snapshot["version"]
        payload = snapshot.get("state")
        if not isinstance(payload, Mapping):
            raise ValueError("Versioned execution state snapshot must contain a mapping in 'state'")
    else:
        version = snapshot["execution_state_version"]
        payload = dict(snapshot)
        payload.pop("execution_state_version", None)

    if isinstance(version, bool) or not isinstance(version, int):
        raise ValueError("Execution state snapshot version must be an integer")
    if version > CURRENT_EXECUTION_STATE_VERSION:
        raise UnsupportedExecutionStateVersionError(
            f"Execution state snapshot version {version} is newer than supported version "
            f"{CURRENT_EXECUTION_STATE_VERSION}"
        )
    migrated_payload = payload
    legacy_execution_snapshot = version == LEGACY_EXECUTION_STATE_VERSION
    execution_effects_persisted = "execution_effects" in migrated_payload and not legacy_execution_snapshot
    while version < CURRENT_EXECUTION_STATE_VERSION:
        migrate = _SNAPSHOT_MIGRATIONS.get(version)
        if migrate is None:
            raise UnsupportedExecutionStateVersionError(
                f"Execution state snapshot version {version} has no migration to {CURRENT_EXECUTION_STATE_VERSION}"
            )
        migrated_payload = migrate(migrated_payload)
        version += 1

    migrate = _SNAPSHOT_MIGRATIONS.get(version)
    if migrate is None:
        raise UnsupportedExecutionStateVersionError(
            f"Execution state snapshot version {version} is unsupported; current version is "
            f"{CURRENT_EXECUTION_STATE_VERSION}"
        )
    return GraphExecutionState.model_validate(
        migrate(migrated_payload),
        strict=False,
        context={
            "execution_effects_persisted": execution_effects_persisted,
            "legacy_execution_snapshot": legacy_execution_snapshot,
        },
    )
