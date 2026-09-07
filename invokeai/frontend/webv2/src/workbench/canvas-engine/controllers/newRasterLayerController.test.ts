import type {
  CanvasStackForests,
  CanvasDocumentContractV3,
  CanvasLayerContract,
  CanvasRasterLayerContractV2,
} from '@workbench/canvas-engine/contracts';
import type { DocumentEditPermit } from '@workbench/canvas-engine/editConcurrency';
import type { SelectionState } from '@workbench/canvas-engine/selection/selectionState';
import type { PlacedSurface, Rect } from '@workbench/canvas-engine/types';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';

import { stacksFrom } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { getDocumentLeaves } from '@workbench/canvas-engine/document/documentIndex';
import { EMPTY_STACKS, removeNodes } from '@workbench/canvas-engine/document/documentTree';
import { insertNodesAtAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import { createTestInsertionAnchorCapture } from '@workbench/canvas-engine/document/insertionAnchors.testStub';
import { createTestEditConcurrency } from '@workbench/canvas-engine/editConcurrency.testStub';
import { createHistory } from '@workbench/canvas-engine/history/history';
import { createLayerCacheStore } from '@workbench/canvas-engine/render/layerCache';
import { createTestStubRasterBackend } from '@workbench/canvas-engine/render/raster.testStub';
import { describe, expect, it, vi } from 'vitest';

import { NewRasterLayerController } from './newRasterLayerController';

const paintLayer = (id: string, transform: Partial<CanvasLayerContract['transform']> = {}): CanvasLayerContract => ({
  blendMode: 'normal',
  id,
  isEnabled: true,
  isLocked: false,
  name: id,
  opacity: 1,
  source: { bitmap: null, offset: { x: 0, y: 0 }, type: 'paint' },
  transform: { rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0, ...transform },
  type: 'raster',
});

const makeDoc = (stacks: CanvasStackForests, selectedLayerId: string | null): CanvasDocumentContractV3 => ({
  background: 'transparent',
  bbox: { height: 100, width: 100, x: 0, y: 0 },
  height: 100,
  stacks,
  selectedLayerId,
  version: 3,
  width: 100,
});

/** The created layer, narrowed to the raster variant the controller always makes. */
const createdRaster = (document: CanvasDocumentContractV3 | null, id: string): CanvasRasterLayerContractV2 => {
  const layer = getDocumentLeaves(document).find((candidate) => candidate.id === id);
  if (!layer || layer.type !== 'raster') {
    throw new Error(`expected a raster layer ${id}`);
  }
  return layer;
};

const imageData = (width: number, height: number): ImageData =>
  ({ colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4), height, width }) as ImageData;

interface HarnessOptions {
  stacks?: CanvasStackForests;
  selectedLayerId?: string | null;
  maskRect?: Rect | null;
  cacheRect?: Rect;
  permit?: DocumentEditPermit | null;
  gestureActive?: boolean;
}

