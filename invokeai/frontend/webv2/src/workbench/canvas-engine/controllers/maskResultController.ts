import type {
  CommitMaskImageResult,
  CommitMaskImageResultOptions,
  LayerExportGuard,
} from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';

import { getDocumentLayer, getDocumentLeaves, isNodeAbsent } from '@workbench/canvas-engine/document/documentIndex';
import {
  createInpaintMaskFromImage,
  createRegionalGuidanceFromImage,
  DEFAULT_INPAINT_MASK_FILL,
  nextInpaintMaskName,
  nextRegionalGuidanceFillColor,
  nextRegionalGuidanceName,
} from '@workbench/canvas-engine/document/layerFactories';

export type {
  CommitMaskImageResult,
  CommitMaskImageResultOptions,
  MaskImageResultTarget,
} from '@workbench/canvas-engine/capabilities';

export interface MaskResultControllerOptions {
  readonly captureInsertionAnchor: (stack: LayerStackKind, aboveId: string | null) => CanvasNodeInsertionAnchor;
  readonly concurrency: CanvasEditConcurrency;
  readonly createLayerId: () => string;
  readonly dispatchPrepared: (
    action: CanvasProjectMutation,
    reducerAccepted: () => boolean,
    mirrorAccepted: () => boolean
  ) => void;
  readonly endBurst: () => void;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly history: History;
  readonly isGuardCurrent: (guard: LayerExportGuard) => boolean;
}

/** Converts a guarded object-selection result into a structural mask layer. */
export class MaskResultController {
  constructor(private readonly options: MaskResultControllerOptions) {}

  commit(options: CommitMaskImageResultOptions, owner?: symbol): Promise<CommitMaskImageResult> {
    const o = this.options;
    if (!o.concurrency.canEdit(owner)) {
      return Promise.resolve({ status: 'busy' });
    }
    if (options.signal?.aborted) {
      return Promise.resolve({ status: 'aborted' });
    }
    const document = o.getDocument();
    if (!document) {
      return Promise.resolve({ status: 'missing' });
    }
    const liveLayer = getDocumentLayer(document, options.guard.layerId);
    if (!liveLayer) {
      return Promise.resolve({ status: 'missing' });
    }
    if (liveLayer.isLocked) {
      return Promise.resolve({ status: 'locked' });
    }
    if (liveLayer.type !== 'raster' && liveLayer.type !== 'control') {
      return Promise.resolve({ status: 'unsupported' });
    }
    if (o.concurrency.isGestureActive()) {
      return Promise.resolve({ status: 'busy' });
    }
    if (!o.isGuardCurrent(options.guard)) {
      return Promise.resolve({ status: 'stale' });
    }
    if (options.signal?.aborted) {
      return Promise.resolve({ status: 'aborted' });
    }
    const names = getDocumentLeaves(document).map((layer) => layer.name);
    const layerId = o.createLayerId();
    const layer =
      options.target === 'inpaint_mask'
        ? createInpaintMaskFromImage({
            fill: DEFAULT_INPAINT_MASK_FILL,
            id: layerId,
            image: options.image,
            name: nextInpaintMaskName(names),
            rect: options.rect,
          })
        : createRegionalGuidanceFromImage({
            fill: {
              color: nextRegionalGuidanceFillColor(
                getDocumentLeaves(document).filter((candidate) => candidate.type === 'regional_guidance').length
              ),
              style: 'solid',
            },
            id: layerId,
            image: options.image,
            name: nextRegionalGuidanceName(names),
            rect: options.rect,
          });
    const selectedLayerId = document.selectedLayerId;
    const anchor = o.captureInsertionAnchor(layer.type, liveLayer.id);
    const apply = (): void =>
      o.dispatchPrepared(
        { anchor, layer, type: 'addCanvasLayer' },
        () => getDocumentLayer(o.getReducerDocument(), layer.id) === layer,
        () => getDocumentLayer(o.getDocument(), layer.id) === layer
      );
    o.endBurst();
    apply();
    o.history.push({
      bytes: 256,
      label: options.target === 'inpaint_mask' ? 'Create inpaint mask from object' : 'Create region from object',
      redo: apply,
      replayFailureAtomic: true,
      undo: () => {
        o.dispatchPrepared(
          { id: selectedLayerId, type: 'setCanvasSelectedLayer' },
          () => o.getReducerDocument()?.selectedLayerId === selectedLayerId,
          () => o.getDocument()?.selectedLayerId === selectedLayerId
        );
        o.dispatchPrepared(
          { ids: [layerId], type: 'removeCanvasLayers' },
          () => isNodeAbsent(o.getReducerDocument(), layerId),
          () => isNodeAbsent(o.getDocument(), layerId)
        );
      },
    });
    return Promise.resolve({ layerId, status: 'committed' });
  }

  dispose(): void {}
}
