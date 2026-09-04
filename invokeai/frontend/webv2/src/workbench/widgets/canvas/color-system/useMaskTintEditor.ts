import type { CanvasLayerContract, CanvasMaskFillContract } from '@workbench/canvas-engine/api';
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';

import { getDocumentLayer } from '@workbench/canvas-engine/api';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { applyStructuralPreview } from '@workbench/widgets/layers/layerOps';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { clearMaskTintTarget, useMaskTintTargetLayerId } from './maskTintTarget';

type MaskTintEngine = Pick<CanvasEngineHandle, 'document' | 'exports' | 'interaction' | 'layers'>;
type MaskLayer = Extract<CanvasLayerContract, { type: 'inpaint_mask' | 'regional_guidance' }>;

/** Key repeats and drag releases coalesce into one entry after this idle gap. */
const COMMIT_SETTLE_MS = 400;

export interface MaskTintEditor {
  layerId: string;
  /** The armed mask's current tint. */
  color: string;
  /** Live, un-recorded preview during a drag. */
  preview: (hex: string) => void;
  /** Applies the color and records the gesture's ONE history entry once it settles. */
  commit: (hex: string) => void;
}

/**
 * A gesture in flight: the layer and fill captured before the first preview
 * (the entry's undo target), the latest applied hex, and the settle timer.
 * Holding these in one ref keeps the eventual commit closure-safe — the
 * gesture can outlive re-renders, a disarm, and even the pane unmounting.
 */
interface TintGesture {
  layer: MaskLayer;
  before: CanvasMaskFillContract;
  latestHex: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const configFor = (layer: MaskLayer, fill: CanvasMaskFillContract) =>
  layer.type === 'inpaint_mask'
    ? ({ layerType: 'inpaint_mask', mask: { fill } } as const)
    : ({ layerType: 'regional_guidance', mask: { fill } } as const);

/**
 * The armed mask-tint target as an editor, or `null` when no target is armed.
 * Watches the document: if the armed layer disappears, stops being a mask, or
 * stops being the selected layer, the target clears itself and the Color pane
 * returns to the foreground/background pair. A pending gesture always settles
 * into exactly one history entry — on the idle timer, on disarm, or on
 * unmount — so a preview can never outlive its commit.
 */
export const useMaskTintEditor = (engine: MaskTintEngine | null): MaskTintEditor | null => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const armedLayerId = useMaskTintTargetLayerId();
  const layer = useActiveProjectSelector((project): MaskLayer | null => {
    if (!armedLayerId || project.canvas.document.selectedLayerId !== armedLayerId) {
      return null;
    }
    const node = getDocumentLayer(project.canvas.document, armedLayerId);
    return node && (node.type === 'inpaint_mask' || node.type === 'regional_guidance') ? node : null;
  });

  const gestureRef = useRef<TintGesture | null>(null);
  const settle = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) {
      return;
    }
    if (gesture.timer !== null) {
      clearTimeout(gesture.timer);
    }
    if (gesture.before.color === gesture.latestHex) {
      return;
    }
    commitPrepared(t('widgets.layers.maskFill.fill'), (model) =>
      model.prepare({
        before: configFor(gesture.layer, gesture.before),
        config: configFor(gesture.layer, { ...gesture.before, color: gesture.latestHex }),
        id: gesture.layer.id,
        type: 'patch-config',
      })
    );
  }, [commitPrepared, t]);
  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  }, [settle]);

  useEffect(() => {
    if (armedLayerId && !layer) {
      clearMaskTintTarget();
    }
  }, [armedLayerId, layer]);
  // Disarm and unmount both flush the pending gesture; the gesture carries its
  // own layer, so this works even after the selection has moved on.
  useEffect(() => {
    if (!armedLayerId) {
      settleRef.current();
    }
    return () => settleRef.current();
  }, [armedLayerId]);

  const preview = useCallback(
    (hex: string) => {
      if (!layer) {
        return;
      }
      if (
        !applyStructuralPreview(engine, {
          config: configFor(layer, { ...layer.mask.fill, color: hex }),
          id: layer.id,
          type: 'updateCanvasLayerConfig',
        })
      ) {
        return;
      }
      if (gestureRef.current === null) {
        gestureRef.current = { before: layer.mask.fill, latestHex: hex, layer, timer: null };
      } else {
        gestureRef.current.latestHex = hex;
      }
    },
    [engine, layer]
  );
  const commit = useCallback(
    (hex: string) => {
      preview(hex);
      const gesture = gestureRef.current;
      if (!gesture) {
        return;
      }
      if (gesture.timer !== null) {
        clearTimeout(gesture.timer);
      }
      gesture.timer = setTimeout(() => settleRef.current(), COMMIT_SETTLE_MS);
    },
    [preview]
  );

  return useMemo(
    () => (layer ? { color: layer.mask.fill.color, commit, layerId: layer.id, preview } : null),
    [commit, layer, preview]
  );
};
