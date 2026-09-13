---
title: Loop Nodes Architecture
---

This page records the implementation contract for the collection-based `For` and `ForReturn` nodes. The durable
contract is shared by the backend graph executor, saved workflow format, and workflow editor.

## Core contract

`For` is a bounded collection loop, not a general `While` node. Its source is one `collection: list[Any]` input. Each
iteration exposes `item`, `index`, `total`, and `state`; the final execution surface exposes `output_collection` and
`final_state`. `ForReturn` closes one iteration and may provide an output item, updated state, and a
`continue_condition`.

Loop state is explicit `LoopState` graph data. It is copied and serialized with normal invocation inputs and results;
it is not stored in transient process-local context. If a return omits state, the previous state carries forward. A
missing or `None` continue condition continues; `False` finalizes the current loop after recording its output and state.

The loop is sequential. A body failure or cancellation stops later iterations and does not release partial final-scoped
outputs. An empty collection is successful: no body node runs, `output_collection` is empty, and `final_state` is the
provided initial state or an empty state.

## Durable loop linkage

Every `For` and `ForReturn` pair has one canonical runtime `loop_linkage` edge:

```text
For.loop_linkage - - - - - - - - - - - - - - - - - > ForReturn.loop_linkage
For.item -> body path -> ForReturn.output
```

This edge is an association, not executable data flow. It is excluded from ordinary input propagation, cycle detection,
and scheduling. The backend requires exactly one outgoing linkage for every `For`, exactly one incoming linkage for every
`ForReturn`, and the exact `For.loop_linkage` to `ForReturn.loop_linkage` endpoints. Default edges using the reserved
`loop_linkage` field are invalid.

Authoring workflow JSON may represent the association through a one-to-one connector alias:

```text
For.loop_linkage -> connector.in -> connector.out -> ForReturn.loop_linkage
```

Every connector on that path must have exactly one input and one output. The path cannot branch, be reused as ordinary
data flow, or terminate at a different node. Graph construction canonicalizes a complete valid alias to one direct
runtime `loop_linkage` edge. No loop identity or body metadata is inferred from arbitrary topology or migrated from
unrelated fields.

## Body and output scopes

Iteration-scoped outputs (`item`, `index`, `total`, and `state`) define the loop body. Final-scoped outputs
(`output_collection` and `final_state`) are available only after the matching loop context completes. Body nodes must
terminate at the linked `ForReturn`; they cannot escape directly to after-loop nodes. Final outputs cannot feed back into
the loop body.

`ForReturn.output` and `ForReturn.state` are scheduler-facing result fields and are hidden as downstream editor outputs.
They are still retained in execution results for aggregation, persistence, and resume. Ordinary state helper nodes
(`state_empty`, `state_get`, `state_set`, and `state_merge`) carry explicit `LoopState` values through the body.

## Supported nested shapes

Nested `For` boundaries are supported recursively when each inner boundary has its own direct linkage and matching
`ForReturn`. The inner final collection may feed the parent return directly or through an ordinary parent-scoped
continuation. Independent inner loops must all feed one explicit fan-in continuation; collection concatenation, zipping,
or Cartesian semantics come from the connected collection operation, not from loop scheduling.

A bounded internal `Iterate` is supported only for the canonical outer-`For` shape: one ordinary preparation node
converts `For.item` to the inner collection, one ordinary body node consumes `Iterate.item`, and one `Collect` collapses
that item dimension before the parent `ForReturn`:

```text
For.item -> preparation -> Iterate.collection
Iterate.item -> body -> Collect.item
Collect.collection -> ForReturn.output
```

The fresh generic scheduler admits this exact shape when the outer collection is a non-empty literal and there is one
final consumer of `For.output_collection`. Each outer frame is isolated, including when the preparation node produces
an empty inner collection. A checkpoint after a nested iterator boundary restores the generic class-drain state and
continues the same frame/stream order. Input-driven outer collections, additional loop or control-flow nodes, escaped
body paths, and other mixed shapes remain on the compatibility scheduler.

Unsupported shapes, including independent iterator-derived body inputs, mixed nested `For`/`Iterate` bodies, escaping
body paths, ambiguous returns, and arbitrary cyclic graphs, are rejected before execution.

## Persistence and validation

Prepared execution nodes, source/prepared mappings, iteration paths, results, indegrees, and finalized loop contexts
are persisted through `GraphExecutionState`. Runtime-only queues and metadata are rebuilt when state is rehydrated.
Finalization is keyed by the loop source and its parent iteration path so nested or repeated contexts cannot mix output
collections or state.

