/**
 * DOM-free pan/zoom state transitions shared by every workbench viewport.
 *
 * Coordinate convention: `screen = zoom * content + pan`. Callers provide
 * their own zoom constraint because canvas, preview, and comparison viewports
 * have different limits. Constraints are applied before anchor translation is
 * calculated, so reaching a zoom limit is an exact no-op instead of becoming
 * an accidental pan.
 */

/** Wheel exponential zoom sensitivity: `zoom *= exp(-deltaY * step)`. */
export const WHEEL_ZOOM_STEP = 0.0015;

export interface PanZoomPoint {
  x: number;
  y: number;
}

export interface PanZoomTransform {
  pan: PanZoomPoint;
  zoom: number;
}

export type ConstrainZoom = (zoom: number) => number;

/** Separation of two pointers, for measuring a pinch. */
export const distanceBetween = (a: PanZoomPoint, b: PanZoomPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Point halfway between two pointers — what a pinch zooms and pans around. */
export const midpointOf = (a: PanZoomPoint, b: PanZoomPoint): PanZoomPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/** Sets zoom while keeping the content point under `screenAnchor` fixed. */
export const zoomAtPoint = (
  transform: PanZoomTransform,
  requestedZoom: number,
  screenAnchor: PanZoomPoint,
  constrainZoom: ConstrainZoom
): PanZoomTransform => {
  const zoom = constrainZoom(requestedZoom);

  if (zoom === transform.zoom) {
    return transform;
  }

  const contentAnchor = {
    x: (screenAnchor.x - transform.pan.x) / transform.zoom,
    y: (screenAnchor.y - transform.pan.y) / transform.zoom,
  };

  return {
    pan: {
      x: screenAnchor.x - zoom * contentAnchor.x,
      y: screenAnchor.y - zoom * contentAnchor.y,
    },
    zoom,
  };
};

/** Applies exponential wheel zoom around `screenAnchor`. */
export const wheelZoomAtPoint = (
  transform: PanZoomTransform,
  deltaY: number,
  screenAnchor: PanZoomPoint,
  { constrainZoom, step = WHEEL_ZOOM_STEP }: { constrainZoom: ConstrainZoom; step?: number }
): PanZoomTransform => {
  const target = constrainZoom(transform.zoom * Math.exp(-deltaY * step));

  return zoomAtPoint(transform, target, screenAnchor, constrainZoom);
};

/** Pans by a screen-space delta. */
export const panBy = (transform: PanZoomTransform, screenDelta: PanZoomPoint): PanZoomTransform => ({
  pan: { x: transform.pan.x + screenDelta.x, y: transform.pan.y + screenDelta.y },
  zoom: transform.zoom,
});

/**
 * Applies a two-pointer pinch: zoom scales by how far the pointers have spread
 * since the gesture began, and the content point under the gesture's starting
 * midpoint is carried to the midpoint's current position — so the image tracks
 * the fingers rather than just growing around a fixed anchor.
 *
 * Every argument is measured against the transform the gesture *started* from,
 * so each move is one transition from that origin instead of a step on top of
 * the last one: clamping at a zoom limit never accumulates into drift, and
 * spreading past the limit still pans with the fingers.
 */
export const pinchZoomAtPoints = (
  start: PanZoomTransform,
  gesture: { center: PanZoomPoint; distance: number; startCenter: PanZoomPoint; startDistance: number },
  constrainZoom: ConstrainZoom
): PanZoomTransform => {
  if (gesture.startDistance <= 0) {
    return start;
  }

  const zoom = constrainZoom(start.zoom * (gesture.distance / gesture.startDistance));
  const contentAnchor = {
    x: (gesture.startCenter.x - start.pan.x) / start.zoom,
    y: (gesture.startCenter.y - start.pan.y) / start.zoom,
  };

  return {
    pan: {
      x: gesture.center.x - zoom * contentAnchor.x,
      y: gesture.center.y - zoom * contentAnchor.y,
    },
    zoom,
  };
};
