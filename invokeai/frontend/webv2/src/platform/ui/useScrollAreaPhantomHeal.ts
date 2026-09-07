import type { RefObject } from 'react';

import { useMountEffect } from '@platform/react/useMountEffect';

/**
 * Zag's initial scroll-area measure can race a popover's or dialog's
 * zero-size mount (its resize observers can even end up watching pre-remount
 * nodes), and its "has overflow" default then strands a phantom thumb on
 * content that never overflowed. Whenever a check finds that contradiction on
 * the live nodes, one synthetic scroll routes a re-measure through zag's own
 * event path — and clears the contradiction, so the checks cannot loop.
 * Scroll listeners on these viewports must tolerate a no-op scroll event.
 *
 * Mount this next to any `ScrollArea.Viewport` (see `Scrollable`); the ref
 * must point at the viewport element.
 */
export const useScrollAreaPhantomHeal = (viewportRef: RefObject<HTMLElement | null>): void => {
  useMountEffect(() => {
    // Always through the ref: a presence pass can remount the subtree, and a
    // node captured at effect time goes dead (which is also how zag's own
    // observers end up blind here).
    const hasPhantomScrollbar = () => {
      const viewport = viewportRef.current;
      // `:scope >`: a nested scroll area's scrollbar must not answer for
      // ours. Every scrollbar carries both overflow attributes, so the first
      // sibling bar is authoritative.
      const scrollbar = viewport?.parentElement?.querySelector(':scope > [data-part="scrollbar"]');

      if (!viewport || !scrollbar) {
        return false;
      }

      const phantomY = scrollbar.hasAttribute('data-overflow-y') && viewport.scrollHeight <= viewport.clientHeight;
      const phantomX = scrollbar.hasAttribute('data-overflow-x') && viewport.scrollWidth <= viewport.clientWidth;

      return Boolean(phantomY || phantomX);
    };

    let observed: HTMLElement | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const observer = new ResizeObserver(() => check());

    const check = () => {
      const viewport = viewportRef.current;

      if (!viewport) {
        return;
      }

      if (viewport !== observed) {
        if (observed) {
          observer.unobserve(observed);
        }

        observer.observe(viewport);
        observed = viewport;
      }

      if (hasPhantomScrollbar()) {
        viewport.dispatchEvent(new Event('scroll'));
      }
    };

    // The timed checks catch a presence remount the observer can no longer
    // see; each re-syncs observation to the ref's current node, and the
    // re-synced observer covers real resizes from then on.
    for (const delay of [64, 250, 600]) {
      timers.push(setTimeout(check, delay));
    }

    check();

    return () => {
      timers.forEach(clearTimeout);
      observer.disconnect();
    };
  });
};
