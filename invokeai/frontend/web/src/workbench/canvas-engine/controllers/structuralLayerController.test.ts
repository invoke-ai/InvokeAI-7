import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { Project } from '@workbench/projectContracts';

import { createDocumentModel, type CanvasDocumentModel } from '@workbench/canvas-engine/document-model/documentModel';
import { getDocumentIndex, getDocumentLayer, getDocumentLeaves } from '@workbench/canvas-engine/document/documentIndex';
import { stackTopAnchor } from '@workbench/canvas-engine/document/insertionAnchors.testStub';
import { haveSameStructure } from '@workbench/canvas-engine/document/layerStacks';
import { createHistory } from '@workbench/canvas-engine/history/history';
import { applyCanvasProjectMutation } from '@workbench/canvasProjectMutations';
import { createEmptyPaintLayer } from '@workbench/widgets/layers/layerOps';
import { createInitialWorkbenchState } from '@workbench/workbenchState';
import { describe, expect, it, vi } from 'vitest';

import { createCanvasMutationContext } from './mutationContext';
import { StructuralLayerController } from './structuralLayerController';

interface HarnessOptions {
  locked?: boolean;
  gestureActive?: boolean;
  schedulePreview?: (flush: () => void) => () => void;
  /** Mirror refreshes only when asked, as when a store observer threw mid-notification. */
  mirrorLag?: boolean;
  /** Makes mirror refresh fail so an accepted mutation can never be mirrored. */
  mirrorBroken?: boolean;
}

