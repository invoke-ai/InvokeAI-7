import type {
  CanvasDocumentContractV3,
  CanvasEngine,
  LayerStackMoveKind,
  StructuralCommitResult,
} from '@workbench/canvas-engine/api';
import type { CanvasProjectMutationDispatch } from '@workbench/useCanvasProjectMutationDispatch';

import {
  compileDocumentLeaves,
  getDocumentIndex,
  isGroupNode,
  isNodeHidden,
  isOverlayStack,
} from '@workbench/canvas-engine/api';
import { publishLayerPanelSelection } from '@workbench/layerPanelState';
import { commitPreparedEdit, type PreparedCommitOutcome } from '@workbench/widgets/canvas/useStructuralCommit';
import {
  canGroupSelection,
  canUngroupSelection,
  groupLayers,
  ungroupLayers,
} from '@workbench/widgets/layers/layerGroupCommands';
import { canMergeLayerDown } from '@workbench/widgets/layers/layerOps';

/** Command id → document-space nudge delta (shift variants are ×10). */
const NUDGE_DELTAS: Record<string, { dx: number; dy: number }> = {
  'canvas.nudgeDown': { dx: 0, dy: 1 },
  'canvas.nudgeDownLarge': { dx: 0, dy: 10 },
  'canvas.nudgeLeft': { dx: -1, dy: 0 },
  'canvas.nudgeLeftLarge': { dx: -10, dy: 0 },
  'canvas.nudgeRight': { dx: 1, dy: 0 },
  'canvas.nudgeRightLarge': { dx: 10, dy: 0 },
  'canvas.nudgeUp': { dx: 0, dy: -1 },
  'canvas.nudgeUpLarge': { dx: 0, dy: -10 },
};

/** Command id → z-reorder direction (index 0 = top-most; "forward" moves toward 0). */
const REORDER_KINDS: Record<string, LayerStackMoveKind> = {
  'canvas.layerBackward': 'backward',
  'canvas.layerForward': 'forward',
  'canvas.layerToBack': 'back',
  'canvas.layerToFront': 'front',
};

/**
 * Everything the canvas hotkey dispatcher reads or drives. The widget supplies
 * these from its render scope; keeping them as an explicit parameter is what
 * makes the ~35-command dispatch table testable without mounting React.
 */
export interface CanvasHotkeyContext {
  readonly document: CanvasDocumentContractV3;
  readonly engine: CanvasEngine | null;
  /** Any staging slot exists, so left/right cycle candidates instead of nudging. */
  readonly hasStagingSlots: boolean;
  /** A staged candidate is selected, so Delete discards it instead of touching layers. */
  readonly hasSelectedStagedCandidate: boolean;
  readonly isInteractionLocked: boolean;
  readonly selectedLayerIds: readonly string[];
  readonly dispatch: CanvasProjectMutationDispatch;
  readonly copySelection: (cut: boolean) => void;
  /** Swaps the project foreground/background pair — a preference, never a document edit. */
  readonly swapActiveColors: () => void;
  /** Resets the pair to the black-on-white default. */
  readonly resetActiveColors: () => void;
  readonly pasteFromClipboard: () => void;
  readonly notifyLayerDuplicateFailed: () => void;
  readonly reportStructuralCommit: (result: StructuralCommitResult) => void;
  readonly reportPreparedCommit: (outcome: PreparedCommitOutcome) => void;
  readonly t: (key: string) => string;
}

/**
 * Routes one canvas command id to its effect.
 *
 * Ordering is load-bearing and reads top-down as a precedence list: staging
 * cycling and staged-candidate discard win over layer commands, the interaction
 * lock then blocks everything except the view tool, and only after those do
 * nudge, reorder, and the per-command table apply.
 */
