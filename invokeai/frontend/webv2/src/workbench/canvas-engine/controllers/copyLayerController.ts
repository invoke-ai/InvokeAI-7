import type { LayerExportGuard } from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { getDocumentLayer, isNodeAbsent } from '@workbench/canvas-engine/document/documentIndex';

type ExportResult =
  | { status: 'ok'; surface: RasterSurface; rect: Rect; guard: LayerExportGuard; release(): void }
  | { status: 'missing' | 'disabled' | 'unsupported' | 'empty' | 'not-ready' | 'over-budget' };

export interface CopyLayerControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly history: History;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly endBurst: () => void;
  readonly exportBaked: (layerId: string) => Promise<ExportResult>;
  readonly isGuardCurrent: (guard: LayerExportGuard) => boolean;
  readonly createLayerId: () => string;
  readonly captureInsertionAnchor: (stack: LayerStackKind, aboveId: string | null) => CanvasNodeInsertionAnchor;
  readonly preparePixels: (layerId: string, rect: Rect, pixels: RasterSurface) => PreparedLayerCacheReplacement;
  readonly installPrepared: (prepared: PreparedLayerCacheReplacement) => void;
  readonly dispatchPrepared: (
    action: CanvasProjectMutation,
    expectedReducer: () => boolean,
    expectedMirror: () => boolean
  ) => void;
}

/** Owns guarded baked copies into new raster paint layers. */
export class CopyLayerController {
  private disposed = false;
  constructor(private readonly deps: CopyLayerControllerOptions) {}

  async copyToRaster(layerId: string): Promise<string | null> {
    const permit = this.deps.concurrency.capturePermit();
    if (this.disposed || !permit || this.deps.concurrency.isGestureActive()) {
      return null;
    }
    this.deps.endBurst();
    const document = this.deps.getDocument();
    const sourceLayer = getDocumentLayer(document, layerId);
    if (!document || !sourceLayer) {
      return null;
    }
    const baked = await this.deps.exportBaked(layerId);
    if (baked.status !== 'ok') {
      return null;
    }
    try {
      if (!this.deps.concurrency.isPermitCurrent(permit)) {
        return null;
      }
      if (
        this.deps.concurrency.isGestureActive() ||
        !this.deps.isGuardCurrent(baked.guard) ||
        baked.guard.layer !== sourceLayer
      ) {
        return null;
      }
      const liveDocument = this.deps.getDocument();
      if (!liveDocument || getDocumentLayer(liveDocument, sourceLayer.id) !== sourceLayer) {
        return null;
      }
      const newId = this.deps.createLayerId();
      const layer: CanvasLayerContract = {
        blendMode: 'normal',
        id: newId,
        isEnabled: true,
        isLocked: false,
        name: `${sourceLayer.name} copy`,
        opacity: 1,
        source: { bitmap: null, offset: { x: baked.rect.x, y: baked.rect.y }, type: 'paint' },
        transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
        type: 'raster',
      };
      const selectedLayerId = liveDocument.selectedLayerId;
      const anchor = this.deps.captureInsertionAnchor('raster', layerId);
      const apply = (): void => {
        const prepared = this.deps.preparePixels(newId, baked.rect, baked.surface);
        this.deps.dispatchPrepared(
          {
            add: [{ anchor, nodes: [layer] }],
            enabledUpdates: [],
            selectedLayerId: newId,
            type: 'applyCanvasLayerStackMutation',
          },
          () =>
            this.deps.getReducerDocument()?.selectedLayerId === newId &&
            getDocumentLayer(this.deps.getReducerDocument(), layer.id) === layer,
          () =>
            this.deps.getDocument()?.selectedLayerId === newId &&
            getDocumentLayer(this.deps.getDocument(), layer.id) === layer
        );
        this.deps.installPrepared(prepared);
      };
      if (!this.deps.concurrency.isPermitCurrent(permit)) {
        return null;
      }
      apply();
      this.deps.history.push({
        bytes: baked.rect.width * baked.rect.height * 4 + 256,
        label: 'Copy layer to raster',
        redo: apply,
        replayFailureAtomic: true,
        undo: () =>
          this.deps.dispatchPrepared(
            { enabledUpdates: [], removeIds: [newId], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
            () =>
              this.deps.getReducerDocument()?.selectedLayerId === selectedLayerId &&
              isNodeAbsent(this.deps.getReducerDocument(), newId),
            () =>
              this.deps.getDocument()?.selectedLayerId === selectedLayerId &&
              isNodeAbsent(this.deps.getDocument(), newId)
          ),
      });
      return newId;
    } finally {
      baked.release();
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
