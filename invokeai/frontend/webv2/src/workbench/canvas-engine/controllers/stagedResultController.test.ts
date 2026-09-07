import type { CanvasStagingCandidateContract, CanvasStateContractV3 } from '@workbench/canvas-engine/contracts';
import type { CanvasProjectMutation } from '@workbench/canvasProjectMutations';

import { stacksFrom } from '@workbench/canvas-engine/document-model/documentFixtures.testStub';
import { getDocumentLeaves } from '@workbench/canvas-engine/document/documentIndex';
import { removeNodes } from '@workbench/canvas-engine/document/documentTree';
import { insertNodesAtAnchor } from '@workbench/canvas-engine/document/insertionAnchors';
import { createTestInsertionAnchorCapture } from '@workbench/canvas-engine/document/insertionAnchors.testStub';
import { createTestEditConcurrency } from '@workbench/canvas-engine/editConcurrency.testStub';
import { createHistory } from '@workbench/canvas-engine/history/history';
import { describe, expect, it, vi } from 'vitest';

import { StagedResultController } from './stagedResultController';

const candidate: CanvasStagingCandidateContract = {
  height: 40,
  imageName: 'result.png',
  imageUrl: '/result.png',
  placement: { height: 80, opacity: 0.5, width: 60, x: 12, y: 18 },
  queuedAt: '2026-07-16T00:00:00.000Z',
  sourceQueueItemId: 'queue-1',
  thumbnailUrl: '/thumb.png',
  width: 30,
};
const selection = { candidate, selectedImageIndex: 0 } as const;

const makeCanvas = (): CanvasStateContractV3 => ({
  document: {
    background: 'transparent',
    bbox: { height: 100, width: 100, x: 0, y: 0 },
    height: 100,
    stacks: stacksFrom([]),
    selectedLayerId: null,
    version: 3,
    width: 100,
  },
  documentRevision: 0,
  snapshots: [],
  stagingArea: {
    areThumbnailsVisible: false,
    autoSwitchMode: 'off',
    isVisible: true,
    pendingImageIds: [candidate.imageName],
    pendingImages: [candidate],
    selectedImageIndex: 0,
  },
  version: 3,
});

