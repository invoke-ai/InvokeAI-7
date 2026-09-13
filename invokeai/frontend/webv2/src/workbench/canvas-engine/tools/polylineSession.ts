/**
 * A click-to-place polyline shared by the lasso's polygon mode and the shape
 * tool's polygon kind: vertices accumulate across presses, a rubber band
 * follows the cursor, and the shape closes on a double-click, on Enter, or on
 * a press within a screen radius of the first vertex — which the overlay
 * previews as an armed ring while the cursor hovers there.
 *
 * Zero React, zero import-time side effects.
 */

import type { LassoPreview } from '@workbench/canvas-engine/engineStores';
import type { PointerInput, Vec2 } from '@workbench/canvas-engine/types';

import type { ToolContext } from './tool';

/** Fewest distinct points that make a fillable polygon. */
export const MIN_POLYLINE_POINTS = 3;

/** Screen-pixel radius around the first vertex where a click closes the polygon. */
export const POLYLINE_CLOSE_HIT_PX = 8;

/** Longest gap (ms) between two presses that still reads as a double-click. */
export const POLYLINE_DOUBLE_CLICK_MS = 350;

/** Screen-pixel radius within which two presses count as the same spot. */
const DOUBLE_CLICK_PX = 4;

const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export interface PolylineSession {
  points: Vec2[];
  /** The rubber-band endpoint (the last cursor position), or `null` before any move. */
  cursor: Vec2 | null;
  /** Whether the cursor sits on the first vertex, where a click closes the polygon. */
  closeArmed: boolean;
  /** Screen position and time of the previous press, for double-click detection. */
  lastPressScreen: Vec2;
  lastPressAt: number;
}

/** Starts a session with its first vertex at the press. */
export const startPolyline = (input: PointerInput): PolylineSession => ({
  closeArmed: false,
  cursor: null,
  lastPressAt: input.timeStamp,
  lastPressScreen: input.screenPoint,
  points: [{ x: input.documentPoint.x, y: input.documentPoint.y }],
});

/** True when a press at `screenPoint` lands on the polygon's first vertex (once it is fillable). */
export const isOnFirstVertex = (ctx: ToolContext, session: PolylineSession, screenPoint: Vec2): boolean => {
  const first = session.points[0];
  if (!first || session.points.length < MIN_POLYLINE_POINTS) {
    return false;
  }
  // Project through the viewport rather than caching the vertex's screen
  // position: the user may pan (space-hold) between vertices.
  return distance(ctx.viewport.documentToScreen(first), screenPoint) <= POLYLINE_CLOSE_HIT_PX;
};

/**
 * Handles a press after the first: closes when it double-clicks or lands on
 * the first vertex, else places a vertex. Returns what happened.
 */
export const pressPolyline = (ctx: ToolContext, session: PolylineSession, input: PointerInput): 'close' | 'place' => {
  const isDoubleClick =
    input.timeStamp - session.lastPressAt <= POLYLINE_DOUBLE_CLICK_MS &&
    distance(session.lastPressScreen, input.screenPoint) <= DOUBLE_CLICK_PX;
  if (isDoubleClick || isOnFirstVertex(ctx, session, input.screenPoint)) {
    return 'close';
  }
  session.points.push({ x: input.documentPoint.x, y: input.documentPoint.y });
  session.lastPressAt = input.timeStamp;
  session.lastPressScreen = input.screenPoint;
  return 'place';
};

/** Tracks the rubber band and the close cue; true when the cue flipped (the cursor should refresh). */
export const movePolyline = (ctx: ToolContext, session: PolylineSession, input: PointerInput): boolean => {
  session.cursor = { x: input.documentPoint.x, y: input.documentPoint.y };
  const closeArmed = isOnFirstVertex(ctx, session, input.screenPoint);
  if (closeArmed === session.closeArmed) {
    return false;
  }
  session.closeArmed = closeArmed;
  return true;
};

/** The overlay's view of the session. */
export const polylinePreview = (session: PolylineSession): LassoPreview => ({
  closeArmed: session.closeArmed,
  closeRadiusPx: session.points.length >= MIN_POLYLINE_POINTS ? POLYLINE_CLOSE_HIT_PX : null,
  cursor: session.cursor,
  kind: 'polygon',
  points: session.points.slice(),
});
