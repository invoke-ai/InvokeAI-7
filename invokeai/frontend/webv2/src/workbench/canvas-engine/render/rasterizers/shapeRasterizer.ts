/**
 * Rasterizes a `shape` layer source (rect / ellipse / triangle / star). Shape
 * layers are
 * PARAMETRIC: their pixels are derived from the source params (`width`,
 * `height`, `fill`, `stroke`, `strokeWidth`, `kind`) rather than a persisted
 * bitmap, so they re-render for free whenever a param changes.
 *
 * Extent semantics: a shape's surface is sized to the source's own
 * `width`×`height` (its layer-local extent), NOT the document — the compositor
 * applies the layer transform (position/scale/rotation) when drawing, exactly
 * like an `image` layer. The stroke is drawn INSET by `strokeWidth / 2` so a
 * thick outline stays entirely within the extent rather than clipping at the
 * surface edge.
 *
 * `polygon` is intentionally NOT handled here (deferred until a points-editing
 * UX exists); the dispatch never routes a polygon source to this rasterizer in
 * this phase.
 *
 * Zero React, zero import-time side effects.
 */

import type { CanvasLayerSourceContract, ParametricShapeKind } from '@workbench/canvas-engine/contracts';
import type { RasterSurface } from '@workbench/canvas-engine/render/raster';

import type { RasterizeDeps, RasterizeResult } from './types';

type ShapeSource = Extract<CanvasLayerSourceContract, { type: 'shape' }>;
type Ctx = RasterSurface['ctx'];

/** Pentagram inner/outer radius ratio: sin(18°) / sin(54°). */
const STAR_INNER_RATIO = 0.382;
const STAR_SPIKES = 5;

/**
 * Builds the parametric path for `kind` into an `x/y + width×height` box inset
 * by `inset` on every side. Shared by the rasterizer and the drag-preview
 * outline so a committed shape lands exactly where its preview drew. Sharp
 * kinds (triangle, star) are stroked with round joins, so a half-stroke-width
 * inset genuinely contains the outline. The inset path is a box RESCALE, not a
 * uniform offset: on slanted edges a thick stroke drifts slightly outside the
 * fill silhouette — accepted (the ellipse's radius-shrink has the same class
 * of error), revisit only if design objects.
 */
export const buildParametricShapePath = (
  ctx: Ctx,
  kind: ParametricShapeKind | 'polygon',
  x: number,
  y: number,
  width: number,
  height: number,
  inset: number
): void => {
  const w = Math.max(0, width - inset * 2);
  const h = Math.max(0, height - inset * 2);
  const cx = x + width / 2;
  const cy = y + height / 2;
  ctx.beginPath();
  if (kind === 'ellipse') {
    ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (kind === 'triangle') {
    ctx.moveTo(cx, cy - h / 2);
    ctx.lineTo(cx + w / 2, cy + h / 2);
    ctx.lineTo(cx - w / 2, cy + h / 2);
    ctx.closePath();
    return;
  }
  if (kind === 'star') {
    const rx = w / 2;
    const ry = h / 2;
    for (let i = 0; i < STAR_SPIKES * 2; i += 1) {
      const radius = i % 2 === 0 ? 1 : STAR_INNER_RATIO;
      const angle = -Math.PI / 2 + (i * Math.PI) / STAR_SPIKES;
      const px = cx + Math.cos(angle) * rx * radius;
      const py = cy + Math.sin(angle) * ry * radius;
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
    return;
  }
  // `rect` (and, defensively, `polygon` which the dispatch never sends here).
  ctx.rect(x + inset, y + inset, w, h);
};

const buildShapePath = (ctx: Ctx, kind: ShapeSource['kind'], width: number, height: number, inset: number): void =>
  buildParametricShapePath(ctx, kind, 0, 0, width, height, inset);

/**
 * Draws a shape source onto a surface sized to the source extent. Reuses
 * `target` if provided (resizing it to the extent), matching the paint/image
 * rasterizer contract. Synchronous work wrapped in a resolved promise so it
 * shares the `rasterizeSource` dispatch signature.
 */
export const rasterizeShapeSource = (
  source: ShapeSource,
  deps: RasterizeDeps,
  target?: RasterSurface
): Promise<RasterizeResult> => {
  const width = Math.max(1, Math.round(source.width));
  const height = Math.max(1, Math.round(source.height));

  const surface = target ?? deps.backend.createSurface(width, height);
  if (surface.width !== width || surface.height !== height) {
    surface.resize(width, height);
  }
  const { ctx } = surface;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (source.fill) {
    ctx.fillStyle = source.fill;
    buildShapePath(ctx, source.kind, width, height, 0);
    ctx.fill();
  }

  if (source.stroke && source.strokeWidth > 0) {
    ctx.strokeStyle = source.stroke;
    ctx.lineWidth = source.strokeWidth;
    // Round joins keep sharp vertices within the half-stroke inset (a miter
    // would spike past it); a rect keeps its miter — the 90° tip lands exactly
    // on the extent corner, and rounding it would re-render every stored rect.
    ctx.lineJoin = source.kind === 'triangle' || source.kind === 'star' ? 'round' : 'miter';
    // Inset by half the stroke width so the (centered) stroke stays inside the extent.
    buildShapePath(ctx, source.kind, width, height, source.strokeWidth / 2);
    ctx.stroke();
  }

  return Promise.resolve({ rect: { height, width, x: 0, y: 0 }, surface });
};
