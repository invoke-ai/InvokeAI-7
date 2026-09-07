import type {
  PreparedCommitOptions,
  StructuralCommitOptions,
  StructuralCommitResult,
} from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';
import type { PreparedDocumentEdit } from '@workbench/canvas-engine/document-model/documentCommands';
import type { CanvasMutationOrigin, CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';

import { createDocumentModel } from '@workbench/canvas-engine/document-model/documentModel';
import { checkEditPostconditions } from '@workbench/canvas-engine/document-model/postconditions';
import { createDocumentPatchEntry } from '@workbench/canvas-engine/history/documentPatch';

import type { CanvasMutationContext } from './mutationContext';

/** The edit revision a mutation's insertion was anchored at; a commit refuses an anchor captured earlier. */
const anchorRevisionOf = (mutation: CanvasProjectMutation): number | undefined => {
  switch (mutation.type) {
    case 'addCanvasLayer':
      return mutation.anchor.capturedEditRevision;
    case 'applyCanvasLayerStackMutation':
      return mutation.add?.[0]?.anchor.capturedEditRevision;
    default:
      return undefined;
  }
};

export type StructuralMutationContext = Pick<
  CanvasMutationContext,
  | 'canEdit'
  | 'capturePermit'
  | 'dispatch'
  | 'dispatchPrepared'
  | 'getDocument'
  | 'getEditRevision'
  | 'getReducerDocument'
  | 'history'
  | 'isGestureActive'
  | 'projectId'
>;

export type StructuralFailureReport =
  | 'Structural edit could not be reverted'
  | 'Structural edit could not be mirrored'
  | 'Structural history replay was refused'
  | 'Structural history replay could not be mirrored';

export interface StructuralLayerControllerOptions {
  readonly ctx: StructuralMutationContext;
  readonly getSelectedLayerIds?: (document: CanvasDocumentContractV3) => readonly string[];
  readonly report?: (message: StructuralFailureReport, label: string, error: unknown) => void;
  readonly now?: () => number;
  /** Defers a preview flush to the next paint, returning a cancel. Defaults to rAF, synchronous without one. */
  readonly schedulePreview?: (flush: () => void) => () => void;
}

const defaultSchedulePreview = (flush: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    flush();
    return () => undefined;
  }
  const frame = requestAnimationFrame(flush);
  return () => cancelAnimationFrame(frame);
};

interface NudgeBurst {
  expiresAt: number;
  selectionKey: string;
  origins: readonly { id: string; x: number; y: number }[];
}

const NUDGE_COALESCE_MS = 500;

const positionMutation = (positions: readonly { id: string; x: number; y: number }[]): CanvasProjectMutation => ({
  type: 'setCanvasLayerPositions',
  updates: [...positions],
});

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** Owns guarded, failure-atomic structural document edits and nudge coalescing. */
export class StructuralLayerController {
  private burst: NudgeBurst | null = null;
  private disposed = false;
  private readonly now: () => number;
  private pendingPreview: CanvasProjectMutation | null = null;
  private cancelPreviewFlush: (() => void) | null = null;

  constructor(private readonly deps: StructuralLayerControllerOptions) {
    this.now = deps.now ?? Date.now;
  }

  /** A commit supersedes any preview still waiting for its frame. */
  private discardPendingPreview(): void {
    this.cancelPreviewFlush?.();
    this.cancelPreviewFlush = null;
    this.pendingPreview = null;
  }

  endBurst(): void {
    this.burst = null;
  }

  canCommit(): boolean {
    const { ctx } = this.deps;
    return !this.disposed && ctx.canEdit() && !ctx.isGestureActive();
  }

  commit(
    label: string,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation,
    options: StructuralCommitOptions = {}
  ): StructuralCommitResult {
    const refusal = this.refuse({
      ...options,
      expectedRevision: options.expectedRevision ?? anchorRevisionOf(forward) ?? anchorRevisionOf(inverse),
    });
    if (refusal) {
      return refusal;
    }
    this.endBurst();
    this.discardPendingPreview();
    const applied = this.apply(label, forward, inverse, options.verify);
    if (applied.status === 'committed') {
      this.deps.ctx.history.push(this.entry(label, forward, inverse));
    }
    return applied;
  }

