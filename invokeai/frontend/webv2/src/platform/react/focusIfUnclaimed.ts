/** Operable elements, minus the ones kept out of the tab order -- a select's hidden native control, for one. */
const FOCUSABLE = ['button', '[href]', 'input', 'select', 'textarea', '[tabindex]']
  .map((selector) => `${selector}:not([disabled]):not([tabindex="-1"]):not([aria-hidden="true"])`)
  .join(', ');

/** Moves focus to the first operable element inside `element`. */
export const focusFirstOperable = (element: HTMLElement | null): void => {
  element?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
};

/**
 * For content revealed after the control that held focus unmounted -- a retry button replaced by the
 * thing it loaded. Moves focus into `element`, but only while nothing holds focus: it rescues a
 * keyboard user whose focus fell to `<body>` without pulling focus from wherever someone has since
 * moved it.
 */
export const focusIfUnclaimed = (element: HTMLElement | null): void => {
  if (document.activeElement !== null && document.activeElement !== document.body) {
    return;
  }

  focusFirstOperable(element);
};
