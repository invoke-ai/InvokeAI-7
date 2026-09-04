import type { LayerExportGuard } from '@workbench/canvas-engine/capabilities';
import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type { CanvasEditConcurrency } from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterBackend, RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { Rect } from '@workbench/canvas-engine/types';

import { lookupLayerBelow, mergeDownEligibility } from '@workbench/canvas-engine/document-model/documentModel';
import { getDocumentLayer } from '@workbench/canvas-engine/document/documentIndex';
import { isEmpty, roundOut, union } from '@workbench/canvas-engine/math/rect';

export type BooleanRasterOperation = 'intersect' | 'cutout' | 'cutaway' | 'exclude';
export type BooleanRasterResult = 'merged' | 'missing' | 'unsupported' | 'not-ready' | 'busy' | 'empty';

type ExportResult =
  | { status: 'ok'; surface: RasterSurface; rect: Rect; guard: LayerExportGuard; release(): void }
  | { status: 'missing' | 'disabled' | 'unsupported' | 'empty' | 'not-ready' | 'over-budget' };

export interface BooleanMergeControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly backend: RasterBackend;
  readonly history: History;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly endBurst: () => void;
  readonly isCacheReady: (layer: CanvasLayerContract, document: CanvasDocumentContractV3) => boolean;
  readonly exportBaked: (layerId: string) => Promise<ExportResult>;
  readonly isGuardCurrent: (guard: LayerExportGuard) => boolean;
  readonly createLayerId: () => string;
  readonly captureInsertionAnchor: (stack: LayerStackKind, aboveId: string | null) => CanvasNodeInsertionAnchor;
  readonly dispatchPrepared: (
    action: CanvasProjectMutation,
    expectedReducer: () => boolean,
    expectedMirror: () => boolean
  ) => void;
  readonly preparePixels: (layerId: string, rect: Rect, pixels: RasterSurface) => PreparedLayerCacheReplacement;
  readonly installPrepared: (prepared: PreparedLayerCacheReplacement) => void;
}

const modes: Record<BooleanRasterOperation, GlobalCompositeOperation> = {
  cutaway: 'source-out',
  cutout: 'destination-in',
  exclude: 'xor',
  intersect: 'source-in',
};

/** Owns guarded two-layer boolean compositing and atomic stack history. */
export class BooleanMergeController {
  private disposed = false;

  constructor(private readonly deps: BooleanMergeControllerOptions) {}