const createHarness = (options: HarnessOptions = {}) => {
  const backend = createTestStubRasterBackend();
  const layerCache = createLayerCacheStore(backend);
  const history = createHistory();
  const stacks = options.stacks ?? stacksFrom([paintLayer('a')]);
  const selectedLayerId =
    options.selectedLayerId === undefined ? (stacks.raster[0]?.id ?? null) : options.selectedLayerId;
  let document: CanvasDocumentContractV3 | null = makeDoc(stacks, selectedLayerId);

  const maskRect = options.maskRect === undefined ? { height: 30, width: 30, x: 20, y: 20 } : options.maskRect;
  const mask: PlacedSurface | null = maskRect
    ? { rect: maskRect, surface: backend.createSurface(maskRect.width, maskRect.height) }
    : null;
  const selection = { mask: () => mask } as SelectionState;

  if (selectedLayerId) {
    layerCache.getOrCreateRect(selectedLayerId, options.cacheRect ?? { height: 100, width: 100, x: 0, y: 0 });
  }

  const dispatched: CanvasProjectMutation[] = [];
  const installed = vi.fn();
  let nextId = 0;

  const controller = new NewRasterLayerController({
    backend,
    captureInsertionAnchor: createTestInsertionAnchorCapture('p', () => document?.stacks ?? EMPTY_STACKS),
    concurrency: createTestEditConcurrency({
      capturePermit: () => (options.permit === undefined ? { epoch: 0 } : options.permit),
      isGestureActive: () => options.gestureActive === true,
    }),
    createLayerId: () => `new-${(nextId += 1)}`,
    dispatchPrepared: (action) => {
      dispatched.push(action);
      // Mirror the reducer: apply the stack mutation to the local document so
      // the controller's postconditions and later reads see the new layer.
      if (action.type === 'applyCanvasLayerStackMutation' && document) {
        let next = document.stacks;
        for (const insertion of action.add ?? []) {
          next = insertNodesAtAnchor(next, insertion.anchor, insertion.nodes);
        }
        if (action.removeIds) {
          next = removeNodes(next, new Set(action.removeIds));
        }
        document = { ...document, selectedLayerId: action.selectedLayerId ?? null, stacks: next };
      }
    },
    endBurst: vi.fn(),
    getDocument: () => document,
    getReducerDocument: () => document,
    history,
    installPrepared: installed,
    layers: layerCache,
    preparePixels: (layerId, rect) => ({ layerId, rect }) as never,
    selection,
  });

  return {
    backend,
    controller,
    dispatched,
    document: () => document,
    history,
    installed,
    layerCache,
  };
};

describe('NewRasterLayerController: insert', () => {
  it('inserts a paint layer above the active one and selects it', () => {
    const h = createHarness({
      stacks: stacksFrom([paintLayer('top'), paintLayer('bottom')]),
      selectedLayerId: 'bottom',
    });
    const surface = h.backend.createSurface(10, 10);

    const result = h.controller.insert({ height: 10, width: 10, x: 5, y: 5 }, surface, 'New', 'Insert');

    expect(result).toEqual({ layerId: 'new-1', status: 'created' });
    // Index 0 is top-most, so "above bottom" is bottom's own index.
    expect(getDocumentLeaves(h.document()!).map((layer) => layer.id)).toEqual(['top', 'new-1', 'bottom']);
    expect(h.document()!.selectedLayerId).toBe('new-1');
    expect(h.installed).toHaveBeenCalledTimes(1);
  });

  it('places the pixels via the source offset, leaving the transform identity', () => {
    const h = createHarness();
    const surface = h.backend.createSurface(10, 10);

    h.controller.insert({ height: 10, width: 10, x: 40, y: 60 }, surface, 'New', 'Insert');

    const created = createdRaster(h.document(), 'new-1');
    expect(created.transform).toEqual({ rotation: 0, scaleX: 1, scaleY: 1, x: 0, y: 0 });
    expect(created.source).toMatchObject({ offset: { x: 40, y: 60 }, type: 'paint' });
  });

  it('undo removes the layer and restores the previous selection', () => {
    const h = createHarness({ stacks: stacksFrom([paintLayer('a')]), selectedLayerId: 'a' });
    const surface = h.backend.createSurface(10, 10);

    h.controller.insert({ height: 10, width: 10, x: 0, y: 0 }, surface, 'New', 'Insert');
    expect(h.history.canUndo()).toBe(true);

    h.history.undo();
    expect(getDocumentLeaves(h.document()!).map((layer) => layer.id)).toEqual(['a']);
    expect(h.document()!.selectedLayerId).toBe('a');
  });

  it('redo re-inserts the same layer', () => {
    const h = createHarness();
    const surface = h.backend.createSurface(10, 10);

    h.controller.insert({ height: 10, width: 10, x: 0, y: 0 }, surface, 'New', 'Insert');
    h.history.undo();
    h.history.redo();

    expect(getDocumentLeaves(h.document()!).some((layer) => layer.id === 'new-1')).toBe(true);
    expect(h.document()!.selectedLayerId).toBe('new-1');
  });

  it('refuses an empty rect', () => {
    const h = createHarness();
    const surface = h.backend.createSurface(0, 0);
    expect(h.controller.insert({ height: 0, width: 0, x: 0, y: 0 }, surface, 'New', 'Insert')).toEqual({
      status: 'empty',
    });
  });

  it('refuses while the document edit lease is unavailable', () => {
    const h = createHarness({ permit: null });
    const surface = h.backend.createSurface(10, 10);
    expect(h.controller.insert({ height: 10, width: 10, x: 0, y: 0 }, surface, 'New', 'Insert')).toEqual({
      status: 'busy',
    });
  });

  it('refuses mid-gesture', () => {
    const h = createHarness({ gestureActive: true });
    const surface = h.backend.createSurface(10, 10);
    expect(h.controller.insert({ height: 10, width: 10, x: 0, y: 0 }, surface, 'New', 'Insert')).toEqual({
      status: 'busy',
    });
  });

  it('refuses once disposed', () => {
    const h = createHarness();
    const surface = h.backend.createSurface(10, 10);
    h.controller.dispose();
    expect(h.controller.insert({ height: 10, width: 10, x: 0, y: 0 }, surface, 'New', 'Insert')).toEqual({
      status: 'busy',
    });
  });
});

