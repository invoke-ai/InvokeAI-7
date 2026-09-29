/**
 * Samples composited layer pixels into a translated 1x1 scratch using normal ordering and display effects.
 * Excludes background/checkerboard and staged previews so uncovered points return null.
 */

import type { CanvasDocumentContractV3 } from '@workbench/canvas-engine/contracts';
import type { Mat2d, Vec2 } from '@workbench/canvas-engine/types';

import type { LayerCacheStore } from './layerCache';
import type { RasterBackend } from './raster';

import { compositeDocument, type CompositeOptions } from './compositor';

/** An RGBA sample, channels in `[0, 255]`. */
export interface RgbaSample {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Floors document coordinates to a pixel; transformed content remains pickable outside document dimensions.
 * Returns null for zero-alpha coverage.
 */
export const sampleDocumentColor = (
  doc: CanvasDocumentContractV3,
  layers: LayerCacheStore,
  backend: RasterBackend,
  docPoint: Vec2,
  providers: Pick<CompositeOptions, 'adjustedSurface' | 'derivedSurfaces' | 'groupSurface'> = {}
): RgbaSample | null => {
  const px = Math.floor(docPoint.x);
  const py = Math.floor(docPoint.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return null;
  }

  const scratch = backend.createSurface(1, 1);
  const view: Mat2d = { a: 1, b: 0, c: 0, d: 1, e: -px, f: -py };
  // Use canonical compositing for placement and display effects, omitting checkerboard/staged previews to retain
  // transparent empty space.
  compositeDocument(scratch, doc, layers, view, { backend, ...providers });

  const { data } = scratch.ctx.getImageData(0, 0, 1, 1);
  const alpha = data[3] ?? 0;
  if (alpha === 0) {
    return null;
  }
  return { a: alpha, b: data[2] ?? 0, g: data[1] ?? 0, r: data[0] ?? 0 };
};