The execution-engine seam is additive to this loop contract. The session runner applies each result through
`GraphExecutionState.apply()` using a stable execution reference and records frame-aware output tokens; accepted
`For`/`ForReturn` continuation state is mirrored by a typed, frame-scoped `ContinuationRecord`.
`ForInvocation` and `ForReturnInvocation` also declare one validated, frame-scoped
`continuation` effect per prepared invocation. The `For` effect starts the `for` continuation with the current
iteration and state; the `ForReturn` effect completes it with output, state, and the continue decision. These effects
are persisted under the invocation reference. Session-built effect references carry graph-state, durable-frame,
iteration-path, and workflow-call-depth identity, and stale or cross-scope effects are rejected before mutation. They
never encode `loop_linkage` as a data token. A fresh graph with exactly one static flat `For`/`ForReturn` pair,
including an empty literal collection, a supported non-empty input-driven collection producer, or the exact bounded
empty input-driven producer shape, now uses the generic scheduler adapter for readiness and continuation transitions.
Graph state owns the generic continuation boundary: it carries returned state, honors `continue_condition`, materializes the next body
iteration, and finalizes the aggregate. An empty literal collection completes through the existing synthetic terminal
`For` result without running the body or `ForReturn`. The generic scheduler remains opaque and never receives a literal
successor node ID. The compatibility continuation bridge is retained only for unsupported loop shapes and explicitly
legacy-loaded snapshots. Empty input-driven shapes outside the exact four-node/four-edge bounded topology, unsupported
input-driven outer collections, five-level-or-deeper or unsupported sibling nested loops, and unsupported mixed control flow remain on the
compatibility scheduler; the exact fresh two-sibling `For`/`ForReturn` `CollectionConcat` fan-in shape, the narrow canonical two-level, and exact fresh three-level and four-level serial nested-`For` shapes
(one literal outer collection, one direct child at each level, no continuation nodes) and the exact
bounded outer-`For`/`Iterate`/`Collect` shape are now generic-routed. This additive effect seam does not claim generic
scheduling for the remaining shapes. `Iterate` records ordered item tokens in
a closed `StreamBuffer`; an empty `Iterate` records an
explicit empty close. A direct `Iterate.item` consumer waits for the canonical stream to close, then `Collect` consumes
its ordered values; a missing stream falls back to materialized results for legacy snapshots. The exact fresh four-node
`literal collection source -> Iterate -> one ordinary body -> Collect` shape and any number of ordinary downstream
consumers from `Collect.collection` use a private graph-state planner for prepared-copy expansion, iteration paths,
and the empty-stream barrier. The exact fresh two-source/two-`Iterate`/shared-`Collect.item` and exact fresh
three-source/three-`Iterate`/shared-`Collect.item` fan-in shapes also use the planner for independent stream expansion,
closure gating, and deterministic source-ordered hydration. The exact fresh two-branch body-mediated shape,
`source_a -> Iterate_a -> body_a -> Collect.item` plus
`source_b -> Iterate_b -> body_b -> Collect.item`, is also planner-owned:
source IDs are ordered lexically, branch order is preserved, and `Collect` waits
for both streams to close, including empty streams. This is a private bounded
planner case with exactly seven nodes and six ordinary edges: two inputless
ordinary sources, two `Iterate` nodes, two ordinary bodies, and one `Collect`.
It has no `Collect.collection` input, downstream consumer, or extra topology.
Three or more body-mediated
branches, fan-in with four or more direct branches, nested or input-driven
iterators, and mixed control flow outside the bounded per-item
`Iterate`/`If`/`Collect` topology remain on the compatibility materializer.
Focused compatibility coverage now proves empty, nested, fan-in, partial/rehydrated, failed, canceled, and retried
Iterate/Collect sessions. This is evidence for the current adapters; it does not remove materialization or queue
ownership. Direct `Iterate`/`Collect`-only graphs and the exact bounded nested shape now use the generic scheduler
adapter: its readiness predicate waits for the canonical stream to close, and completion mirrors Iterate outputs into
that ledger before releasing Collect. Rehydration restores the active class-drain boundary so nested stream order is
preserved across dump/load.
For the exact fresh direct shape, the planner owns expansion, downstream admission, and empty closure atomically: a
failed expansion leaves no partial prepared copies to be resumed. Versioned queue checkpoints and retries preserve the existing durable
execution-state boundary and receive fresh execution identities. Materialization still owns those responsibilities for
fallback shapes. Mixed control-flow and queue lifecycle remain compatibility-owned. `loop_linkage`
remains association metadata and never becomes a data token.

The supported flat-loop differential gate covers generic/compatibility parity
for successful execution, carried and replaced state, early break, empty and
input-driven fallback routing, `None` output items, body/return failure,
partial rehydration, frame identity, and SQLite cancellation/retry isolation.
Continuation effects are normalized to JSON values and validated before
mutation: exact duplicate effects in one batch are retained once, while
conflicting terminal payloads (including type-distinct JSON values) are
rejected. Before scheduler completion, `ForInvocationOutput` and
`ForReturnInvocationOutput` continuation fields must match their prepared nodes;
the `For` item must match its prepared collection item, and effects must
independently match those values. Current versioned snapshots must include an
execution-effect ledger: every ledger key must name an executed prepared node,
and pending nodes, unknown references, missing executed markers, missing
continuation effects, and malformed ownership are rejected. Persisted `For`
outputs are checked against prepared iteration data and, after finalization,
the authoritative returned collection and final state. Unversioned legacy
snapshots retain their compatibility loader. A `For` start effect must match
the prepared index, collection total, and state; malformed effects leave the
graph state unchanged.
This evidence permits the supported flat routing slice only; it does not remove
the compatibility continuation/materialization owner for unsupported shapes.

