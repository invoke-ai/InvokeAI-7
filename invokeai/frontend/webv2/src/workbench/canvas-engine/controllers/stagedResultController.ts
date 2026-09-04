import type { CommitStagedImageOptions, CommitStagedImageResult } from '@workbench/canvas-engine/capabilities';
import type {
  CanvasDocumentContractV3,
  CanvasRasterLayerContractV2,
  CanvasStagingCandidateContract,
  CanvasStateContractV3,
} from '@workbench/canvas-engine/contracts';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { ProjectEvent } from '@workbench/projectContracts';

import { getDocumentLayer, getDocumentLeaves, hasDocumentNode } from '@workbench/canvas-engine/document/documentIndex';
import { insertNodesAtAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import { haveSameStructure } from '@workbench/canvas-engine/document/layerStacks';
import { getCanvasStagingCandidateFingerprint } from '@workbench/canvasStagingView';

export interface StagedResultControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly captureInsertionAnchor: (stack: LayerStackKind, aboveId: string | null) => CanvasNodeInsertionAnchor;
  readonly createEventId: () => string;
  readonly createLayerId: () => string;
  readonly dispatchPrepared: (
    mutation: CanvasProjectMutation,
    reducerAccepted: () => boolean,
    mirrorAccepted: () => boolean,
    origin?: 'system' | 'user'
  ) => void;
  readonly endBurst: () => void;
  readonly getCanvasState: () => CanvasStateContractV3 | null;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly history: History;
  readonly now: () => string;
}

const createLayer = (
  id: string,
  name: string,
  candidate: CanvasStagingCandidateContract
): CanvasRasterLayerContractV2 => {
  const { placement } = candidate;
  return {
    blendMode: 'normal',
    id,
    isEnabled: true,
    isLocked: false,
    name,
    opacity: placement.opacity,
    source: {
      image: { height: candidate.height, imageName: candidate.imageName, width: candidate.width },
      type: 'image',
    },
    transform: {
      rotation: 0,
      scaleX: candidate.width === 0 ? 1 : placement.width / candidate.width,
      scaleY: candidate.height === 0 ? 1 : placement.height / candidate.height,
      x: placement.x,
      y: placement.y,
    },
    type: 'raster',
  };
};

/** Owns guarded, project-bound acceptance of staged canvas results. */
export class StagedResultController {
  private disposed = false;

  constructor(private readonly options: StagedResultControllerOptions) {}

