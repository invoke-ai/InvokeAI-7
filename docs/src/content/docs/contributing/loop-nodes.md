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

Every `For` and `ForReturn` pair is associated by a serialized, direct `loop_linkage` edge:

```text
For.loop_linkage - - - - - - - - - - - - - - - - - > ForReturn.loop_linkage
For.item -> body path -> ForReturn.output
```

This edge is an association, not executable data flow. It is excluded from ordinary input propagation, cycle detection,
and scheduling. The backend requires exactly one outgoing linkage for every `For`, exactly one incoming linkage for every
`ForReturn`, and the exact `For.loop_linkage` to `ForReturn.loop_linkage` endpoints. Default edges using the reserved
`loop_linkage` field are invalid.

The editor may represent the association temporarily as a one-to-one connector alias:

```text
For.loop_linkage -> connector.in -> connector.out -> ForReturn.loop_linkage
```

Every connector on that path must have exactly one input and one output. The path cannot branch, be reused as ordinary
data flow, or terminate at a different node. Graph construction canonicalizes a complete alias to one direct runtime
`loop_linkage` edge. No loop identity or body metadata is inferred or migrated.

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

A bounded internal `Iterate` is supported only when one `Collect` collapses its item dimension before the parent
`ForReturn`:

```text
For.item -> Iterate.collection
Iterate.item -> body -> Collect.item
Collect.collection -> ForReturn.output
```

Unsupported shapes, including independent iterator-derived body inputs, mixed nested `For`/`Iterate` bodies, escaping
body paths, ambiguous returns, and arbitrary cyclic graphs, are rejected before execution.

## Persistence and validation

Prepared execution nodes, source/prepared mappings, iteration paths, results, indegrees, and finalized loop contexts
are persisted through `GraphExecutionState`. Runtime-only queues and metadata are rebuilt when state is rehydrated.
Finalization is keyed by the loop source and its parent iteration path so nested or repeated contexts cannot mix output
collections or state.

The frontend and backend validate the same boundary rules. Saved workflows preserve node types, field handles, and the
direct linkage edge. The current invocation templates provide output-scope metadata when a workflow is loaded. The
editor's boundary overlay and contextual `ForReturn` picker are presentation aids; they do not replace whole-graph
validation.

Collection helpers are ordinary explicit nodes: `CollectionConcat` preserves left-to-right order and accepts unequal
lengths, `CollectionZip` requires equal lengths, and `CollectionCartesian` produces deterministic left-major/right-minor
pairs with a 100,000-pair limit. They do not add implicit loop dimensions.
