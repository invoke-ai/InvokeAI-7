"""The graphs webv2 compiles must be buildable from the invocations this backend registers.

The frontend builds generation graphs from its own per-base tables and never imports a backend
schema, so a node type or field that moves, is renamed, or loses its module import fails at
*enqueue* time with a validation error against a graph the user cannot edit. Nothing in either test
suite sees that on its own: the frontend only knows the strings it emits, and the backend only knows
the invocations it has.

The contract in between is `generateGraphNodeTypes.json`, written by
`src/features/generation/core/graphCoverage.test.ts` (regenerate with `vitest -u`). It records every
node type and every edge field that webv2's `compileGenerateGraph` produces for every supported
architecture. This module checks all of it against the real registry.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from invokeai.app.invocations.baseinvocation import BaseInvocation, InvocationRegistry
from invokeai.app.services.shared.graph import *  # noqa: F401 F403 -- imports all invocations, populating the registry

CONTRACT_PATH = (
    Path(__file__).parents[3]
    / "invokeai"
    / "frontend"
    / "webv2"
    / "src"
    / "features"
    / "generation"
    / "core"
    / "__snapshots__"
    / "generateGraphNodeTypes.json"
)


def _contract() -> dict[str, Any]:
    return json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


CONTRACT = _contract()
BY_BASE: dict[str, dict[str, Any]] = CONTRACT["byBase"]
FIELDS_BY_NODE_TYPE: dict[str, dict[str, list[str]]] = CONTRACT["fieldsByNodeType"]


def _invocation(node_type: str) -> type[BaseInvocation]:
    cls = InvocationRegistry.get_invocations_map().get(node_type)
    assert cls is not None, (
        f"webv2 compiles '{node_type}' into a generation graph but no invocation is registered under "
        f"that type. Either the node was renamed, or its module is no longer imported — see "
        f"tests/app/invocations/test_node_discovery.py."
    )
    return cls


def test_the_contract_covers_every_supported_base() -> None:
    """Guard against a contract that silently stopped being regenerated.

    An empty or truncated file would make every assertion below vacuous. 14 is the current length of
    webv2's `SUPPORTED_GENERATE_BASES`; a new architecture should update this number and the file in
    the same commit.
    """
    assert len(BY_BASE) == 14
    assert all(entry["nodeTypes"] for entry in BY_BASE.values())


@pytest.mark.parametrize("base", sorted(BY_BASE), ids=lambda base: base)
def test_every_node_type_a_base_compiles_is_registered(base: str) -> None:
    missing = [
        node_type
        for node_type in BY_BASE[base]["nodeTypes"]
        if node_type not in InvocationRegistry.get_invocations_map()
    ]
    assert missing == [], f"webv2's '{base}' graph uses unregistered node types: {missing}"


@pytest.mark.parametrize("node_type", sorted(FIELDS_BY_NODE_TYPE), ids=lambda node_type: node_type)
def test_edge_destination_fields_are_real_invocation_fields(node_type: str) -> None:
    """An edge into a field the invocation does not have is rejected when the graph is enqueued."""
    cls = _invocation(node_type)
    unknown = sorted(set(FIELDS_BY_NODE_TYPE[node_type]["inputs"]) - set(cls.model_fields))
    assert unknown == [], f"webv2 wires edges into unknown inputs on '{node_type}': {unknown}"


@pytest.mark.parametrize("node_type", sorted(FIELDS_BY_NODE_TYPE), ids=lambda node_type: node_type)
def test_edge_source_fields_are_real_output_fields(node_type: str) -> None:
    """The other half: an edge out of a field the invocation's output does not expose."""
    cls = _invocation(node_type)
    output_fields = set(cls.get_output_annotation().model_fields)
    unknown = sorted(set(FIELDS_BY_NODE_TYPE[node_type]["outputs"]) - output_fields)
    assert unknown == [], f"webv2 wires edges out of unknown outputs on '{node_type}': {unknown}"