describe('StagedResultController', () => {
  it('commits the guarded candidate and records history only after reducer and mirror acceptance', () => {
    let reducerCanvas = makeCanvas();
    let mirrorDocument = reducerCanvas.document;
    const history = createHistory();
    const dispatchPrepared = vi.fn(
      (mutation: CanvasProjectMutation, reducerAccepted: () => boolean, mirrorAccepted: () => boolean) => {
        if (mutation.type === 'applyCanvasLayerStackMutation') {
          reducerCanvas = {
            ...reducerCanvas,
            document: {
              ...reducerCanvas.document,
              stacks: mutation.removeIds
                ? removeNodes(reducerCanvas.document.stacks, new Set(mutation.removeIds))
                : (mutation.add ?? []).reduce(
                    (stacks, insertion) => insertNodesAtAnchor(stacks, insertion.anchor, insertion.nodes),
                    reducerCanvas.document.stacks
                  ),
              selectedLayerId:
                mutation.selectedLayerId === undefined
                  ? reducerCanvas.document.selectedLayerId
                  : mutation.selectedLayerId,
            },
          };
          expect(reducerAccepted()).toBe(true);
          expect(mirrorAccepted()).toBe(false);
          mirrorDocument = reducerCanvas.document;
          expect(mirrorAccepted()).toBe(true);
          return;
        }
        expect(mutation).toMatchObject({ selectedImageIndex: 0, type: 'commitStagedImage' });
        if (mutation.type !== 'commitStagedImage') {
          throw new Error('unexpected mutation');
        }
        const layer = mutation.layer;
        reducerCanvas = {
          ...reducerCanvas,
          document: { ...reducerCanvas.document, stacks: stacksFrom([layer]), selectedLayerId: layer.id },
          stagingArea: { ...reducerCanvas.stagingArea, isVisible: false, pendingImageIds: [], pendingImages: [] },
        };
        mirrorDocument = reducerCanvas.document;
        expect(reducerAccepted()).toBe(true);
        expect(mirrorAccepted()).toBe(true);
      }
    );
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared,
      endBurst: vi.fn(),
      getCanvasState: () => reducerCanvas,
      getDocument: () => mirrorDocument,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(selection)).toEqual({ status: 'committed', layerId: 'layer-1' });
    expect(getDocumentLeaves(reducerCanvas.document)[0]).toMatchObject({
      id: 'layer-1',
      opacity: 0.5,
      source: { image: { imageName: 'result.png' }, type: 'image' },
      transform: { scaleX: 2, scaleY: 2, x: 12, y: 18 },
      type: 'raster',
    });
    expect(history.canUndo()).toBe(true);

    history.undo();
    expect(getDocumentLeaves(reducerCanvas.document)).toEqual([]);
    expect(reducerCanvas.document.selectedLayerId).toBeNull();
    expect(reducerCanvas.stagingArea.pendingImages).toEqual([]);

    history.redo();
    expect(getDocumentLeaves(reducerCanvas.document)[0]).toBe(getDocumentLeaves(reducerCanvas.document)[0]);
    expect(getDocumentLeaves(reducerCanvas.document)[0]?.id).toBe('layer-1');
    expect(reducerCanvas.stagingArea.pendingImages).toEqual([]);
  });

  it('returns stale without history when the selected candidate changes before reducer acceptance', () => {
    const canvas = makeCanvas();
    const history = createHistory();
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared: () => {
        throw new Error('reducer rejected stale candidate');
      },
      endBurst: vi.fn(),
      getCanvasState: () => canvas,
      getDocument: () => canvas.document,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(selection)).toEqual({ status: 'stale' });
    expect(getDocumentLeaves(canvas.document)).toEqual([]);
    expect(canvas.stagingArea.pendingImages).toEqual([candidate]);
    expect(history.canUndo()).toBe(false);
  });

  it.each([
    { gestureActive: false, name: 'edit lease is unavailable', permit: null, permitCurrent: false },
    { gestureActive: true, name: 'a gesture is active', permit: { epoch: 1 }, permitCurrent: true },
    { gestureActive: false, name: 'the captured edit permit is stale', permit: { epoch: 1 }, permitCurrent: false },
  ])('returns busy without mutation when $name', ({ gestureActive, permit, permitCurrent }) => {
    const canvas = makeCanvas();
    const dispatchPrepared = vi.fn();
    const history = createHistory();
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({
        capturePermit: () => permit,
        isGestureActive: () => gestureActive,
        isPermitCurrent: () => permitCurrent,
      }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared,
      endBurst: vi.fn(),
      getCanvasState: () => canvas,
      getDocument: () => canvas.document,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(selection)).toEqual({ status: 'busy' });
    expect(dispatchPrepared).not.toHaveBeenCalled();
    expect(history.canUndo()).toBe(false);
  });

  it.each(['reducer', 'mirror'])('does not record history when %s acceptance rejects the commit', () => {
    const canvas = makeCanvas();
    const history = createHistory();
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared: () => {
        throw new Error('acceptance rejected');
      },
      endBurst: vi.fn(),
      getCanvasState: () => canvas,
      getDocument: () => canvas.document,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(selection)).toEqual({ status: 'stale' });
    expect(canvas.stagingArea.pendingImages).toEqual([candidate]);
    expect(history.canUndo()).toBe(false);
  });

  it('clears the redo stack after a new staged image commit', () => {
    let reducerCanvas = makeCanvas();
    let mirrorDocument = reducerCanvas.document;
    const history = createHistory();
    history.push({ bytes: 1, label: 'older edit', redo: vi.fn(), undo: vi.fn() });
    history.undo();
    expect(history.canRedo()).toBe(true);
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared: (mutation, reducerAccepted, mirrorAccepted) => {
        if (mutation.type !== 'commitStagedImage') {
          throw new Error('unexpected mutation');
        }
        reducerCanvas = {
          ...reducerCanvas,
          document: {
            ...reducerCanvas.document,
            stacks: stacksFrom([mutation.layer]),
            selectedLayerId: mutation.layer.id,
          },
          stagingArea: {
            ...reducerCanvas.stagingArea,
            isVisible: false,
            pendingImageIds: [],
            pendingImages: [],
            selectedImageIndex: 0,
          },
        };
        expect(reducerAccepted()).toBe(true);
        mirrorDocument = reducerCanvas.document;
        expect(mirrorAccepted()).toBe(true);
      },
      endBurst: vi.fn(),
      getCanvasState: () => reducerCanvas,
      getDocument: () => mirrorDocument,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(selection).status).toBe('committed');
    expect(history.canRedo()).toBe(false);
  });

  it.each([
    { canvas: null, name: 'project', options: selection },
    {
      canvas: makeCanvas(),
      name: 'candidate',
      options: { candidate: { ...candidate, imageName: 'missing.png' }, selectedImageIndex: 0 },
    },
  ])('returns missing without mutation when the $name is absent', ({ canvas, options }) => {
    const dispatchPrepared = vi.fn();
    const history = createHistory();
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared,
      endBurst: vi.fn(),
      getCanvasState: () => canvas,
      getDocument: () => canvas?.document ?? null,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    expect(controller.commit(options)).toEqual({ status: 'missing' });
    expect(dispatchPrepared).not.toHaveBeenCalled();
    expect(history.canUndo()).toBe(false);
  });

  it('rejects retained commit capabilities after disposal', () => {
    const canvas = makeCanvas();
    const dispatchPrepared = vi.fn();
    const history = createHistory();
    const controller = new StagedResultController({
      captureInsertionAnchor: createTestInsertionAnchorCapture('p'),
      concurrency: createTestEditConcurrency({ capturePermit: () => ({ epoch: 1 }) }),
      createEventId: () => 'event-1',
      createLayerId: () => 'layer-1',
      dispatchPrepared,
      endBurst: vi.fn(),
      getCanvasState: () => canvas,
      getDocument: () => canvas.document,
      history,
      now: () => '2026-07-16T01:00:00.000Z',
    });

    controller.dispose();

    expect(controller.commit(selection)).toEqual({ status: 'missing' });
    expect(dispatchPrepared).not.toHaveBeenCalled();
    expect(history.canUndo()).toBe(false);
  });
});