  commit(options: CommitStagedImageOptions, owner?: symbol): CommitStagedImageResult {
    const o = this.options;
    if (this.disposed) {
      return { status: 'missing' };
    }
    const permit = o.concurrency.capturePermit(owner);
    if (!permit || o.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }
    const canvas = o.getCanvasState();
    if (!canvas) {
      return { status: 'missing' };
    }
    const candidateFingerprint = getCanvasStagingCandidateFingerprint(options.candidate);
    if (
      !canvas.stagingArea.pendingImages.some(
        (pending) => getCanvasStagingCandidateFingerprint(pending) === candidateFingerprint
      )
    ) {
      return { status: 'missing' };
    }
    if (!o.concurrency.isPermitCurrent(permit) || o.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }

    const continueStaging = options.continueStaging === true;
    const layer = {
      ...createLayer(o.createLayerId(), `Layer ${getDocumentLeaves(canvas.document).length + 1}`, options.candidate),
      isEnabled: !continueStaging,
    };
    const event: ProjectEvent = {
      createdAt: o.now(),
      id: o.createEventId(),
      summary: continueStaging
        ? `Saved ${options.candidate.imageName} as a disabled raster layer while continuing staging`
        : `Accepted ${options.candidate.imageName} into a new raster layer`,
      type: 'canvas-layer-accepted',
    };
    const previousSelectedLayerId = canvas.document.selectedLayerId;
    const previousStacks = canvas.document.stacks;
    const anchor = o.captureInsertionAnchor('raster', null);
    const acceptedStacks = insertNodesAtAnchor(previousStacks, anchor, [layer]);
    const previousStagingArea = canvas.stagingArea;
    const acceptedSelectedLayerId = continueStaging ? previousSelectedLayerId : layer.id;
    const hasPreviousLayerStack = (document: CanvasDocumentContractV3 | null): boolean =>
      document?.selectedLayerId === previousSelectedLayerId &&
      !hasDocumentNode(document, layer.id) &&
      haveSameStructure(document.stacks, previousStacks);
    const hasAcceptedLayerStack = (document: CanvasDocumentContractV3 | null): boolean =>
      document?.selectedLayerId === acceptedSelectedLayerId &&
      getDocumentLayer(document, layer.id) === layer &&
      haveSameStructure(document.stacks, acceptedStacks);
    const isCommitted = (next: CanvasStateContractV3 | null): boolean =>
      next?.document.selectedLayerId === acceptedSelectedLayerId &&
      getDocumentLayer(next.document, layer.id) === layer &&
      (continueStaging
        ? next.stagingArea === previousStagingArea
        : next.stagingArea.pendingImages.length === 0 &&
          next.stagingArea.pendingImageIds.length === 0 &&
          next.stagingArea.selectedImageIndex === 0 &&
          !next.stagingArea.isVisible);
    const isMirrored = (): boolean =>
      o.getDocument()?.selectedLayerId === acceptedSelectedLayerId &&
      getDocumentLayer(o.getDocument(), layer.id) === layer;

    try {
      o.endBurst();
      o.dispatchPrepared(
        {
          anchor,
          candidateFingerprint,
          continueStaging,
          event,
          layer,
          selectedImageIndex: options.selectedImageIndex,
          type: 'commitStagedImage',
        },
        () => isCommitted(o.getCanvasState()),
        isMirrored
      );
    } catch {
      if (isCommitted(o.getCanvasState())) {
        o.dispatchPrepared(
          {
            continueStaging,
            event,
            layer,
            selectedLayerId: previousSelectedLayerId,
            stagingArea: previousStagingArea,
            type: 'rollbackStagedImageCommit',
          },
          () =>
            hasPreviousLayerStack(o.getCanvasState()?.document ?? null) &&
            o.getCanvasState()?.stagingArea === previousStagingArea,
          () => hasPreviousLayerStack(o.getDocument()),
          'system'
        );
      }
      return { status: 'stale' };
    }

    const applyLayerStack = (
      mutation: Extract<CanvasProjectMutation, { type: 'applyCanvasLayerStackMutation' }>,
      reducerAccepted: () => boolean,
      mirrorAccepted: () => boolean,
      rollback: Extract<CanvasProjectMutation, { type: 'applyCanvasLayerStackMutation' }>,
      reducerRolledBack: () => boolean,
      mirrorRolledBack: () => boolean
    ): void => {
      try {
        o.dispatchPrepared(mutation, reducerAccepted, mirrorAccepted);
      } catch (error) {
        if (reducerAccepted()) {
          o.dispatchPrepared(rollback, reducerRolledBack, mirrorRolledBack, 'system');
        }
        throw error;
      }
    };
    const addAcceptedLayer: Extract<CanvasProjectMutation, { type: 'applyCanvasLayerStackMutation' }> = {
      add: [{ anchor, nodes: [layer] }],
      enabledUpdates: [],
      selectedLayerId: acceptedSelectedLayerId,
      type: 'applyCanvasLayerStackMutation',
    };
    const removeAcceptedLayer: Extract<CanvasProjectMutation, { type: 'applyCanvasLayerStackMutation' }> = {
      enabledUpdates: [],
      removeIds: [layer.id],
      selectedLayerId: previousSelectedLayerId,
      type: 'applyCanvasLayerStackMutation',
    };
    o.history.push({
      bytes: 256,
      label: continueStaging ? 'Save staged image as disabled layer' : 'Accept staged image',
      redo: () =>
        applyLayerStack(
          addAcceptedLayer,
          () => hasAcceptedLayerStack(o.getCanvasState()?.document ?? null),
          () => hasAcceptedLayerStack(o.getDocument()),
          removeAcceptedLayer,
          () => hasPreviousLayerStack(o.getCanvasState()?.document ?? null),
          () => hasPreviousLayerStack(o.getDocument())
        ),
      replayFailureAtomic: true,
      undo: () =>
        applyLayerStack(
          removeAcceptedLayer,
          () => hasPreviousLayerStack(o.getCanvasState()?.document ?? null),
          () => hasPreviousLayerStack(o.getDocument()),
          addAcceptedLayer,
          () => hasAcceptedLayerStack(o.getCanvasState()?.document ?? null),
          () => hasAcceptedLayerStack(o.getDocument())
        ),
    });
    return { layerId: layer.id, status: 'committed' };
  }

  dispose(): void {
    this.disposed = true;
  }
}
