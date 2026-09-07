import { useMountEffect } from '@platform/react/useMountEffect';
import { createContext, useContext, useState, useSyncExternalStore } from 'react';

import {
  getWidgetOverlayEpoch,
  registerWidgetOverlayCloser,
  subscribeToWidgetOverlayEpoch,
} from './widgetOverlayRegistry';

export { closeWidgetOverlays } from './widgetOverlayRegistry';

/**
 * Marks a subtree as one widget's own: overlays opened inside it answer to
 * `closeWidgetOverlays`. Provided by the widget host.
 */
export const WidgetOverlayOwnerContext = createContext(false);

const subscribeToNothing = (): (() => void) => () => undefined;

/**
 * Registers an overlay's content with the widget it lives in, for as long as
 * the content is mounted. Returns true while the overlay was told to close but
 * its library still reports it open — the content then renders nothing. A
 * widget shown again re-runs its effects, which is when the close is resent.
 */
export const useRegisterWidgetOverlay = (open: boolean, setOpen: (open: boolean) => void): boolean => {
  const ownedByWidget = useContext(WidgetOverlayOwnerContext);
  const current = useSyncExternalStore(
    ownedByWidget ? subscribeToWidgetOverlayEpoch : subscribeToNothing,
    getWidgetOverlayEpoch,
    getWidgetOverlayEpoch
  );
  // The epoch this opening belongs to, reset whenever the overlay reopens.
  const [opening, setOpening] = useState({ epoch: current, open });
  if (opening.open !== open) {
    setOpening({ epoch: current, open });
  }
  const stale = ownedByWidget && open && opening.epoch !== current;
  // Runs on mount and again when a hidden widget is shown; the registry is read
  // live so a bump that happened while hidden counts too.
  useMountEffect(() => {
    if (!ownedByWidget) {
      return;
    }
    if (open && opening.epoch !== getWidgetOverlayEpoch()) {
      setOpen(false);
    }
    return registerWidgetOverlayCloser(() => setOpen(false));
  });
  return stale;
};
