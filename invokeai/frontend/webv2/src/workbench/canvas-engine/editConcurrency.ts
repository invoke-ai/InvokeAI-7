/**
 * The canvas edit-concurrency model. Controllers that capture permits receive
 * {@link CanvasEditConcurrency} as their mutation context; synchronous guards
 * read `canEdit` and `isGestureActive` from the same context. The engine keeps
 * four mechanisms behind it.
 *
 * Leases (`editGate.ts`, exposed as the engine's edit capability): at most one
 * exclusive canvas operation per engine (today `filter` and `select-object`).
 * A lease is acquired for an identity, carries an abort signal, and is
 * invalidated when the document is replaced, when the project changes, and on
 * any contract or pixel change to its own layer. The editing controller owns
 * the gate and hands it to canvas operations.
 *
 * Permits ({@link DocumentEditPermit}): a claim on the editing-lock epoch. A
 * commit captures one before async work and re-checks it before publishing;
 * every lock transition bumps the epoch, and the lock owner bypasses the lock.
 *
 * Gesture guard: structural commits, pixel commits and history replay refuse
 * while a pointer gesture owns the surface. Tools commit through their own
 * stroke path; the floating selection is guarded when it is lifted, not when
 * it is baked back.
 *
 * Project identity and edit revision: insertion anchors carry the engine's
 * project id and the edit revision they were captured at; export guards carry
 * the project id, the layer reference, its cache version and the document
 * generation they observed; structural commit options carry an expected
 * revision. The reducer refuses another project's anchor; a structural commit
 * refuses a mismatched revision as `stale`.
 *
 * {@link CanvasTransactionOutcome} is what the runtime reports when a
 * transaction could not run. The document model reports command refusals with
 * its own vocabulary (`canvas-engine/document/commandRefusal.ts`), which never
 * depends on runtime concepts; a runtime result type may list both, naming
 * each member through {@link SubsetOf} so a near-miss variant cannot compile.
 */
export interface CanvasEditConcurrency {
  readonly projectId: string;
  canEdit(owner?: symbol): boolean;
  capturePermit(owner?: symbol): DocumentEditPermit | null;
  isPermitCurrent(permit: DocumentEditPermit): boolean;
  isGestureActive(): boolean;
  /** Counts reducer document identities; a captured value is stale once any edit lands. */
  getEditRevision(): number;
}

export interface DocumentEditPermit {
  readonly epoch: number;
  readonly owner?: symbol;
}

export type CanvasTransactionOutcome = 'busy' | 'gesture-active' | 'stale' | 'aborted' | 'not-ready';

/** Names members of a vocabulary; a member outside `T` is a compile error rather than a silent drop. */
export type SubsetOf<T, U extends T> = U;
