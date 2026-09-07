import type { PanZoomPoint } from '@workbench/panZoom';

/**
 * Pointer bookkeeping shared by the preview's two loupes — the stage loupe and
 * the side-by-side comparison one. Both track every finger that is down so a
 * second one can turn a pan into a pinch; only the coordinate space they zoom
 * in differs.
 */

/**
 * Records a pointer that just went down and reports the pair that should pinch,
 * once there is one.
 *
 * The first finger of a touch (and any mouse press) starts a fresh set: a
 * pointer whose release lands outside the surface is never seen going up, so
 * this is what stops a stale entry from pairing into a phantom pinch on the
 * next touch.
 */
export const trackPointerDown = (
  pointers: Map<number, PanZoomPoint>,
  event: { clientX: number; clientY: number; isPrimary: boolean; pointerId: number }
): [number, number] | null => {
  if (event.isPrimary) {
    pointers.clear();
  }

  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pointers.size !== 2) {
    return null;
  }

  const [first, second] = [...pointers.keys()];

  return [first!, second!];
};

/**
 * Capture, tolerating a pointer that is already gone: the browser can queue a
 * `pointerdown` behind the release of another finger, and `setPointerCapture`
 * throws for a pointer that is no longer active. A gesture that misses its
 * capture still tracks — it only loses the fingers that wander off the surface.
 */
export const capturePointer = (element: Element, pointerId: number): void => {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Pointer ended before the gesture could claim it.
  }
};

/** Releases a capture this surface holds, if it holds one. */
export const releasePointer = (element: Element, pointerId: number): void => {
  if (element.hasPointerCapture(pointerId)) {
    element.releasePointerCapture(pointerId);
  }
};
