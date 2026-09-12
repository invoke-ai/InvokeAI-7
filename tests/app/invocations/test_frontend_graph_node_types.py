"""The graphs webv2 compiles must be buildable from the invocations this backend registers.

The frontend builds generation graphs from its own per-base tables and never imports a backend
schema, so a node type or field that moves, is renamed, or loses its module import fails at
*enqueue* time with a validation error against a graph the user cannot edit. Nothing in either test
suite sees that on its own: the frontend only knows the strings it emits, and the backend only knows
the invocations it has.

The contract in between is `generateGraphNodeTypes.json`, written by
`src/features/generation/core/graphCoverage.test.ts` (regenerate with `vitest -u`). It records every
node type, every edge field, and every *literal* input value — the ones webv2 writes straight onto a
node, with no edge to record them — that `compileGenerateGraph` produces for every supported
architecture. This module checks all of it against the real registry.

The literal values are checked against the field's own annotation, not merely against its name. That
is where the frontend is blindest: it picks a scheduler from its own `FLOW_SCHEDULER_OPTIONS` while
`ernie_image_denoise.scheduler` is a three-value `Literal`, and nothing but this comparison relates
the two.
"""

import json
from pathlib import Path
from typing import Annotated, Any

import pytest
from pydantic import TypeAdapter, ValidationError

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
FIELDS_BY_NODE_TYPE: dict[str, dict[str, Any]] = CONTRACT["fieldsByNodeType"]


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


def test_the_contract_records_the_values_webv2_writes_onto_nodes() -> None:
    """The literal section going vacuous is the failure mode the edge-only contract already had.

    A recording bug that dropped the values while keeping the names would leave every annotation
    check below passing over an empty list. Both floors are well under the current numbers (58 node
    types carry literals, 241 scalar values between them) — they separate "recorded" from "empty",
    not one architecture from the next.
    """
    with_literals = [node_type for node_type, entry in FIELDS_BY_NODE_TYPE.items() if entry["literalInputs"]]
    recorded_values = sum(
        len(values) for entry in FIELDS_BY_NODE_TYPE.values() for values in entry["literalInputs"].values()
    )

    assert len(with_literals) >= 40
    assert recorded_values >= 150


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


def _annotation(cls: type[BaseInvocation], field_name: str) -> Any:
    """The field's annotation together with the constraints declared beside it.

    `multiple_of=16` on a denoise node's `width` lives in `FieldInfo.metadata`, not in the
    annotation, and it is exactly the kind of bound the frontend restates in its own table
    (`BASE_GENERATION['ernie-image'].dimensions.grid`) with nothing relating the two.
    """
    field = cls.model_fields[field_name]
    return Annotated[tuple([field.annotation, *field.metadata])] if field.metadata else field.annotation


SILENTLY_IGNORED: dict[str, set[str]] = {
    # `color_compensation` is a field of `i2l`, the *encode* node — legacy web sets it only there,
    # on the img2img/inpaint/outpaint paths. webv2 writes it onto the `l2i` decode node instead
    # (`graph.ts`, `l2iProps`), where no such field exists, so the Generate tab's SDXL colour
    # -compensation toggle changes nothing about the generated image. Invocations ignore extra
    # fields rather than rejecting them, which is why this never surfaced as an enqueue error.
    "l2i": {"color_compensation"},
}
"""Inputs webv2 writes that the invocation does not declare.

Not an exemption list: the assertion below is an equality, so a new mismatch fails here and so does
fixing one of these — the entry has to be deleted with the fix. Each is a silent no-op today,
because `BaseInvocation` does not forbid extra fields.
"""


@pytest.mark.parametrize("node_type", sorted(FIELDS_BY_NODE_TYPE), ids=lambda node_type: node_type)
def test_literal_inputs_are_real_invocation_fields(node_type: str) -> None:
    """The half no edge records: a field webv2 sets directly, with no edge to point at it."""
    cls = _invocation(node_type)
    if cls.model_config.get("extra") == "allow":
        # `CoreMetadataInvocation` is an open bag by design — `invoke` dumps whatever was set on it
        # into the image's metadata record — so there is no closed field set to check against.
        pytest.skip(f"'{node_type}' accepts extra fields by design")

    unknown = sorted(set(FIELDS_BY_NODE_TYPE[node_type]["literalInputs"]) - set(cls.model_fields))
    assert unknown == sorted(SILENTLY_IGNORED.get(node_type, set())), (
        f"webv2 sets inputs '{node_type}' does not declare: {unknown}. They are ignored rather than "
        f"rejected, so whatever they were meant to do silently does not happen."
    )


@pytest.mark.parametrize("node_type", sorted(FIELDS_BY_NODE_TYPE), ids=lambda node_type: node_type)
def test_literal_input_values_satisfy_the_field_they_are_written_to(node_type: str) -> None:
    """A name that still exists but no longer accepts the value is the same enqueue failure.

    The scheduler fields are the motivating case: webv2 offers its own option list per base, the
    node declares a `Literal`, and until the two are compared here an option the node never accepted
    reaches the user as a validation error after they press Invoke.
    """
    cls = _invocation(node_type)
    rejected: list[str] = []

    for field_name, values in sorted(FIELDS_BY_NODE_TYPE[node_type]["literalInputs"].items()):
        if field_name not in cls.model_fields:
            continue  # Reported by the test above; a missing field has no annotation to check.
        adapter = TypeAdapter(_annotation(cls, field_name))
        for value in values:
            try:
                adapter.validate_python(value)
            except ValidationError as error:
                rejected.append(f"{field_name}={value!r}: {error.errors()[0]['msg']}")

    assert rejected == [], f"webv2 writes values '{node_type}' rejects: {'; '.join(rejected)}"