  /** A prepared flat edit: refused as `stale` unless its revision and project still match, verified by its postconditions. */
  commitPrepared(
    label: string,
    edit: PreparedDocumentEdit,
    options: PreparedCommitOptions = {}
  ): StructuralCommitResult {
    const refusal = this.refuse({ expectedRevision: edit.expectedRevision });
    if (refusal) {
      return refusal;
    }
    if (edit.projectId !== this.deps.ctx.projectId) {
      return { status: 'dispatch-rejected' };
    }
    this.endBurst();
    this.discardPendingPreview();
    const applied = this.apply(
      label,
      edit.forward,
      edit.inverse,
      (document) => checkEditPostconditions(document, edit.postconditions),
      options.origin
    );
    if (applied.status === 'committed' && edit.history === 'record') {
      this.deps.ctx.history.push(this.entry(label, edit.forward, edit.inverse));
    }
    return applied;
  }

  /**
   * Live gesture previews coalesce to one dispatch per frame: sliders, color
   * pickers and curve drags fire per pointer move, and every dispatch fans out
   * to the whole project-state subscriber tree. `true` means accepted, not
   * delivered — a lock, gesture, or dispose landing before the flush drops it.
   */
  preview(action: CanvasProjectMutation): boolean {
    if (!this.canCommit()) {
      return false;
    }
    this.pendingPreview = action;
    if (this.cancelPreviewFlush === null) {
      const schedule = this.deps.schedulePreview ?? defaultSchedulePreview;
      // The scheduler may flush synchronously (no rAF); the cancel handle must not outlive the flush.
      let flushed = false;
      const cancel = schedule(() => {
        flushed = true;
        this.cancelPreviewFlush = null;
        const pending = this.pendingPreview;
        this.pendingPreview = null;
        if (pending && this.canCommit()) {
          this.deps.ctx.dispatch(pending);
        }
      });
      this.cancelPreviewFlush = flushed ? null : cancel;
    }
    return true;
  }

  nudge(dx: number, dy: number): StructuralCommitResult {
    const { ctx } = this.deps;
    const refusal = this.refuse({});
    if (refusal) {
      return refusal;
    }
    const document = ctx.getDocument();
    if (!document?.selectedLayerId) {
      return { status: 'dispatch-rejected' };
    }
    const ids = unique([document.selectedLayerId, ...(this.deps.getSelectedLayerIds?.(document) ?? [])]);
    const model = createDocumentModel(document, { editRevision: ctx.getEditRevision(), projectId: ctx.projectId });
    const prepared = model.prepare({ dx, dy, ids, type: 'translate' });
    if (prepared.status !== 'prepared' || prepared.edit.forward.type !== 'setCanvasLayerPositions') {
      return { status: 'dispatch-rejected' };
    }
    const leaves = model.compileLeaves();
    if (prepared.edit.touchedIds.some((id) => !leaves.find((leaf) => leaf.id === id)?.contributionEnabled)) {
      return { status: 'dispatch-rejected' };
    }
    const selectionKey = prepared.edit.touchedIds.join('\0');
    const now = this.now();
    const coalesce = !!this.burst && this.burst.selectionKey === selectionKey && now < this.burst.expiresAt;
    const origins =
      coalesce && this.burst
        ? this.burst.origins
        : (prepared.edit.inverse as Extract<CanvasProjectMutation, { type: 'setCanvasLayerPositions' }>).updates;
    const label = 'Nudge layer';
    const forward = prepared.edit.forward;
    const inverse = positionMutation(origins);
    const applied = this.apply(label, forward, inverse, (next) =>
      checkEditPostconditions(next, prepared.edit.postconditions)
    );
    if (applied.status !== 'committed') {
      this.burst = null;
      return applied;
    }
    const entry = this.entry(label, forward, inverse);
    if (coalesce) {
      ctx.history.amendLast(entry);
    } else {
      ctx.history.push(entry);
    }
    this.burst = { expiresAt: now + NUDGE_COALESCE_MS, origins, selectionKey };
    return applied;
  }

