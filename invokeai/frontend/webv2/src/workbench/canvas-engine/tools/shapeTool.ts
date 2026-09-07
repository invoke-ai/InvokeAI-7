/**
 * The shape tool. The box kinds (rect / ellipse / triangle / star) drag out a
 * rect; `polygon` places vertices click by click through the shared polyline
 * session; `freehand` traces a drag and closes it. A finished shape lands
 * either as pixels on the selected paint layer (one undoable stroke, clipped
 * to the selection and the bbox like a brush stroke) or, when the target is
 * `new` or the selection is not a paint layer, as its own parametric shape
 * layer. A locked, disabled or not-yet-rasterized paint layer refuses the
 * shape (a no-op, like the brush) rather than spawning a layer over it.
 *
 * Interaction contract:
 * - **Pointer-move** updates a transient overlay preview (the drag rect, or the
 *   polyline through `stores.lassoPreview`) — it never dispatches. Hold
 *   **shift** to constrain a drag to a square/circle.
 * - **Commit**: exactly one `commitStructural` (`addCanvasLayer`, undone by
 *   `removeCanvasLayers`) or one stroke event. A zero-area shape commits nothing.
 * - **Cancel** (Esc / pointercancel): drops the preview, no dispatch.
 *
 * Zero React, zero import-time side effects.
 */

import type { CanvasLayerSourceContract, CanvasRasterLayerContractV2 } from '@workbench/canvas-engine/contracts';
import type { SemanticLeaf } from '@workbench/canvas-engine/document-model/semanticLeaf';
import type { ShapeToolOptions } from '@workbench/canvas-engine/engineStores';
import type { CanvasProjectMutation } from '@workbench/canvas-engine/mutationContracts';
import type { PlacedSurface, Rect, Vec2 } from '@workbench/canvas-engine/types';

import { lookupDocumentLeaf } from '@workbench/canvas-engine/document-model/documentModel';
import { getDocumentLeaves } from '@workbench/canvas-engine/document/documentIndex';
import { isLeafPaintable } from '@workbench/canvas-engine/document/layerEligibility';
import { polygonBounds } from '@workbench/canvas-engine/freehand';
import { identity, invert, multiply, translate } from '@workbench/canvas-engine/math/mat2d';
import { intersect, roundOut, transformBounds } from '@workbench/canvas-engine/math/rect';
import { drawShapeSource } from '@workbench/canvas-engine/render/rasterizers/shapeRasterizer';

import type { Tool, ToolContext } from './tool';

import { layerMatrix } from './moveHitTest';
import {
  MIN_POLYLINE_POINTS,
  movePolyline,
  polylinePreview,
  pressPolyline,
  startPolyline,
  type PolylineSession,
} from './polylineSession';

type ShapeSource = Extract<CanvasLayerSourceContract, { type: 'shape' }>;

/** Bit for the primary (usually left) mouse button in `PointerEvent.buttons`. */
const PRIMARY_BUTTON = 1;

/** Screen-space distance (CSS px) the pointer must travel before a press becomes a drag. */
export const SHAPE_DRAG_THRESHOLD_PX = 3;

/** Minimum document-space gap between stored freehand points (input decimation). */
const FREEHAND_MIN_POINT_DISTANCE = 2;

type Session =
  | { kind: 'drag'; startDoc: Vec2; startScreen: Vec2; moved: boolean }
  | { kind: 'polyline'; session: PolylineSession }
  | { kind: 'freehand'; points: Vec2[] };

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The integer, normalized document rect for a drag from `start` to `end`, optionally square-constrained. */
export const rectFromDrag = (start: Vec2, end: Vec2, square: boolean): Rect => {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  const x = Math.round(Math.min(start.x, start.x + dx));
  const y = Math.round(Math.min(start.y, start.y + dy));
  return { height: Math.round(Math.abs(dy)), width: Math.round(Math.abs(dx)), x, y };
};

/** A shape to place: its source plus the document rect it covers. */
interface PlacedShape {
  source: ShapeSource;
  rect: Rect;
}

/**
 * A polygon source for document-space vertices: the extent is the vertex
 * bounds, and the stored points are relative to that box's origin.
 */
