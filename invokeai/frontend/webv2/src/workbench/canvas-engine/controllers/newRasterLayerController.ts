import type { CanvasDocumentContractV3, CanvasLayerContract } from '@workbench/canvas-engine/contracts';
import type { CanvasCommandRefusal } from '@workbench/canvas-engine/document/commandRefusal';
import type { CanvasNodeInsertionAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import type { LayerStackKind } from '@workbench/canvas-engine/document/layerStacks';
import type {
  CanvasEditConcurrency,
  CanvasTransactionOutcome,
  SubsetOf,
} from '@workbench/canvas-engine/editConcurrency';
import type { History } from '@workbench/canvas-engine/history/history';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { LayerCacheStore, PreparedLayerCacheReplacement } from '@workbench/canvas-engine/render/layerCache';
import type { RasterBackend, RasterSurface } from '@workbench/canvas-engine/render/raster';
import type { SelectionState } from '@workbench/canvas-engine/selection/selectionState';
import type { Rect, Vec2 } from '@workbench/canvas-engine/types';

import { getDocumentLayer, isNodeAbsent } from '@workbench/canvas-engine/document/documentIndex';
import { isEmpty, roundOut, transformBounds } from '@workbench/canvas-engine/math/rect';
import { liftSelectedPixels } from '@workbench/canvas-engine/selection/floatingSelection';
import { layerMatrix } from '@workbench/canvas-engine/tools/moveHitTest';

export type NewRasterLayerResult =
  | { status: 'created'; layerId: string }
  | { status: SubsetOf<CanvasTransactionOutcome, 'busy'> | SubsetOf<CanvasCommandRefusal, 'missing'> | 'empty' };

export interface NewRasterLayerControllerOptions {
  readonly concurrency: CanvasEditConcurrency;
  readonly backend: RasterBackend;
  readonly layers: LayerCacheStore;
  readonly selection: SelectionState;
  readonly history: History;
  readonly getDocument: () => CanvasDocumentContractV3 | null;
  readonly getReducerDocument: () => CanvasDocumentContractV3 | null;
  readonly endBurst: () => void;
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

/**
 * Creates raster layers out of loose pixels, undoably.
 *
 * Two callers want the same thing — Paste (pixels from the system clipboard)
 * and Layer via Copy (the selection's pixels lifted off the active layer) — so
 * they share one guarded insert rather than growing two near-identical
 * controllers. The transactional shape follows `ExtractMaskedAreaController`:
 * capture a permit, build the layer, `dispatchPrepared` with reducer AND mirror
 * postconditions, install the prepared cache, then push a failure-atomic history
 * entry whose redo re-runs the exact same apply.
 *
 * The new layer is inserted directly above the active one, which is where the
 * user is looking, and becomes the selection.
 */
export class NewRasterLayerController {
  private disposed = false;

  constructor(private readonly deps: NewRasterLayerControllerOptions) {}

  /**
   * Inserts `pixels` as a new paint layer covering `rect` (document space).
   * `pixels` is consumed as-is — the caller owns getting it into document space.
   */
  insert(rect: Rect, pixels: RasterSurface, name: string, label: string): NewRasterLayerResult {
    const permit = this.deps.concurrency.capturePermit();
    if (this.disposed || !permit || this.deps.concurrency.isGestureActive()) {
      return { status: 'busy' };
    }
    const document = this.deps.getDocument();
    if (!document) {
      return { status: 'missing' };
    }
    if (isEmpty(rect)) {
      return { status: 'empty' };
    }
    this.deps.endBurst();

    const layerId = this.deps.createLayerId();
    // Pixels are placed by the layer SOURCE offset, not the transform, so the
    // layer's own transform stays identity — the same shape a paint layer takes
    // after a stroke, which keeps every later edit (move, transform, float) on
    // the ordinary path.
    const layer: CanvasLayerContract = {
      blendMode: 'normal',
      id: layerId,
      isEnabled: true,
      isLocked: false,
      name,
      opacity: 1,
      source: { bitmap: null, offset: { x: rect.x, y: rect.y }, type: 'paint' },
      transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 },
      type: 'raster',
    };

    const anchor = this.deps.captureInsertionAnchor('raster', document.selectedLayerId);
    const previousSelectedLayerId = document.selectedLayerId;

    const apply = (): void => {
      const prepared = this.deps.preparePixels(layerId, rect, pixels);
      this.deps.dispatchPrepared(
        {
          add: [{ anchor, nodes: [layer] }],
          enabledUpdates: [],
          selectedLayerId: layerId,
          type: 'applyCanvasLayerStackMutation',
        },
        () =>
          this.deps.getReducerDocument()?.selectedLayerId === layerId &&
          getDocumentLayer(this.deps.getReducerDocument(), layer.id) === layer,
        () =>
          this.deps.getDocument()?.selectedLayerId === layerId &&
          getDocumentLayer(this.deps.getDocument(), layer.id) === layer
      );
      this.deps.installPrepared(prepared);
    };

    if (!this.deps.concurrency.isPermitCurrent(permit)) {
      return { status: 'busy' };
    }
    apply();
    this.deps.history.push({
      bytes: rect.width * rect.height * 4 + 256,
      label,
      redo: apply,
      replayFailureAtomic: true,
      undo: () =>
        this.deps.dispatchPrepared(
          {
            enabledUpdates: [],
            removeIds: [layerId],
            selectedLayerId: previousSelectedLayerId,
            type: 'applyCanvasLayerStackMutation',
          },
          () =>
            this.deps.getReducerDocument()?.selectedLayerId === previousSelectedLayerId &&
            isNodeAbsent(this.deps.getReducerDocument(), layerId),
          () =>
            this.deps.getDocument()?.selectedLayerId === previousSelectedLayerId &&
            isNodeAbsent(this.deps.getDocument(), layerId)
        ),
    });
    return { layerId, status: 'created' };
  }

  /**
   * Copies the selection's pixels off the active layer into a new layer above
   * it, leaving the source untouched (Photoshop's "Layer via Copy").
   */
  liftSelectionToLayer(name: string, label: string): NewRasterLayerResult {
    const document = this.deps.getDocument();
    const layer = getDocumentLayer(document, document?.selectedLayerId);
    const mask = this.deps.selection.mask();
    const entry = layer ? this.deps.layers.get(layer.id) : undefined;
    if (!document || !layer || !mask || !entry || isEmpty(entry.rect)) {
      return { status: 'empty' };
    }
    const matrix = layerMatrix(layer.transform);
    const lifted = liftSelectedPixels({
      backend: this.deps.backend,
      cache: { rect: entry.rect, surface: entry.surface },
      layerMatrix: matrix,
      mask,
    });
    if (!lifted) {
      return { status: 'empty' };
    }
    // The copy comes out in LAYER-LOCAL space; a new layer is placed in document
    // space, so bake the source layer's transform into the pixels on the way out.
    const documentRect = roundOut(transformBounds(matrix, lifted.pixels.rect));
    if (isEmpty(documentRect)) {
      return { status: 'empty' };
    }
    const surface = this.deps.backend.createSurface(documentRect.width, documentRect.height);
    const ctx = surface.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - documentRect.x, matrix.f - documentRect.y);
    ctx.drawImage(lifted.pixels.surface.canvas, lifted.pixels.rect.x, lifted.pixels.rect.y);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    return this.insert(documentRect, surface, name, label);
  }

  /** Inserts decoded clipboard pixels as a new layer, centred on `center` when given. */
  pasteImage(pixels: ImageData, name: string, label: string, center?: Vec2): NewRasterLayerResult {
    if (pixels.width <= 0 || pixels.height <= 0) {
      return { status: 'empty' };
    }
    const origin = center
      ? { x: Math.round(center.x - pixels.width / 2), y: Math.round(center.y - pixels.height / 2) }
      : { x: 0, y: 0 };
    const surface = this.deps.backend.createSurface(pixels.width, pixels.height);
    surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
    surface.ctx.putImageData(pixels, 0, 0);
    return this.insert({ height: pixels.height, width: pixels.width, x: origin.x, y: origin.y }, surface, name, label);
  }

  dispose(): void {
    this.disposed = true;
  }
}