  dispose(): void {
    this.disposed = true;
    this.endBurst();
    this.discardPendingPreview();
  }

  private refuse(options: StructuralCommitOptions): StructuralCommitResult | null {
    const { ctx } = this.deps;
    if (this.disposed) {
      return { status: 'not-ready' };
    }
    if (!ctx.capturePermit()) {
      return { status: 'busy' };
    }
    if (ctx.isGestureActive()) {
      return { status: 'gesture-active' };
    }
    if (!ctx.getReducerDocument()) {
      return { status: 'not-ready' };
    }
    const actualRevision = ctx.getEditRevision();
    if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) {
      return { actualRevision, expectedRevision: options.expectedRevision, status: 'stale' };
    }
    return null;
  }

  /** Dispatches `forward` once through the guarded context; a verified failure applies `inverse`. */
  private apply(
    label: string,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation,
    verify: (document: CanvasDocumentContractV3) => boolean = () => true,
    origin?: CanvasMutationOrigin
  ): StructuralCommitResult {
    const { ctx } = this.deps;
    const before = ctx.getReducerDocument();
    const isMirrored = (): boolean => ctx.getDocument() === ctx.getReducerDocument();
    const isApplied = (): boolean => {
      const document = ctx.getReducerDocument();
      return document !== null && document !== before && verify(document);
    };
    try {
      ctx.dispatchPrepared(forward, isApplied, isMirrored, origin);
      return { status: 'committed' };
    } catch (error) {
      const after = ctx.getReducerDocument();
      if (after === before) {
        return { status: 'dispatch-rejected' };
      }
      let recoveryError: unknown = error;
      try {
        ctx.dispatchPrepared(inverse, () => ctx.getReducerDocument() !== after, isMirrored, 'system');
      } catch (inverseError) {
        recoveryError = inverseError;
      }
      const recovered =
        ctx.getReducerDocument() === after ? 'unreverted' : isMirrored() ? 'reverted' : 'reverted-unmirrored';
      if (recovered === 'unreverted') {
        this.deps.report?.('Structural edit could not be reverted', label, recoveryError);
      } else if (recovered === 'reverted-unmirrored') {
        this.deps.report?.('Structural edit could not be mirrored', label, recoveryError);
      }
      return { recovered, status: 'postcondition-failed' };
    }
  }

  private entry(label: string, forward: CanvasProjectMutation, inverse: CanvasProjectMutation) {
    return createDocumentPatchEntry({
      dispatch: (action) => this.replay(label, action, forward, inverse),
      forward,
      inverse,
      label,
      replayFailureAtomic: true,
    });
  }

  /**
   * A reducer that refuses a replay (its target changed since) is expected: the entry moves as a
   * no-op and the refusal is reported. A mirror that cannot follow an accepted replay is not: the
   * opposite action restores the reducer and the failure surfaces.
   */
  private replay(
    label: string,
    action: CanvasProjectMutation,
    forward: CanvasProjectMutation,
    inverse: CanvasProjectMutation
  ): void {
    const { ctx } = this.deps;
    const before = ctx.getReducerDocument();
    try {
      ctx.dispatchPrepared(
        action,
        () => ctx.getReducerDocument() !== before,
        () => ctx.getDocument() === ctx.getReducerDocument()
      );
    } catch (error) {
      if (ctx.getReducerDocument() === before) {
        this.deps.report?.('Structural history replay was refused', label, error);
        return;
      }
      this.deps.report?.('Structural history replay could not be mirrored', label, error);
      ctx.dispatch(action === forward ? inverse : forward, 'system');
      throw error;
    }
  }
}
