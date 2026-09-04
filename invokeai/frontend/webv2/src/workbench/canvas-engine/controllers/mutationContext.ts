import type { LayerExportGuard } from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3, CanvasStackForests } from '@workbench/canvas-engine/contracts';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency, DocumentEditPermit } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type {
  CanvasEditIntent,
  CanvasMutationOrigin,
  CanvasProjectMutation,
} from '@workbench/canvas-engine/mutationContracts';
import type { PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { EMPTY_STACKS } from '@workbench/canvas-engine/document/documentTree';
import { captureInsertionAnchor, captureRestoreAnchor } from '@workbench/canvas-engine/document/insertionAnchors';

/**
 * The shared mutation substrate handed to canvas controllers: the guarded
 * document-mutation protocol (the edit-concurrency surface, prepared-cache
 * dispatch with reducer/mirror postconditions, layer-cache replacement install),
 * plus the small set of engine services every mutating controller needs.
 */
export interface CanvasMutationContext extends CanvasEditConcurrency {
  readonly history: History;
  getDocument(): CanvasDocumentContractV3 | null;
  getReducerDocument(): CanvasDocumentContractV3 | null;
  /** Where a new `stack` layer lands: above `aboveId` when it belongs to the stack, else the stack top. */
  captureInsertionAnchor(stack: LayerStackKind, aboveId: string | null): CanvasNodeInsertionAnchor;
  /** The anchor that restores `layerId` between its current same-stack neighbours; null when absent. */
  captureRestoreAnchor(layerId: string): CanvasNodeInsertionAnchor | null;
  isGuardCurrent(guard: LayerExportGuard): boolean;
  dispatch(action: CanvasProjectMutation, origin?: CanvasMutationOrigin): boolean;
  dispatchPrepared(
    action: CanvasProjectMutation,
    reducerAccepted: () => boolean,
    mirrorAccepted: () => boolean,
    origin?: CanvasMutationOrigin
  ): void;
  preparePixels(layerId: string, rect: Rect, pixels: RasterSurface): PreparedLayerCacheReplacement;
  installPrepared(prepared: PreparedLayerCacheReplacement, persist?: boolean): void;
  endBurst(): void;
  createLayerId(): string;
}

/** Engine-side wiring for {@link createCanvasMutationContext}. */
export interface CanvasMutationContextDeps {
  readonly projectId: string;
  readonly history: History;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly subscribeReducer: (listener: () => void) => () => void;
  readonly dispatch: (action: CanvasProjectMutation, origin?: CanvasMutationOrigin) => boolean;
  readonly commitEdit: (intent: CanvasEditIntent) => void;
  readonly refreshMirror: () => void;
  readonly editingLocked: { get(): boolean; subscribe(listener: () => void): () => void };
  readonly editOwner: symbol;
  readonly isGuardCurrent: (guard: LayerExportGuard) => boolean;
  readonly preparePixels: (layerId: string, rect: Rect, pixels: RasterSurface) => PreparedLayerCacheReplacement;
  readonly installPrepared: (prepared: PreparedLayerCacheReplacement, persist?: boolean) => void;
  readonly endBurst: () => void;
  readonly isGestureActive: () => boolean;
  readonly createLayerId: () => string;
}

/**
 * Creates the shared mutation substrate. Owns the document-edit permit epoch
 * machine (subscribed to the editing-lock store until {@link dispose}) and the
 * prepared-mutation dispatch postcondition protocol; everything else delegates
 * to the engine through `deps`.
 */
export const createCanvasMutationContext = (
  deps: CanvasMutationContextDeps
): CanvasMutationContext & { dispose(): void } => {
  let documentEditEpoch = 0;
  let documentEditingLocked = false;
  const syncDocumentEditingLock = (): void => {
    const nextLocked = deps.editingLocked.get();
    if (nextLocked !== documentEditingLocked) {
      documentEditingLocked = nextLocked;
      documentEditEpoch += 1;
    }
  };
  const unsubscribeDocumentEditingLock = deps.editingLocked.subscribe(syncDocumentEditingLock);
  let editRevision = 0;
  let observedDocument = deps.getReducerDocument();
  const syncEditRevision = (): void => {
    const document = deps.getReducerDocument();
    if (document !== observedDocument) {
      observedDocument = document;
      editRevision += 1;
    }
  };
  const unsubscribeReducer = deps.subscribeReducer(syncEditRevision);
  const getEditRevision = (): number => {
    syncEditRevision();
    return editRevision;
  };
  const currentStacks = (): CanvasStackForests => deps.getDocument()?.stacks ?? EMPTY_STACKS;
  const canEdit = (owner?: symbol): boolean => owner === deps.editOwner || !deps.editingLocked.get();
  const capturePermit = (owner?: symbol): DocumentEditPermit | null =>
    canEdit(owner) ? { epoch: documentEditEpoch, owner } : null;
  const isPermitCurrent = (permit: DocumentEditPermit): boolean =>
    permit.owner === deps.editOwner || (!deps.editingLocked.get() && permit.epoch === documentEditEpoch);

  const dispatchPrepared = (
    action: CanvasProjectMutation,
    isApplied: () => boolean,
    isMirrored: () => boolean,
    origin: CanvasMutationOrigin = deps.history.isApplying() ? 'system' : 'user'
  ): void => {
    try {
      // Prepared mutations are not route-worthy until both reducer and mirror
      // postconditions succeed. Commit their edit intent separately below.
      if (!deps.dispatch(action, 'system')) {
        throw new Error('Canvas document mutation was rejected');
      }
    } catch (error) {
      // Store subscribers run after the reducer has accepted an action. A
      // faulty observer must not strand an applied document mutation before
      // its matching engine state and history are published. Preserve real
      // reducer/dispatch failures by swallowing only when the exact intended
      // postcondition is visible in the authoritative reducer state.
      if (!isApplied()) {
        throw error;
      }
      // Notification may have been interrupted before DocumentMirror's
      // subscriber ran. Reconcile it synchronously from authoritative state
      // before publishing follow-up state or history.
      try {
        deps.refreshMirror();
      } catch (refreshError) {
        if (!isMirrored()) {
          throw refreshError;
        }
      }
      if (!isMirrored()) {
        throw error;
      }
    }

    // A reducer may reject a guarded transaction by returning the unchanged
    // state without throwing. Do not install its prepared cache or consume a
    // failure-atomic history entry unless the authoritative postcondition
    // actually landed.
    if (!isApplied()) {
      throw new Error('Canvas document mutation was rejected');
    }
    if (!isMirrored()) {
      try {
        deps.refreshMirror();
      } catch (refreshError) {
        if (!isMirrored()) {
          throw refreshError;
        }
      }
      if (!isMirrored()) {
        throw new Error('Canvas document mutation was not mirrored');
      }
    }

    if (origin === 'user') {
      try {
        deps.commitEdit({ kind: 'mutation', mutation: action });
      } catch {
        // Reducer and mirror acceptance are the transaction boundary. Routing
        // the resulting edit intent is ancillary after that point; surfacing an
        // observer failure would invite callers to roll back only their cache
        // half and split it from the accepted document contract.
      }
    }
  };

  return {
    canEdit,
    captureInsertionAnchor: (stack, aboveId) =>
      captureInsertionAnchor(currentStacks(), {
        aboveId,
        editRevision: getEditRevision(),
        projectId: deps.projectId,
        stack,
      }),
    capturePermit,
    captureRestoreAnchor: (layerId) =>
      captureRestoreAnchor(currentStacks(), layerId, deps.projectId, getEditRevision()),
    createLayerId: () => deps.createLayerId(),
    dispatch: (action, origin) => deps.dispatch(action, origin),
    dispatchPrepared,
    dispose: () => {
      unsubscribeDocumentEditingLock();
      unsubscribeReducer();
    },
    endBurst: () => deps.endBurst(),
    getDocument: () => deps.getDocument(),
    getEditRevision,
    getReducerDocument: () => deps.getReducerDocument(),
    history: deps.history,
    installPrepared: (prepared, persist) => deps.installPrepared(prepared, persist),
    isGestureActive: () => deps.isGestureActive(),
    isGuardCurrent: (guard) => deps.isGuardCurrent(guard),
    isPermitCurrent,
    projectId: deps.projectId,
    preparePixels: (layerId, rect, pixels) => deps.preparePixels(layerId, rect, pixels),
  };
};
