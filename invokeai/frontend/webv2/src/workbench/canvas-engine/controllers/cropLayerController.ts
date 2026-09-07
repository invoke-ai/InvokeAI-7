import type { LayerExportGuard } from '@workbench/canvas-engine/capabilities';
import type {
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasLayerSourceContract,
} from '@workbench/canvas-engine/contracts';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterBackend, RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { getDocumentLayer } from '@workbench/canvas-engine/document/documentIndex';
import { renderableSourceOf } from '@workbench/canvas-engine/document/sources';
import { intersect, isEmpty, roundOut } from '@workbench/canvas-engine/math/rect';

export type CropLayerResult =
  | { status: 'cropped' }
  | { status: 'missing' | 'locked' | 'unsupported' | 'empty' | 'not-ready' | 'over-budget' | 'busy' }
  | { status: 'failed'; message: string };

type ExportResult =
  | { status: 'ok'; surface: RasterSurface; rect: Rect; guard: LayerExportGuard; release(): void }
  | { status: 'missing' | 'disabled' | 'unsupported' | 'empty' | 'not-ready' | 'over-budget' };

interface PixelSnapshot {
  pixels: RasterSurface;
  rect: Rect;
}

export interface CropLayerControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly backend: RasterBackend;
  readonly history: History;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly endBurst: () => void;
  readonly isSupportedSource: (source: CanvasLayerSourceContract) => boolean;
  readonly exportBaked: (layerId: string) => Promise<ExportResult>;
  readonly isGuardCurrent: (guard: LayerExportGuard) => boolean;
  readonly captureCache: (
    layer: CanvasLayerContract,
    document: CanvasDocumentContractV3
  ) => PixelSnapshot | null | 'not-ready';
  readonly preparePixels: (layerId: string, rect: Rect, pixels: RasterSurface) => PreparedLayerCacheReplacement;
  readonly installPrepared: (prepared: PreparedLayerCacheReplacement) => void;
  readonly discardPersisted: (layerId: string) => void;
  readonly dispatchPrepared: (
    action: CanvasProjectMutation,
    expectedReducer: () => boolean,
    expectedMirror: () => boolean
  ) => void;
}

/** Owns guarded crop-to-bbox conversion and replayable pixel snapshots. */
export class CropLayerController {
  private disposed = false;
  constructor(private readonly deps: CropLayerControllerOptions) {}

  async crop(layerId: string): Promise<CropLayerResult> {
    const permit = this.deps.concurrency.capturePermit();
    if (this.disposed || !permit || this.deps.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }
    this.deps.endBurst();
    const document = this.deps.getDocument();
    const layer = getDocumentLayer(document, layerId);
    if (!document || !layer) {
      return { status: 'missing' };
    }
    if (layer.isLocked) {
      return { status: 'locked' };
    }
    const source = renderableSourceOf(layer);
    if (!source || !this.deps.isSupportedSource(source)) {
      return { status: 'unsupported' };
    }
    try {
      const exported = await this.deps.exportBaked(layerId);
      if (exported.status !== 'ok') {
        return { status: exported.status === 'disabled' ? 'not-ready' : exported.status };
      }
      try {
        if (!this.deps.concurrency.isPermitCurrent(permit)) {
          return { status: 'busy' };
        }
        const liveDocument = this.deps.getDocument();
        const liveLayer = getDocumentLayer(liveDocument, layerId);
        if (!liveDocument || !liveLayer) {
          return { status: 'missing' };
        }
        if (!this.deps.concurrency.isPermitCurrent(permit) || this.deps.concurrency.isGestureActive()) {
          return { status: 'busy' };
        }
        if (liveLayer.isLocked) {
          return { status: 'locked' };
        }
        if (!this.deps.isGuardCurrent(exported.guard)) {
          return { status: 'not-ready' };
        }
        const liveSource = renderableSourceOf(liveLayer);
        if (!liveSource || !this.deps.isSupportedSource(liveSource)) {
          return { status: 'unsupported' };
        }
        const overlap = intersect(exported.rect, roundOut(liveDocument.bbox));
        if (!overlap || isEmpty(overlap)) {
          return { status: 'empty' };
        }
        const cropRect = roundOut(overlap);
        const beforePixels = this.deps.captureCache(liveLayer, liveDocument);
        if (!beforePixels || beforePixels === 'not-ready') {
          return { status: 'not-ready' };
        }
        const before = structuredClone(liveLayer);
        const cropped = this.deps.backend.createSurface(cropRect.width, cropRect.height);
        cropped.ctx.setTransform(1, 0, 0, 1, 0, 0);
        cropped.ctx.clearRect(0, 0, cropRect.width, cropRect.height);
        cropped.ctx.drawImage(exported.surface.canvas, exported.rect.x - cropRect.x, exported.rect.y - cropRect.y);
        const identity = { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 };
        const paint = { bitmap: null, offset: { x: cropRect.x, y: cropRect.y }, type: 'paint' } as const;
        let after: CanvasLayerContract;
        if (before.type === 'raster') {
          const { adjustments: _adjustments, ...rest } = before;
          after = { ...rest, source: paint, transform: identity };
        } else if (before.type === 'control') {
          const { filter: _filter, ...rest } = before;
          after = { ...rest, source: paint, transform: identity };
        } else {
          after = { ...before, mask: { ...before.mask, bitmap: null, offset: paint.offset }, transform: identity };
        }
        const publish = (contract: CanvasLayerContract, prepared: PreparedLayerCacheReplacement): void => {
          this.deps.dispatchPrepared(
            { layer: contract, layerId, type: 'replaceCanvasLayer' },
            () => getDocumentLayer(this.deps.getReducerDocument(), layerId) === contract,
            () => getDocumentLayer(this.deps.getDocument(), layerId) === contract
          );
          try {
            this.deps.discardPersisted(layerId);
          } catch {
            /* ancillary */
          }
          this.deps.installPrepared(prepared);
        };
        const apply = (contract: CanvasLayerContract, snapshot: PixelSnapshot): void =>
          publish(contract, this.deps.preparePixels(layerId, snapshot.rect, snapshot.pixels));
        const afterPixels = { pixels: cropped, rect: cropRect };
        const prepared = this.deps.preparePixels(layerId, cropRect, cropped);
        if (!this.deps.concurrency.isPermitCurrent(permit)) {
          return { status: 'busy' };
        }
        publish(after, prepared);
        this.deps.history.push({
          bytes: beforePixels.rect.width * beforePixels.rect.height * 4 + cropRect.width * cropRect.height * 4 + 256,
          label: 'Crop layer to bbox',
          redo: () => apply(after, afterPixels),
          replayFailureAtomic: true,
          undo: () => apply(before, beforePixels),
        });
        return { status: 'cropped' };
      } finally {
        exported.release();
      }
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error), status: 'failed' };
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