const createHarness = (options: HarnessOptions & { now?: () => number } = {}) => {
  const base = createInitialWorkbenchState().projects[0]!;
  const layer = createEmptyPaintLayer('Layer', 'layer');
  let project: Project = applyCanvasProjectMutation(base, {
    anchor: stackTopAnchor(base.id),
    layer,
    type: 'addCanvasLayer',
  });
  let mirrorDocument = project.canvas.document;
  const listeners = new Set<() => void>();
  const dispatched: CanvasProjectMutation[] = [];
  const report = vi.fn();
  const refreshMirror = (): void => {
    if (options.mirrorBroken) {
      throw new Error('mirror broken');
    }
    mirrorDocument = project.canvas.document;
  };
  const dispatch = (action: CanvasProjectMutation): boolean => {
    dispatched.push(action);
    const next = applyCanvasProjectMutation(project, action);
    const changed = next.canvas !== project.canvas;
    project = next;
    if (!options.mirrorLag && !options.mirrorBroken) {
      mirrorDocument = project.canvas.document;
    }
    listeners.forEach((listener) => listener());
    return changed;
  };
  const ctx = createCanvasMutationContext({
    commitEdit: vi.fn(),
    createLayerId: () => 'new',
    projectId: base.id,
    dispatch,
    editOwner: Symbol('owner'),
    editingLocked: { get: () => options.locked ?? false, subscribe: () => () => undefined },
    endBurst: () => undefined,
    getDocument: () => mirrorDocument,
    getReducerDocument: () => project.canvas.document,
    history: createHistory(),
    installPrepared: () => undefined,
    isGestureActive: () => options.gestureActive ?? false,
    isGuardCurrent: () => true,
    preparePixels: () => ({}) as never,
    refreshMirror,
    subscribeReducer: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const controller = new StructuralLayerController({
    ctx,
    now: options.now ?? (() => 0),
    report,
    schedulePreview: options.schedulePreview,
  });
  return {
    controller,
    ctx,
    dispatched,
    projectId: base.id,
    document: () => project.canvas.document,
    history: ctx.history,
    layer,
    mirror: () => mirrorDocument,
    report,
  };
};

const rename = (id: string, name: string): CanvasProjectMutation => ({
  id,
  patch: { name },
  type: 'updateCanvasLayer',
});
const layerName = (document: CanvasDocumentContractV3, id = 'layer'): string | undefined =>
  getDocumentLeaves(document).find((layer) => layer.id === id)?.name;

describe('StructuralLayerController', () => {
  it('coalesces previews to one dispatch per flush, last value wins', () => {
    let flush: (() => void) | null = null;
    const harness = createHarness({
      schedulePreview: (callback) => {
        flush = callback;
        return () => undefined;
      },
    });
    expect(harness.controller.preview(rename('layer', 'A'))).toBe(true);
    expect(harness.controller.preview(rename('layer', 'B'))).toBe(true);
    expect(harness.dispatched).toHaveLength(0);
    flush!();
    expect(harness.dispatched).toHaveLength(1);
    expect(layerName(harness.document())).toBe('B');
  });

  it('discards a pending preview when a commit lands, and on dispose', () => {
    let cancelled = 0;
    const harness = createHarness({
      schedulePreview: () => () => {
        cancelled += 1;
      },
    });
    harness.controller.preview(rename('layer', 'Stale'));
    expect(harness.controller.commit('Rename', rename('layer', 'Final'), rename('layer', 'Layer'))).toMatchObject({
      status: 'committed',
    });
    expect(cancelled).toBe(1);
    expect(layerName(harness.document())).toBe('Final');
    harness.controller.preview(rename('layer', 'Orphan'));
    harness.controller.dispose();
    expect(cancelled).toBe(2);
    expect(layerName(harness.document())).toBe('Final');
  });

  it('dispatches previews synchronously without an animation frame', () => {
    const harness = createHarness();
    expect(harness.controller.preview(rename('layer', 'Live'))).toBe(true);
    expect(layerName(harness.document())).toBe('Live');
  });

  it('commits through the guarded dispatch and records one failure-atomic history entry', () => {
    const { controller, document, history, mirror } = createHarness();

    expect(controller.canCommit()).toBe(true);
    expect(controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'))).toEqual({
      status: 'committed',
    });
    expect(layerName(document())).toBe('Renamed');
    expect(mirror()).toBe(document());
    expect(history.canUndo()).toBe(true);

    history.undo();
    expect(layerName(document())).toBe('Layer');
    history.redo();
    expect(layerName(document())).toBe('Renamed');
  });

  it.each([
    { expected: 'busy', locked: true, reason: 'editing is locked' },
    { expected: 'gesture-active', gestureActive: true, reason: 'a gesture is active' },
  ])('refuses before dispatch when $reason', ({ expected, ...options }) => {
    const { controller, dispatched, history } = createHarness(options);

    expect(controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'))).toEqual({
      status: expected,
    });
    expect(dispatched).toEqual([]);
    expect(history.canUndo()).toBe(false);
  });

  it('refuses after disposal', () => {
    const { controller, dispatched } = createHarness();

    controller.dispose();

    expect(controller.canCommit()).toBe(false);
    expect(controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'))).toEqual({
      status: 'not-ready',
    });
    expect(dispatched).toEqual([]);
  });

  it('refuses an edit prepared against an older revision as stale', () => {
    const { controller, ctx, dispatched } = createHarness();
    const captured = ctx.getEditRevision();

    expect(controller.commit('First', rename('layer', 'A'), rename('layer', 'Layer'))).toEqual({ status: 'committed' });
    const actual = ctx.getEditRevision();

    expect(
      controller.commit('Second', rename('layer', 'B'), rename('layer', 'A'), { expectedRevision: captured })
    ).toEqual({ actualRevision: actual, expectedRevision: captured, status: 'stale' });
    expect(dispatched).toHaveLength(1);
    expect(
      controller.commit('Third', rename('layer', 'B'), rename('layer', 'A'), { expectedRevision: actual })
    ).toEqual({
      status: 'committed',
    });
  });

  it('reports a reducer rejection without recording history', () => {
    const { controller, document, history } = createHarness();
    const before = document();

    expect(
      controller.commit('Select', { id: 'missing', type: 'setCanvasSelectedLayer' }, rename('layer', 'Layer'))
    ).toEqual({ status: 'dispatch-rejected' });
    expect(document()).toBe(before);
    expect(history.canUndo()).toBe(false);
  });

  it('applies the inverse when an accepted edit fails its postcondition', () => {
    const { controller, document, history, mirror } = createHarness();

    expect(
      controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'), { verify: () => false })
    ).toEqual({ recovered: 'reverted', status: 'postcondition-failed' });
    expect(layerName(document())).toBe('Layer');
    expect(mirror()).toBe(document());
    expect(history.canUndo()).toBe(false);
  });

  it('reports when the inverse cannot be applied and leaves the edit unrecorded', () => {
    const { controller, document, history, report } = createHarness();

    expect(
      controller.commit('Rename', rename('layer', 'Renamed'), rename('missing', 'Layer'), { verify: () => false })
    ).toEqual({ recovered: 'unreverted', status: 'postcondition-failed' });
    expect(layerName(document())).toBe('Renamed');
    expect(history.canUndo()).toBe(false);
    expect(report).toHaveBeenCalledWith('Structural edit could not be reverted', 'Rename', expect.any(Error));
  });

  it('reconciles a lagging mirror before recording the entry', () => {
    const { controller, document, mirror } = createHarness({ mirrorLag: true });

    expect(controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'))).toEqual({
      status: 'committed',
    });
    expect(mirror()).toBe(document());
  });

  it('reverts an accepted edit that can never be mirrored and says the view may lag', () => {
    const { controller, document, history, report } = createHarness({ mirrorBroken: true });

    expect(controller.commit('Rename', rename('layer', 'Renamed'), rename('layer', 'Layer'))).toEqual({
      recovered: 'reverted-unmirrored',
      status: 'postcondition-failed',
    });
    expect(layerName(document())).toBe('Layer');
    expect(history.canUndo()).toBe(false);
    expect(report).toHaveBeenCalledWith('Structural edit could not be mirrored', 'Rename', expect.any(Error));
  });

  describe('commitPrepared', () => {
    const prepareRename = (model: CanvasDocumentModel, name: string) => {
      const result = model.prepare({ id: 'layer', patch: { name }, type: 'patch' });
      if (result.status !== 'prepared') {
        throw new Error(`expected a prepared edit, got ${result.status}`);
      }
      return result.edit;
    };

    it('applies a prepared edit, verifies its postconditions and records one entry', () => {
      const { controller, ctx, document, history, projectId } = createHarness();
      const model = createDocumentModel(document(), { editRevision: ctx.getEditRevision(), projectId });

      expect(controller.commitPrepared('Rename', prepareRename(model, 'Renamed'))).toEqual({ status: 'committed' });
      expect(layerName(document())).toBe('Renamed');
      expect(history.canUndo()).toBe(true);
      history.undo();
      expect(layerName(document())).toBe('Layer');
    });

    it('refuses an edit prepared against an older revision or another project', () => {
      const { controller, ctx, document, history, projectId } = createHarness();
      const stale = prepareRename(
        createDocumentModel(document(), { editRevision: ctx.getEditRevision(), projectId }),
        'A'
      );
      ctx.dispatch(rename('layer', 'Elsewhere'), 'system');

      expect(controller.commitPrepared('Rename', stale)).toMatchObject({ status: 'stale' });
      const foreign = prepareRename(
        createDocumentModel(document(), { editRevision: ctx.getEditRevision(), projectId: 'other' }),
        'B'
      );
      expect(controller.commitPrepared('Rename', foreign)).toEqual({ status: 'dispatch-rejected' });
      expect(layerName(document())).toBe('Elsewhere');
      expect(history.canUndo()).toBe(false);
    });

    it('skips history for an edit whose policy is none', () => {
      const { controller, ctx, document, history, projectId } = createHarness();
      const model = createDocumentModel(document(), { editRevision: ctx.getEditRevision(), projectId });
      const result = model.prepare({ id: null, type: 'select' });
      if (result.status !== 'prepared') {
        throw new Error('expected a prepared selection change');
      }

      expect(controller.commitPrepared('Select', result.edit)).toEqual({ status: 'committed' });
      expect(document().selectedLayerId).toBeNull();
      expect(history.canUndo()).toBe(false);
    });
  });

  it('refuses an insertion anchored at an older edit revision as stale', () => {
    const { controller, ctx, document, projectId } = createHarness();
    const anchor = ctx.captureInsertionAnchor('raster', document().selectedLayerId);
    ctx.dispatch(rename('layer', 'Renamed'), 'system');
    const added = createEmptyPaintLayer('Added', 'added');

    expect(
      controller.commit(
        'Add',
        { anchor, layer: added, type: 'addCanvasLayer' },
        { ids: ['added'], type: 'removeCanvasLayers' }
      )
    ).toEqual({
      actualRevision: anchor.capturedEditRevision + 1,
      expectedRevision: anchor.capturedEditRevision,
      status: 'stale',
    });
    expect(getDocumentLeaves(document()).some((layer) => layer.id === 'added')).toBe(false);
    expect(anchor.projectId).toBe(projectId);
  });

  it('moves a replay the reducer refuses as a reported no-op instead of wedging history', () => {
    const { controller, ctx, document, history, projectId, report } = createHarness();
    const added = createEmptyPaintLayer('Added', 'added');

    controller.commit(
      'Add',
      { anchor: stackTopAnchor(projectId), layer: added, type: 'addCanvasLayer' },
      { ids: ['added'], type: 'removeCanvasLayers' }
    );
    ctx.dispatch({ ids: ['added'], type: 'removeCanvasLayers' }, 'system');

    expect(() => history.undo()).not.toThrow();
    expect(report).toHaveBeenCalledWith('Structural history replay was refused', 'Add', expect.any(Error));
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    expect(layerName(document(), 'added')).toBeUndefined();
  });

  it('coalesces rapid nudges into one entry and reports an ineligible nudge as rejected', () => {
    let now = 0;
    const { controller, document, history } = createHarness({ now: () => now });

    expect(controller.nudge(1, 0)).toEqual({ status: 'committed' });
    now = 100;
    expect(controller.nudge(1, 0)).toEqual({ status: 'committed' });
    expect(getDocumentLayer(document(), 'layer')?.transform.x).toBe(2);

    history.undo();
    expect(getDocumentLayer(document(), 'layer')?.transform.x).toBe(0);
    expect(history.canUndo()).toBe(false);

    controller.commit(
      'Deselect',
      { id: null, type: 'setCanvasSelectedLayer' },
      { id: 'layer', type: 'setCanvasSelectedLayer' }
    );
    expect(controller.nudge(1, 0)).toEqual({ status: 'dispatch-rejected' });
  });
});