`GraphExecutionState.complete()` remains the compatibility entry point for callers that already have a node result.
Its first JSON-safe completion uses the same validated, atomic ledger path as `apply()`, including output tokens and
synthetic `For`/`ForReturn` continuation effects. It still permits historical idempotent result replacement for an
already-applied node; arbitrary in-memory values that cannot be represented in the JSON ledger remain a scheduler-only
compatibility case and cannot be persisted. When an explicitly unversioned, partially completed legacy snapshot is
loaded, missing flat-loop continuation buckets are synthesized before a versioned re-save so the next load remains
valid. A loaded terminal legacy state may retain its empty in-memory ledger for compatibility, but
`dump_execution_state()` upgrades missing loop buckets in the versioned snapshot.

`IfInvocation` now declares the same seam for branch activation: it emits one frame-scoped activation token for the
selected branch, and the graph state validates and persists it after invocation. Fresh graphs with one ordinary-node `If`,
the exact one-level nested shape with two `If` nodes where the inner value feeds one outer branch and has no other
consumer, the exact bounded three-`If` chain with direct inner-to-middle-to-outer branch edges, the exact four-`If` nested
chain, or exactly two, exactly three, or exactly four independent ordinary-node sibling `If`s compile opaque, frame-local
activation dependencies in graph state. The three- and four-`If` admissions require `default` edges, all branch inputs
(`condition`, `true_input`, `false_input`) on each `If`, and no output from inner or middle `If` except its direct nested
branch edge; the four-`If` chain permits no extra output fan-out. Five-or-more nested `If`s, other fan-out, mixed
shapes outside the bounded per-item `Iterate`/`If`/`Collect` topology, loop-containing, saved-workflow, legacy, and
five-or-more sibling shapes use the compatibility scheduler with the dedicated
`_IfActivationController` fallback. Legacy snapshots retain their generic compatibility
projection. Legacy
skipped-state projection remains only for old snapshots. Fresh materialization prepares the condition boundary,
resolves the activation token, and attaches only the selected branch input; unselected branch nodes remain unprepared.
The generic and compatibility adapters consume the same decisions and append-only execution edges; no type-specific
branch scheduler prunes edges or propagates skips. Legacy skipped-state metadata remains only for snapshots that already
contain the old projection. `apply()` replaces the activation token by stable identity, and activation effects are
excluded from stream handling. Graph state derives branch membership for the supported fresh shape; the fallback
controller retains it for unsupported and legacy shapes. Author-time
activation
ports and literal successor IDs remain absent, while unsupported loop shapes and saved-workflow control flow remain on
their compatibility paths until differential coverage proves their generic replacements.

The engine still owns runtime node materialization and queue readiness for loop-containing graphs that require empty or
unsupported input-driven `For`, deeper nested/mixed control flow, and existing snapshots. Ordinary static DAGs, legacy-shaped `If` graphs,
direct `Iterate`/`Collect`-only graphs, and supported fresh static flat `For` graphs now use the generic opaque
plan/scheduler through a compatibility projection. This is intentional:
the generic records preserve tested loop semantics first, while the old execution graph remains the fallback for control
lowerings, legacy snapshots, and unsupported mixed loop shapes. No activation or stream ports are added to author-time
graph JSON.
Exact fresh serial nested-`Iterate` chains through eight levels use the generic planner for ordered frame expansion,
empty-stream closure, checkpoint rehydration, source completion, and failure parity. Nine-level or deeper chains,
five-level-or-deeper or unsupported sibling nested loops, and unsupported mixed shapes remain compatibility-owned. The exact fresh two-sibling `For`/`ForReturn` `CollectionConcat` fan-in shape and the exact fresh four-level serial nested-`For` shape are generic-routed. This migration does not modify any file under `invokeai/frontend/...`, including generated schemas; the existing
frontend/backend external interface remains frozen. Branch-membership analysis remains internal, while fresh execution
no longer creates skipped-state projection and old snapshots retain it for compatibility.

The frontend and backend validate the same boundary rules. Saved workflows preserve node types, field handles, and the
direct linkage edge. The current invocation templates provide output-scope metadata when a workflow is loaded. The
editor's boundary overlay and contextual `ForReturn` picker are presentation aids; they do not replace whole-graph
validation.

Collection helpers are ordinary explicit nodes: `CollectionConcat` preserves left-to-right order and accepts unequal
lengths, `CollectionZip` requires equal lengths, and `CollectionCartesian` produces deterministic left-major/right-minor
pairs with a 100,000-pair limit. They do not add implicit loop dimensions.