  async merge(upperLayerId: string, operation: BooleanRasterOperation): Promise<BooleanRasterResult> {
    const permit = this.deps.concurrency.capturePermit();
    if (this.disposed || !permit || this.deps.concurrency.isGestureActive()) {
      return 'busy';
    }
    this.deps.endBurst();
    const document = this.deps.getDocument();
    if (!document) {
      return 'missing';
    }
    const eligibility = mergeDownEligibility(document, upperLayerId);
    if (eligibility.status !== 'eligible') {
      return eligibility.status === 'missing' ||
        (eligibility.status === 'invalid-target' && eligibility.reason === 'no-layer-below')
        ? 'missing'
        : 'unsupported';
    }
    const upper = getDocumentLayer(document, eligibility.upperId)!;
    const below = getDocumentLayer(document, eligibility.lowerId)!;
    if (!this.deps.isCacheReady(upper, document) || !this.deps.isCacheReady(below, document)) {
      return 'not-ready';
    }
    const owned: Extract<ExportResult, { status: 'ok' }>[] = [];
    const acquire = async (layerId: string): Promise<ExportResult> => {
      const result = await this.deps.exportBaked(layerId);
      if (result.status === 'ok') {
        owned.push(result);
      }
      return result;
    };
    try {
      const settled = await Promise.allSettled([acquire(upper.id), acquire(below.id)]);
      const rejected = settled.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') {
        throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
      }
      const [upperPixels, belowPixels] = settled.map(
        (result) => (result as PromiseFulfilledResult<ExportResult>).value
      );
      if (!this.deps.concurrency.isPermitCurrent(permit)) {
        return 'busy';
      }
      if (upperPixels.status !== 'ok' || belowPixels.status !== 'ok') {
        if (upperPixels.status === 'not-ready' || belowPixels.status === 'not-ready') {
          return 'not-ready';
        }
        if (
          upperPixels.status === 'disabled' ||
          upperPixels.status === 'unsupported' ||
          belowPixels.status === 'disabled' ||
          belowPixels.status === 'unsupported'
        ) {
          return 'unsupported';
        }
        return 'empty';
      }
      if (
        !this.deps.concurrency.isPermitCurrent(permit) ||
        this.deps.concurrency.isGestureActive() ||
        upperPixels.guard.layer !== upper ||
        belowPixels.guard.layer !== below ||
        !this.deps.isGuardCurrent(upperPixels.guard) ||
        !this.deps.isGuardCurrent(belowPixels.guard)
      ) {
        return this.deps.concurrency.isPermitCurrent(permit) ? 'not-ready' : 'busy';
      }
      const liveDocument = this.deps.getDocument();
      if (
        !liveDocument ||
        getDocumentLayer(liveDocument, upperLayerId) !== upper ||
        lookupLayerBelow(liveDocument, upperLayerId) !== below
      ) {
        return 'not-ready';
      }
      const resultRect = roundOut(union(upperPixels.rect, belowPixels.rect));
      if (isEmpty(resultRect)) {
        return 'empty';
      }
      const pixels = this.deps.backend.createSurface(resultRect.width, resultRect.height);
      pixels.ctx.setTransform(1, 0, 0, 1, 0, 0);
      pixels.ctx.clearRect(0, 0, resultRect.width, resultRect.height);
      pixels.ctx.globalAlpha = below.opacity;
      pixels.ctx.globalCompositeOperation = 'source-over';
      pixels.ctx.drawImage(
        belowPixels.surface.canvas,
        belowPixels.rect.x - resultRect.x,
        belowPixels.rect.y - resultRect.y
      );
      pixels.ctx.globalAlpha = upper.opacity;
      pixels.ctx.globalCompositeOperation = modes[operation];
      pixels.ctx.drawImage(
        upperPixels.surface.canvas,
        upperPixels.rect.x - resultRect.x,
        upperPixels.rect.y - resultRect.y
      );
      const resultId = this.deps.createLayerId();
      const resultLayer: CanvasLayerContract = {
        blendMode: 'normal',
        id: resultId,
        isEnabled: true,
        isLocked: false,
        name: `${upper.name} ${operation}`,
        opacity: 1,
        source: { bitmap: null, offset: { x: resultRect.x, y: resultRect.y }, type: 'paint' },
        transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
        type: 'raster',
      };
      const original = [
        { id: upper.id, isEnabled: upper.isEnabled },
        { id: below.id, isEnabled: below.isEnabled },
      ];
      const disabled = original.map(({ id }) => ({ id, isEnabled: false }));
      const selectedLayerId = liveDocument.selectedLayerId;
      const anchor = this.deps.captureInsertionAnchor('raster', upper.id);
      const hasState = (doc: CanvasDocumentContractV3 | null, updates: typeof original): boolean =>
        updates.every((update) => getDocumentLayer(doc, update.id)?.isEnabled === update.isEnabled);
      const apply = (): void => {
        const prepared = this.deps.preparePixels(resultId, resultRect, pixels);
        this.deps.dispatchPrepared(
          {
            add: [{ anchor, nodes: [resultLayer] }],
            enabledUpdates: disabled,
            selectedLayerId: resultId,
            type: 'applyCanvasLayerStackMutation',
          },
          () =>
            this.deps.getReducerDocument()?.selectedLayerId === resultId &&
            hasState(this.deps.getReducerDocument(), disabled),
          () => this.deps.getDocument()?.selectedLayerId === resultId && hasState(this.deps.getDocument(), disabled)
        );
        this.deps.installPrepared(prepared);
      };
      if (!this.deps.concurrency.isPermitCurrent(permit)) {
        return 'busy';
      }
      apply();
      this.deps.history.push({
        bytes: resultRect.width * resultRect.height * 4 + 256,
        label: `Boolean ${operation}`,
        redo: apply,
        replayFailureAtomic: true,
        undo: () =>
          this.deps.dispatchPrepared(
            { enabledUpdates: original, removeIds: [resultId], selectedLayerId, type: 'applyCanvasLayerStackMutation' },
            () =>
              this.deps.getReducerDocument()?.selectedLayerId === selectedLayerId &&
              hasState(this.deps.getReducerDocument(), original),
            () =>
              this.deps.getDocument()?.selectedLayerId === selectedLayerId &&
              hasState(this.deps.getDocument(), original)
          ),
      });
      return 'merged';
    } finally {
      for (const result of owned) {
        result.release();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