describe('hierarchy recovery', () => {
  it('reverts a reparent whose postconditions fail and leaves the tree, selection and history untouched', () => {
    const { controller, ctx, document, history, projectId } = createHarness();
    const inner = createEmptyPaintLayer('Inner', 'inner');
    const group = {
      children: [inner],
      id: 'g',
      isEnabled: true,
      isLocked: false,
      name: 'Group',
      type: 'group' as const,
    };
    ctx.dispatch(
      {
        add: [{ anchor: stackTopAnchor(projectId), nodes: [group] }],
        enabledUpdates: [],
        type: 'applyCanvasLayerStackMutation',
      },
      'system'
    );
    const before = document();
    const parentOf = (id: string) => getDocumentIndex(document()).byId.get(id)?.parentId;
    expect(parentOf('layer')).toBeNull();

    const model = createDocumentModel(before, { editRevision: ctx.getEditRevision(), projectId });
    const result = model.prepare({ beforeId: null, ids: ['layer'], parentId: 'g', type: 'reparent' });
    if (result.status !== 'prepared') {
      throw new Error(result.status);
    }
    // Fault injection: the edit lands but claims an order the reducer did not produce.
    const tampered = {
      ...result.edit,
      postconditions: [
        { kind: 'sibling-order' as const, orderedIds: ['layer', 'inner'], parentId: 'g', stack: 'raster' as const },
      ],
    };
    expect(controller.commitPrepared('Reparent', tampered)).toEqual({
      recovered: 'reverted',
      status: 'postcondition-failed',
    });
    expect(haveSameStructure(document().stacks, before.stacks)).toBe(true);
    expect(document().selectedLayerId).toBe(before.selectedLayerId);
    expect(history.canUndo()).toBe(false);

    // Prepared afresh against the reverted document, the same edit lands and undoes exactly.
    const fresh = createDocumentModel(document(), { editRevision: ctx.getEditRevision(), projectId }).prepare({
      beforeId: null,
      ids: ['layer'],
      parentId: 'g',
      type: 'reparent',
    });
    if (fresh.status !== 'prepared') {
      throw new Error(fresh.status);
    }
    expect(controller.commitPrepared('Reparent', fresh.edit)).toEqual({ status: 'committed' });
    expect(parentOf('layer')).toBe('g');
    history.undo();
    expect(haveSameStructure(document().stacks, before.stacks)).toBe(true);
  });
});