describe('NewRasterLayerController: pasteImage', () => {
  it('centres the pasted pixels on the given point', () => {
    const h = createHarness();

    h.controller.pasteImage(imageData(20, 10), 'Pasted', 'Paste', { x: 50, y: 50 });

    const created = createdRaster(h.document(), 'new-1');
    expect(created.source).toMatchObject({ offset: { x: 40, y: 45 } });
  });

  it('places at the origin with no centre given', () => {
    const h = createHarness();

    h.controller.pasteImage(imageData(20, 10), 'Pasted', 'Paste');

    const created = createdRaster(h.document(), 'new-1');
    expect(created.source).toMatchObject({ offset: { x: 0, y: 0 } });
  });

  it('refuses zero-sized pixels', () => {
    const h = createHarness();
    expect(h.controller.pasteImage(imageData(0, 0), 'Pasted', 'Paste')).toEqual({ status: 'empty' });
  });
});

describe('NewRasterLayerController: liftSelectionToLayer', () => {
  it('creates a layer covering the selection ∩ content region', () => {
    const h = createHarness();

    const result = h.controller.liftSelectionToLayer('Selection', 'Layer via copy');

    expect(result).toEqual({ layerId: 'new-1', status: 'created' });
    const created = createdRaster(h.document(), 'new-1');
    expect(created.source).toMatchObject({ offset: { x: 20, y: 20 } });
  });

  it('leaves the source layer untouched — it is a copy, not a cut', () => {
    const h = createHarness();
    const before = h.layerCache.get('a')!.version;

    h.controller.liftSelectionToLayer('Selection', 'Layer via copy');

    expect(h.layerCache.get('a')!.version).toBe(before);
  });

  it('bakes the source layer transform into the new layer placement', () => {
    // The copy comes out layer-local; a new layer lives in document space, so a
    // translated source must shift where the pixels land.
    const h = createHarness({ stacks: stacksFrom([paintLayer('a', { x: 10, y: 5 })]) });

    h.controller.liftSelectionToLayer('Selection', 'Layer via copy');

    const created = createdRaster(h.document(), 'new-1');
    expect(created.source).toMatchObject({ offset: { x: 20, y: 20 } });
    expect(created.transform).toMatchObject({ x: 0, y: 0 });
  });

  it('refuses with no selection', () => {
    const h = createHarness({ maskRect: null });
    expect(h.controller.liftSelectionToLayer('Selection', 'Layer via copy')).toEqual({ status: 'empty' });
  });

  it('refuses with no selected layer', () => {
    const h = createHarness({ selectedLayerId: null });
    expect(h.controller.liftSelectionToLayer('Selection', 'Layer via copy')).toEqual({ status: 'empty' });
  });

  it('refuses when the selection misses the layer content', () => {
    const h = createHarness({ cacheRect: { height: 5, width: 5, x: 0, y: 0 } });
    expect(h.controller.liftSelectionToLayer('Selection', 'Layer via copy')).toEqual({ status: 'empty' });
  });
});