export const polygonShapeFrom = (
  vertices: readonly Vec2[],
  style: Pick<ShapeSource, 'fill' | 'stroke' | 'strokeWidth'>
): PlacedShape | null => {
  const distinct = vertices.filter((point, index) => index === 0 || distance(point, vertices[index - 1]!) >= 1);
  const bounds = polygonBounds(distinct);
  if (distinct.length < MIN_POLYLINE_POINTS || bounds.width < 1 || bounds.height < 1) {
    return null;
  }
  const rect = roundOut(bounds);
  return {
    rect,
    source: {
      ...style,
      height: rect.height,
      kind: 'polygon',
      points: distinct.map((point) => ({ x: point.x - rect.x, y: point.y - rect.y })),
      type: 'shape',
      width: rect.width,
    },
  };
};

/** Where a finished shape went: pixels, refused by the paint layer, or not a paint layer at all. */
type PixelPlacement = 'placed' | 'refused' | 'unsupported';

/** Whether a session was started for the current kind option; a kind change mid-session drops it. */
const sessionFitsKind = (session: Session, kind: ShapeToolOptions['kind']): boolean =>
  kind === 'polygon'
    ? session.kind === 'polyline'
    : kind === 'freehand'
      ? session.kind === 'freehand'
      : session.kind === 'drag';

