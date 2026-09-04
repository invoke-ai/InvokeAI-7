import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';
import type { Rect } from '@workbench/canvas-engine/types';

import { compileDocumentLeaves } from '@workbench/canvas-engine/document-model/documentModel';
import { isLeafDrawableForScreen } from '@workbench/canvas-engine/document-model/screenComposition';
import { getSourceContentRect, renderableSourceOf } from '@workbench/canvas-engine/document/sources';
import { fromTRS } from '@workbench/canvas-engine/math/mat2d';
import { intersect, isEmpty, transformBounds, union } from '@workbench/canvas-engine/math/rect';

export interface FrameDemandInput {
  readonly document: CanvasDocumentContractV3;
  readonly isolationLayerIds?: ReadonlySet<string>;
  readonly liveCacheRects?: ReadonlyMap<string, Rect>;
  readonly transformOverrides?: ReadonlyMap<
    string,
    { x: number; y: number; scaleX?: number; scaleY?: number; rotation?: number }
  >;
  readonly viewport: Rect;
}

/** Calculates the enabled raster caches whose transformed pixels intersect the next frame. */
export const calculateActiveFrameLayerIds = ({
  document,
  isolationLayerIds,
  liveCacheRects,
  transformOverrides,
  viewport,
}: FrameDemandInput): Set<string> => {
  const active = new Set<string>();
  for (const leaf of compileDocumentLeaves(document)) {
    const { layer } = leaf;
    const isIsolated = isolationLayerIds?.has(layer.id) ?? false;
    if (
      !isLeafDrawableForScreen(leaf, isIsolated) ||
      !renderableSourceOf(layer) ||
      (isolationLayerIds && !isIsolated)
    ) {
      continue;
    }
    const sourceRect = getSourceContentRect(layer, document);
    const liveRect = liveCacheRects?.get(layer.id);
    const localRect =
      liveRect && !isEmpty(liveRect) ? (isEmpty(sourceRect) ? liveRect : union(sourceRect, liveRect)) : sourceRect;
    const override = transformOverrides?.get(layer.id);
    const matrix = override
      ? fromTRS(
          { x: override.x, y: override.y },
          override.rotation ?? layer.transform.rotation,
          override.scaleX ?? layer.transform.scaleX,
          override.scaleY ?? layer.transform.scaleY
        )
      : leaf.worldTransform;
    if (intersect(transformBounds(matrix, localRect), viewport)) {
      active.add(layer.id);
    }
  }
  return active;
};
