import type { RefCallback } from 'react';

// One wheel notch in `deltaMode` lines, matching what browsers scroll for it.
const LINE_HEIGHT_PX = 16;

const handleWheel = (event: WheelEvent): void => {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement) || event.deltaX !== 0 || event.deltaY === 0) {
    return;
  }
  if (element.scrollWidth <= element.clientWidth) {
    return;
  }
  event.preventDefault();
  element.scrollLeft += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
};

/**
 * Ref for a strip that only scrolls sideways: a vertical wheel, the one most
 * mice have, moves it along its axis instead of doing nothing. Trackpad
 * gestures that already carry a horizontal delta pass through untouched, as
 * does a strip whose content fits.
 */
export const wheelScrollsHorizontally: RefCallback<HTMLElement> = (element) => {
  if (!element) {
    return;
  }
  element.addEventListener('wheel', handleWheel, { passive: false });
  return () => {
    element.removeEventListener('wheel', handleWheel);
  };
};
