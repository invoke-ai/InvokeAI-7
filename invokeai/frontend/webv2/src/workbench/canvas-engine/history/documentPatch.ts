/**
 * A structural history entry: a pair of reducer actions (forward + inverse)
 * dispatched to undo/redo a document-shape change. Unlike a pixel
 * {@link createImagePatchEntry | image patch}, it carries no bitmaps, so
 * structural edits share the engine-owned undo stack with paint edits at a
 * nominal byte cost.
 */

import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';

import type { HistoryEntry } from './history';

/** Nominal byte cost for a structural entry (small; actions are plain objects). */
export const DOCUMENT_PATCH_DEFAULT_BYTES = 256;

/** Options for {@link createDocumentPatchEntry}. */
export interface CreateDocumentPatchEntryOptions {
  label: string;
  /** The action that performs the change (dispatched on redo). */
  forward: CanvasProjectMutation;
  /** The action that reverses the change (dispatched on undo). */
  inverse: CanvasProjectMutation;
  /** Applies one side of the patch; may throw to leave a failure-atomic entry in place. */
  dispatch(action: CanvasProjectMutation): void;
  /** Approximate retained size (default {@link DOCUMENT_PATCH_DEFAULT_BYTES}). */
  bytes?: number;
  /** Marks the entry failure-atomic: `dispatch` must throw without applying for History to keep it in place. */
  replayFailureAtomic?: boolean;
}

/** Creates a reversible structural entry that dispatches inverse on undo, forward on redo. */
export const createDocumentPatchEntry = (opts: CreateDocumentPatchEntryOptions): HistoryEntry => {
  const { dispatch, forward, inverse, label } = opts;
  const bytes = opts.bytes ?? DOCUMENT_PATCH_DEFAULT_BYTES;

  return {
    bytes,
    label,
    redo: () => dispatch(forward),
    undo: () => dispatch(inverse),
    ...(opts.replayFailureAtomic ? { replayFailureAtomic: true } : {}),
  };
};
