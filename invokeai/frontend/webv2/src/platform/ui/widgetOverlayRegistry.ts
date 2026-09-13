/**
 * The React-free half of widget overlay dismissal: an epoch every registered
 * overlay watches, plus the closes to resend. `widgetOverlays.ts` binds it to
 * React; the workbench store bumps it before a switch hides widgets.
 */

let epoch = 0;
const subscribers = new Set<() => void>();
const closers = new Set<() => void>();

export const subscribeToWidgetOverlayEpoch = (listener: () => void): (() => void) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};

export const getWidgetOverlayEpoch = (): number => epoch;

export const registerWidgetOverlayCloser = (close: () => void): (() => void) => {
  closers.add(close);
  return () => {
    closers.delete(close);
  };
};

/**
 * Closes every overlay that originates inside a widget; shell overlays stay.
 * Call it before the switch that hides the widget: the overlay library defers
 * its own close to a microtask and drops it once the widget's tree is hidden,
 * so the epoch bump removes the content synchronously, in the same commit as
 * the switch, and the deferred close catches up wherever it can. Every widget's
 * overlays close, including ones the switch leaves visible.
 */
export const closeWidgetOverlays = (): void => {
  epoch += 1;
  for (const notify of Array.from(subscribers)) {
    notify();
  }
  for (const close of Array.from(closers)) {
    close();
  }
};