/** Creates a fresh shape tool with its own gesture state. */
export const createShapeTool = (): Tool => {
  let session: Session | null = null;

  const clearPreview = (ctx: ToolContext): void => {
    ctx.stores.shapePreview.set(null);
    ctx.stores.lassoPreview.set(null);
    ctx.invalidate({ overlay: true });
  };

  const reset = (ctx: ToolContext): void => {
    session = null;
    clearPreview(ctx);
  };

  /** The fill/stroke the next shape gets, resolved from the active pair now. */
  const styleFromOptions = (ctx: ToolContext): Pick<ShapeSource, 'fill' | 'stroke' | 'strokeWidth'> => {
    const options = ctx.stores.shapeOptions.get();
    const pair = ctx.stores.colorPair.get();
    return {
      fill: options.fillEnabled ? pair.foreground : null,
      stroke: options.strokeEnabled ? pair.background : null,
      strokeWidth: options.strokeWidth,
    };
  };

  /**
   * Draws the shape as pixels onto the selected paint layer, as one stroke
   * event: the layer cache grows to the shape's layer-local bounds (clamped to
   * the selection and bbox clips, so growth never escapes them), the shape is
   * drawn through the layer's inverse transform, then clipped to the selection
   * mask and the bbox exactly as a brush stroke is.
   */
  const commitPixels = (ctx: ToolContext, leaf: SemanticLeaf, placed: PlacedShape): PixelPlacement => {
    const layer = leaf.layer;
    if (layer.type !== 'raster' || layer.source.type !== 'paint') {
      return 'unsupported';
    }
    if (!isLeafPaintable(leaf)) {
      return 'refused';
    }
    if (layer.source.bitmap) {
      const existing = ctx.layers.get(layer.id);
      if (!existing || existing.stale) {
        // The durable pixels are not in the cache yet: drawing now would lose them.
        ctx.requestLayerRasterization?.(layer.id);
        return 'refused';
      }
    }
    const toLocal = invert(layerMatrix(layer.transform));
    if (!toLocal) {
      return 'refused';
    }
    const clipMask: PlacedSurface | null = ctx.getSelectionMask?.() ?? null;
    const clipRect: Rect | null = ctx.getStrokeClipRect?.() ?? null;
    let docRect: Rect | null = placed.rect;
    if (clipMask) {
      docRect = intersect(docRect, clipMask.rect);
    }
    if (docRect && clipRect) {
      docRect = intersect(docRect, clipRect);
    }
    const dirtyRect = docRect ? roundOut(transformBounds(toLocal, docRect)) : null;
    if (!dirtyRect || dirtyRect.width < 1 || dirtyRect.height < 1) {
      return 'refused';
    }
    const entry = ctx.layers.growToRect(layer.id, dirtyRect);
    const surfaceCtx = entry.surface.ctx;
    const sx = dirtyRect.x - entry.rect.x;
    const sy = dirtyRect.y - entry.rect.y;
    const beforeImageData = surfaceCtx.getImageData(sx, sy, dirtyRect.width, dirtyRect.height);

    // Draw into a scratch the size of the dirty rect (scratch origin = dirtyRect
    // origin in layer space) so the clips and the transparency lock apply in
    // one composite. Document → layer-local → scratch: the layer's inverse,
    // then the scratch offset.
    const scratch = ctx.backend.createSurface(dirtyRect.width, dirtyRect.height);
    const draw = scratch.ctx;
    const { rect, source } = placed;
    const toScratch = multiply(translate(identity(), { x: -dirtyRect.x, y: -dirtyRect.y }), toLocal);
    draw.setTransform(toScratch.a, toScratch.b, toScratch.c, toScratch.d, toScratch.e, toScratch.f);
    drawShapeSource(draw, source, rect.x, rect.y, rect.width, rect.height);
    draw.globalCompositeOperation = 'destination-in';
    if (clipMask) {
      // The mask sits in document space, so it goes through the same mapping.
      draw.drawImage(clipMask.surface.canvas, clipMask.rect.x, clipMask.rect.y);
    }
    if (clipRect && (toLocal.b !== 0 || toLocal.c !== 0)) {
      // The dirty-rect clamp only bounds the AABB on a rotated/sheared layer;
      // keep exactly the pixels inside the document-space rect.
      draw.fillStyle = '#000';
      draw.beginPath();
      draw.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height);
      draw.fill();
    }
    surfaceCtx.save();
    surfaceCtx.setTransform(1, 0, 0, 1, 0, 0);
    surfaceCtx.globalCompositeOperation = layer.isTransparencyLocked ? 'source-atop' : 'source-over';
    surfaceCtx.drawImage(scratch.canvas, sx, sy);
    surfaceCtx.restore();
    const afterImageData = surfaceCtx.getImageData(sx, sy, dirtyRect.width, dirtyRect.height);
    ctx.emitStrokeCommitted({ afterImageData, beforeImageData, dirtyRect, layerId: layer.id, tool: 'shape' });
    return 'placed';
  };

  const commitLayer = (ctx: ToolContext, placed: PlacedShape): void => {
    const doc = ctx.getDocument();
    if (!doc) {
      return;
    }
    const layerId = ctx.createLayerId();
    const layer: CanvasRasterLayerContractV2 = {
      blendMode: 'normal',
      id: layerId,
      isEnabled: true,
      isLocked: false,
      name: `Shape ${getDocumentLeaves(doc).length + 1}`,
      opacity: 1,
      source: placed.source,
      transform: { rotation: 0, scaleX: 1, scaleY: 1, x: placed.rect.x, y: placed.rect.y },
      type: 'raster',
    };
    const forward: CanvasProjectMutation = {
      anchor: ctx.captureInsertionAnchor('raster', doc.selectedLayerId),
      layer,
      type: 'addCanvasLayer',
    };
    const inverse: CanvasProjectMutation = { ids: [layerId], type: 'removeCanvasLayers' };
    ctx.commitStructural('Add shape', forward, inverse);
  };

  /** Places a finished shape on the selected paint layer when asked, else on a new layer. */
  const commit = (ctx: ToolContext, placed: PlacedShape | null): void => {
    reset(ctx);
    const doc = ctx.getDocument();
    if (!placed || !doc) {
      return;
    }
    if (ctx.stores.shapeOptions.get().target === 'selected') {
      const leaf = doc.selectedLayerId ? lookupDocumentLeaf(doc, doc.selectedLayerId) : null;
      if (leaf && commitPixels(ctx, leaf, placed) !== 'unsupported') {
        return;
      }
    }
    commitLayer(ctx, placed);
  };

  const boxShape = (ctx: ToolContext, rect: Rect): PlacedShape | null => {
    const kind = ctx.stores.shapeOptions.get().kind;
    if (rect.width < 1 || rect.height < 1 || kind === 'polygon' || kind === 'freehand') {
      return null;
    }
    return { rect, source: { ...styleFromOptions(ctx), height: rect.height, kind, type: 'shape', width: rect.width } };
  };

  const closePolyline = (ctx: ToolContext, polyline: PolylineSession): void => {
    commit(ctx, polygonShapeFrom(polyline.points, styleFromOptions(ctx)));
  };

  return {
    cursor: () => (session?.kind === 'polyline' && session.session.closeArmed ? 'pointer' : 'crosshair'),
    id: 'shape',
    onDeactivate: (ctx, opts) => {
      // A modifier-hold switch (space → view to pan mid-polygon) keeps the session.
      if (!opts?.temporary) {
        reset(ctx);
      }
    },
    onKeyCommand: (ctx, command) => {
      if (!session) {
        return;
      }
      if (command === 'cancel') {
        reset(ctx);
      } else if (session.kind === 'polyline') {
        closePolyline(ctx, session.session);
      }
    },
    onPointerCancel: (ctx) => reset(ctx),
    onPointerDown: (ctx, input) => {
      if ((input.buttons & PRIMARY_BUTTON) === 0 || !ctx.getDocument()) {
        return;
      }
      const kind = ctx.stores.shapeOptions.get().kind;
      if (session && !sessionFitsKind(session, kind)) {
        reset(ctx);
      }
      if (kind === 'polygon') {
        if (session?.kind !== 'polyline') {
          session = { kind: 'polyline', session: startPolyline(input) };
        } else if (pressPolyline(ctx, session.session, input) === 'close') {
          closePolyline(ctx, session.session);
          return;
        }
        ctx.stores.lassoPreview.set(polylinePreview(session.session));
        ctx.invalidate({ overlay: true });
        return;
      }
      if (session) {
        return;
      }
      session =
        kind === 'freehand'
          ? { kind: 'freehand', points: [{ x: input.documentPoint.x, y: input.documentPoint.y }] }
          : { kind: 'drag', moved: false, startDoc: input.documentPoint, startScreen: input.screenPoint };
    },
    onPointerMove: (ctx, input, batch) => {
      if (!session) {
        return;
      }
      const kind = ctx.stores.shapeOptions.get().kind;
      if (!sessionFitsKind(session, kind)) {
        reset(ctx);
        return;
      }
      if (session.kind === 'polyline') {
        if (movePolyline(ctx, session.session, input)) {
          ctx.updateCursor();
        }
        ctx.stores.lassoPreview.set(polylinePreview(session.session));
        ctx.invalidate({ overlay: true });
        return;
      }
      if (session.kind === 'freehand') {
        for (const sample of batch) {
          const last = session.points[session.points.length - 1];
          if (!last || distance(last, sample.documentPoint) >= FREEHAND_MIN_POINT_DISTANCE) {
            session.points.push({ x: sample.documentPoint.x, y: sample.documentPoint.y });
          }
        }
        ctx.stores.lassoPreview.set({ kind: 'freehand', points: session.points.slice() });
        ctx.invalidate({ overlay: true });
        return;
      }
      if (!session.moved) {
        const dxs = input.screenPoint.x - session.startScreen.x;
        const dys = input.screenPoint.y - session.startScreen.y;
        if (Math.hypot(dxs, dys) < SHAPE_DRAG_THRESHOLD_PX) {
          return;
        }
        session.moved = true;
      }
      if (kind !== 'polygon' && kind !== 'freehand') {
        const rect = rectFromDrag(session.startDoc, input.documentPoint, input.modifiers.shift);
        ctx.stores.shapePreview.set({ kind, rect });
        ctx.invalidate({ overlay: true });
      }
    },
    onPointerUp: (ctx, input) => {
      if (!session || session.kind === 'polyline') {
        return;
      }
      if (session.kind === 'freehand') {
        commit(ctx, polygonShapeFrom([...session.points, input.documentPoint], styleFromOptions(ctx)));
        return;
      }
      if (!session.moved) {
        reset(ctx);
        return;
      }
      commit(ctx, boxShape(ctx, rectFromDrag(session.startDoc, input.documentPoint, input.modifiers.shift)));
    },
  };
};
