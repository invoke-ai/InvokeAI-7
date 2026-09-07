import type { CanvasLayerPreviewMutation } from '@workbench/canvas-engine/capabilities';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';

import { createTestInsertionAnchorCapture } from '@workbench/canvas-engine/document/insertionAnchors.testStub';
import { createTestEditConcurrency } from '@workbench/canvas-engine/editConcurrency.testStub';
import { describe, expect, it, vi } from 'vitest';

import { LayerController } from './layerController';
import { StructuralLayerController } from './structuralLayerController';

describe('LayerController', () => {
  const mask = {
    applyImagePatch: vi.fn(),
    canEdit: () => true,
    deleteDerived: vi.fn(),
    discardPersisted: vi.fn(),
    dispatch: vi.fn(),
    endBurst: vi.fn(),
    getDocument: () => null,
    history: {} as never,
    isCacheReady: () => false,
    isGestureActive: () => false,
    layers: {} as never,
    markDirty: vi.fn(),
    notifyPainted: vi.fn(),
    restoreCache: vi.fn(),
  };
  const thumbnail = {
    backend: {} as never,
    getActiveProjectId: () => null,
    getCheckerboard: vi.fn(),
    getDocument: () => null,
    getEntry: () => undefined,
    getMaskPattern: () => null,
    isDisposed: () => false,
    isSupportedSource: () => true,
    projectId: 'p1',
    rasterize: vi.fn(),
    reportError: vi.fn(),
    setStatus: vi.fn(),
  };
  const structural = new StructuralLayerController({
    ctx: {
      canEdit: () => true,
      capturePermit: () => ({ epoch: 0 }),
      projectId: 'p',
      dispatch: vi.fn(() => true),
      dispatchPrepared: vi.fn(),
      getDocument: () => null,
      getEditRevision: () => 0,
      getReducerDocument: () => null,
      history: { push: vi.fn() } as never,
      isGestureActive: () => false,
    },
  });
  const rasterize = {
    backend: {} as never,
    canEdit: () => true,
    dispatch: vi.fn(),
    endBurst: vi.fn(),
    getDocument: () => null,
    history: {} as never,
    isGestureActive: () => false,
    layers: {} as never,
    markDirty: vi.fn(),
    notifyPainted: vi.fn(),
    rasterizeDeps: vi.fn(),
  };
  const merge = {
    backend: {} as never,
    canEdit: () => true,
    ctx: {} as never,
    exportBaked: vi.fn(),
    hasExportableContent: () => false,
    isCacheReady: () => true,
    layers: {} as never,
    markDirty: vi.fn(),
    needsPixelPersistence: () => false,
    notifyPainted: vi.fn(),
    publishSelectedLayerIds: vi.fn(),
    reserve: vi.fn(),
  };
  const booleanMerge = {
    backend: {} as never,
    concurrency: createTestEditConcurrency({ capturePermit: () => null }),
    createLayerId: () => 'result',
    captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
    dispatchPrepared: vi.fn(),
    endBurst: vi.fn(),
    exportBaked: vi.fn(),
    getDocument: () => null,
    getReducerDocument: () => null,
    history: {} as never,
    installPrepared: vi.fn(),
    isCacheReady: () => true,
    isGuardCurrent: () => true,
    preparePixels: vi.fn(),
  };
  const extractMaskedArea = {
    backend: {} as never,
    concurrency: createTestEditConcurrency({ capturePermit: () => null }),
    createLayerId: () => 'result',
    captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
    derived: {} as never,
    diagnostics: {} as never,
    dispatchPrepared: vi.fn(),
    endBurst: vi.fn(),
    exportBaked: vi.fn(),
    getAdjustedSurface: vi.fn(),
    getDocument: () => null,
    getMaskPattern: () => null,
    getReducerDocument: () => null,
    hasExportableContent: () => false,
    history: {} as never,
    installPrepared: vi.fn(),
    isCacheReady: () => true,
    isGuardCurrent: () => true,
    layers: {} as never,
    preparePixels: vi.fn(),
    rasterize: vi.fn(),
  };
  const crop = {
    backend: {} as never,
    captureCache: vi.fn(),
    concurrency: createTestEditConcurrency({ capturePermit: () => null }),
    discardPersisted: vi.fn(),
    dispatchPrepared: vi.fn(),
    endBurst: vi.fn(),
    exportBaked: vi.fn(),
    getDocument: () => null,
    getReducerDocument: () => null,
    history: {} as never,
    installPrepared: vi.fn(),
    isGuardCurrent: () => true,
    isSupportedSource: () => true,
    preparePixels: vi.fn(),
  };
  const copy = {
    concurrency: createTestEditConcurrency({ capturePermit: () => null }),
    createLayerId: () => 'copy',
    captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
    dispatchPrepared: vi.fn(),
    endBurst: vi.fn(),
    exportBaked: vi.fn(),
    getDocument: () => null,
    getReducerDocument: () => null,
    history: {} as never,
    installPrepared: vi.fn(),
    isGuardCurrent: () => true,
    preparePixels: vi.fn(),
  };
  const newRasterLayer = {
    backend: {} as never,
    concurrency: createTestEditConcurrency({ capturePermit: () => null }),
    createLayerId: () => 'new',
    captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
    dispatchPrepared: vi.fn(),
    endBurst: vi.fn(),
    getDocument: () => null,
    getReducerDocument: () => null,
    history: {} as never,
    installPrepared: vi.fn(),
    layers: {} as never,
    preparePixels: vi.fn(),
    selection: {} as never,
  };
  it('exposes only declared layer and preview ports', async () => {
    const forward: CanvasProjectMutation = { id: 'layer', type: 'setCanvasSelectedLayer' };
    const inverse: CanvasProjectMutation = { id: null, type: 'setCanvasSelectedLayer' };
    const deps = {
      commitGeneratedImageResult: vi.fn(() => Promise.resolve({ layerId: 'copy', status: 'committed' as const })),
      mask,
      booleanMerge,
      extractMaskedArea,
      newRasterLayer,
      crop,
      copy,
      merge,
      thumbnail,
      structural,
      rasterize,
    };
    const controller = new LayerController(deps);

    expect(
      controller.layers.applyStructuralPreview({ id: 'layer', patch: { opacity: 0.5 }, type: 'updateCanvasLayer' })
    ).toBe(true);
    controller.layers.commitStructural('edit', forward, inverse);
    expect(controller.previews.drawLayerThumbnail('layer', {} as HTMLCanvasElement, 96)).toBe(false);
    await expect(controller.previews.requestLayerThumbnail('layer')).resolves.toBe('stale');
  });

  it('disposes idempotently and rejects later mutations', () => {
    const deps = {
      commitGeneratedImageResult: vi.fn(() => Promise.resolve({ layerId: 'copy', status: 'committed' as const })),
      mask,
      booleanMerge,
      extractMaskedArea,
      newRasterLayer,
      crop,
      copy,
      merge,
      thumbnail,
      structural,
      rasterize,
    };
    const controller = new LayerController(deps);
    controller.dispose();
    controller.dispose();

    expect(controller.layers.applyStructuralPreview({} as CanvasLayerPreviewMutation)).toBe(false);
    controller.layers.commitStructural('late', {} as CanvasProjectMutation, {} as CanvasProjectMutation);
    expect(controller.previews.drawLayerThumbnail('layer', {} as HTMLCanvasElement, 96)).toBe(false);
  });
});