export const executeCanvasHotkeyCommand = (commandId: string, ctx: CanvasHotkeyContext): void => {
  const { dispatch, document, engine, t } = ctx;
  const { selectedLayerId } = document;
  const index = getDocumentIndex(document);
  const selected = selectedLayerId ? index.byId.get(selectedLayerId) : undefined;
  const selectedLayer = selected && !isGroupNode(selected.node) ? selected.node : undefined;
  const selectedFrozen = !!selected && (selected.ancestorsLocked || selected.node.isLocked);

  if ((commandId === 'canvas.prevEntity' || commandId === 'canvas.nudgeLeft') && ctx.hasStagingSlots) {
    dispatch({ direction: -1, type: 'cycleStagedImage' });
    return;
  }

  if ((commandId === 'canvas.nextEntity' || commandId === 'canvas.nudgeRight') && ctx.hasStagingSlots) {
    dispatch({ direction: 1, type: 'cycleStagedImage' });
    return;
  }

  if (commandId === 'canvas.deleteSelected' && ctx.hasSelectedStagedCandidate) {
    dispatch({ type: 'discardSelectedStagedImage' });
    return;
  }

  // The color pair is a preference, not a document edit, so X/D stay live even
  // while the surface is interaction-locked.
  if (commandId === 'canvas.toggleFillColor') {
    ctx.swapActiveColors();
    return;
  }

  if (commandId === 'canvas.setFillColorsToDefault') {
    ctx.resetActiveColors();
    return;
  }

  if (ctx.isInteractionLocked) {
    if (commandId === 'canvas.tool.view') {
      engine?.tools.setTool('view');
    }
    return;
  }

  // Arrow-key nudge: engine owns the bounds/lock logic (no-op with no/locked selection).
  const nudge = NUDGE_DELTAS[commandId];
  if (nudge) {
    const nudged = engine?.layers.nudgeSelectedLayer(nudge.dx, nudge.dy);
    // A nudge with nothing eligible selected is an expected no-op; only a broken commit is news.
    if (nudged?.status === 'postcondition-failed') {
      ctx.reportStructuralCommit(nudged);
    }
    return;
  }

  // Layer z-reorder: the same prepared move the layers panel commits.
  const reorderKind = REORDER_KINDS[commandId];
  if (reorderKind) {
    if (!engine || !selected) {
      return;
    }
    ctx.reportPreparedCommit(
      commitPreparedEdit(engine, t('widgets.canvas.commands.reorderLayer'), (model) =>
        model.prepare({ ids: ctx.selectedLayerIds, kind: reorderKind, type: 'move' })
      )
    );
    return;
  }

  if (commandId === 'canvas.deleteSelected') {
    // With a live pixel selection, Delete clears the selected PIXELS — the
    // Photoshop meaning. Only with no selection does it delete the layer.
    if (engine?.interaction.get('hasSelection')) {
      engine.selection.eraseSelection();
    } else if (engine && selected && !selectedFrozen) {
      ctx.reportPreparedCommit(
        commitPreparedEdit(engine, t('widgets.canvas.commands.deleteLayer'), (model) =>
          model.prepare({ ids: ctx.selectedLayerIds, type: 'remove' })
        )
      );
    }
  } else if (commandId === 'canvas.copySelection' || commandId === 'canvas.cutSelection') {
    ctx.copySelection(commandId === 'canvas.cutSelection');
  } else if (commandId === 'canvas.pasteImage') {
    ctx.pasteFromClipboard();
  } else if (commandId === 'canvas.toggleNonRasterLayers') {
    // Hide, never disable: this is the "get the overlays out of my way" shortcut, and it must
    // leave the generated image untouched. Hiding turns off the overlay roots; showing turns on
    // every node hidden in its own right, so nothing stays gated behind a hidden group.
    const overlays = index.nodes.filter((entry) => isOverlayStack(entry.stack));
    const leaves = compileDocumentLeaves(document).filter((leaf) => isOverlayStack(leaf.stack));
    if (engine && leaves.length > 0) {
      const nextHidden = leaves.every((leaf) => !leaf.documentHidden);
      const targets = nextHidden
        ? overlays.filter((entry) => entry.parentId === null)
        : overlays.filter((entry) => isNodeHidden(entry.node));
      ctx.reportPreparedCommit(
        commitPreparedEdit(engine, t('widgets.canvas.commands.toggleNonRasterLayers'), (model) =>
          model.prepare({
            type: 'set-hidden',
            updates: targets.map((entry) => ({ id: entry.node.id, isHidden: nextHidden })),
          })
        )
      );
    }
  } else if (commandId === 'canvas.resetSelected') {
    if (engine && selectedLayer) {
      engine.layers.clearMask(selectedLayer.id);
    }
  } else if (commandId === 'canvas.undo') {
    // Canvas undo/redo is engine-scoped: it drives the engine-owned pixel/
    // structural history, NOT project-level (reducer) undo. When the canvas
    // history is empty this is a no-op — it deliberately does not fall back to
    // `undoProjectChange` (project undo keeps its own commands/hotkeys, e.g.
    // the workflow editor's `workflows.undo`).
    engine?.history.undo();
  } else if (commandId === 'canvas.redo') {
    engine?.history.redo();
  } else if (commandId === 'canvas.tool.view') {
    engine?.tools.setTool('view');
  } else if (commandId === 'canvas.tool.move') {
    engine?.tools.setTool('move');
  } else if (commandId === 'canvas.transformSelected') {
    // Selecting the transform tool opens a session on the selected layer (if any
    // eligible one); Apply/Cancel (enter/esc) are handled engine-side.
    engine?.tools.setTool('transform');
  } else if (commandId === 'canvas.tool.bbox') {
    engine?.tools.setTool('bbox');
  } else if (commandId === 'canvas.tool.brush') {
    engine?.tools.setTool('brush');
  } else if (commandId === 'canvas.tool.eraser') {
    engine?.tools.setTool('eraser');
  } else if (commandId === 'canvas.tool.lasso') {
    if (engine) {
      // Pressing the shortcut while already on the tool cycles its shape
      // (Photoshop-style) rather than re-selecting the tool it is already on.
      if (engine.interaction.get('activeTool') === 'lasso') {
        const lasso = engine.interaction.get('lassoOptions');
        engine.interaction.set('lassoOptions', {
          ...lasso,
          shape: lasso.shape === 'freehand' ? 'polygon' : 'freehand',
        });
      } else {
        engine.tools.setTool('lasso');
      }
    }
  } else if (commandId === 'canvas.tool.marquee') {
    if (engine) {
      if (engine.interaction.get('activeTool') === 'marquee') {
        const marquee = engine.interaction.get('marqueeOptions');
        engine.interaction.set('marqueeOptions', {
          ...marquee,
          kind: marquee.kind === 'rect' ? 'ellipse' : 'rect',
        });
      } else {
        engine.tools.setTool('marquee');
      }
    }
  } else if (commandId === 'canvas.tool.shape') {
    if (engine) {
      if (engine.interaction.get('activeTool') === 'shape') {
        // Repeat presses cycle the kind, like the marquee hotkey.
        const shape = engine.interaction.get('shapeOptions');
        const order = ['rect', 'ellipse', 'triangle', 'star'] as const;
        const next = order[(order.indexOf(shape.kind) + 1) % order.length]!;
        engine.interaction.set('shapeOptions', { ...shape, kind: next });
      } else {
        engine.tools.setTool('shape');
      }
    }
  } else if (commandId === 'canvas.tool.text') {
    engine?.tools.setTool('text');
  } else if (commandId === 'canvas.tool.gradient') {
    engine?.tools.setTool('gradient');
  } else if (commandId === 'canvas.selectAll') {
    engine?.selection.selectAll();
  } else if (commandId === 'canvas.deselect') {
    engine?.selection.deselect();
  } else if (commandId === 'canvas.invertSelection') {
    engine?.selection.invertSelection();
  } else if (commandId === 'canvas.brushSizeDown') {
    engine?.tools.stepBrushSize(-1);
  } else if (commandId === 'canvas.brushSizeUp') {
    engine?.tools.stepBrushSize(1);
  } else if (commandId === 'canvas.duplicateLayer') {
    // With a live pixel selection, mod+J is "layer via copy" — it lifts just
    // the selected pixels. With none, it duplicates the whole layer.
    if (engine?.interaction.get('hasSelection')) {
      engine.selection.liftSelectionToLayer();
    } else if (engine && selected) {
      void engine.layers
        .duplicateLayers(ctx.selectedLayerIds)
        .then((result) => {
          if (result.status === 'duplicated') {
            publishLayerPanelSelection({
              primaryId: result.selectedLayerId,
              projectId: engine.projectId,
              selectedIds: result.duplicateIds,
            });
            return;
          }
          if (result.status === 'busy') {
            return;
          }
          ctx.notifyLayerDuplicateFailed();
        })
        .catch(() => {
          // The engine keeps rejected transactions atomic; route both rejection
          // and preflight refusal through the same user-facing command feedback.
          ctx.notifyLayerDuplicateFailed();
        });
    }
  } else if (commandId === 'canvas.groupLayers') {
    if (engine && selected && canGroupSelection(engine.document.model(), ctx.selectedLayerIds)) {
      ctx.reportPreparedCommit(
        groupLayers(engine, engine.projectId, ctx.selectedLayerIds, t('widgets.canvas.commands.groupLayers'))
      );
    }
  } else if (commandId === 'canvas.ungroupLayers') {
    if (engine && selected && canUngroupSelection(engine.document.model(), ctx.selectedLayerIds)) {
      ctx.reportPreparedCommit(ungroupLayers(engine, ctx.selectedLayerIds, t('widgets.canvas.commands.ungroupLayers')));
    }
  } else if (commandId === 'canvas.mergeDown') {
    // Gate on the SAME predicate the layers panel's context menu uses to
    // enable/disable its "Merge Down" item (`canMergeLayerDown`), so the hotkey
    // can never fire where the menu would refuse — e.g. a mask layer selected,
    // or a mask directly below the selection. `engine.layers.mergeLayerDown` also
    // guards this itself (defense in depth for callers other than this hotkey),
    // but checking here keeps the two surfaces visibly in lockstep.
    if (engine && selectedLayer && canMergeLayerDown(document, selectedLayer.id, true)) {
      engine.layers.mergeLayerDown(selectedLayer.id);
    }
  }
};
