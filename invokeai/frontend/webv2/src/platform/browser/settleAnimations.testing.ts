/**
 * Wait for animations to finish before asserting on how something looks.
 *
 * `toBeVisible()` is satisfied the moment an element is laid out, which for anything that
 * fades or scales in is several frames before it looks like itself. An assertion that reads
 * rendered appearance — a contrast audit, a screenshot, a measured box — taken in that window
 * reads the animation's midpoint instead: a Chakra dialog caught at `opacity: 0.22` composites
 * its text over the backdrop and audits as 1.18:1 against a 4.5:1 rule, reporting a palette
 * failure that does not exist.
 *
 * That window is real but short, so whether an assertion lands inside it depends on how busy
 * the machine is — which in a browser run means how many OTHER test files the suite happens to
 * be scheduling. A suite that passes at 204 files starts failing at 205, in a file the new one
 * never touches.
 *
 * Test-only: it needs a real browser's animation timeline, and production code has no reason
 * to block on one.
 */

/**
 * Whether awaiting this animation will ever end.
 *
 * Four states never settle, and awaiting any of them turns a test into a timeout rather than a
 * failure. Only the first is obvious, and checking `iterations` alone does not catch the rest:
 * measured in this suite's Chromium, a paused animation, one with `playbackRate: 0`, and one
 * with an infinite `duration` all report `iterations: 1` and leave `finished` pending forever.
 * The scope below is the whole document, so one of these anywhere on the page would otherwise
 * hang every caller.
 */
const willFinish = (animation: Animation): boolean => {
  const timing = animation.effect?.getComputedTiming();
  const duration = typeof timing?.duration === 'number' ? timing.duration : 0;

  return (
    timing?.iterations !== Infinity &&
    Number.isFinite(duration) &&
    animation.playbackRate !== 0 &&
    animation.playState !== 'paused'
  );
};

/**
 * Resolve once every animation running when it is called has finished.
 *
 * Defaults to the whole document rather than the subtree under assertion, because what an
 * appearance assertion reads is the COMPOSITE. A Chakra dialog's backdrop is a sibling of its
 * positioner, not a descendant, and fades over `slow` while the content in front of it fades
 * over `moderate` — so settling only `[role="dialog"]` returns with the backdrop a third of the
 * way through, and the first translucent surface anyone audits gets this flake straight back.
 * Portalled content (menus, popovers) sits outside the caller's subtree for the same reason.
 * Animations that never finish are filtered out, so the wider scope costs nothing.
 *
 * `allSettled`, not `all`: removing an element cancels its CSS animation, which rejects the
 * `finished` promise captured here with an `AbortError` (measured — and CSS animations are what
 * the components under test use). A subtree that stopped animating because it went away has
 * settled too, and an unhandled rejection would fail the test for the wrong reason.
 */
export const settleAnimations = async (root: Document | Element = document): Promise<void> => {
  await Promise.allSettled(
    root
      .getAnimations({ subtree: true })
      .filter(willFinish)
      .map((animation) => animation.finished)
  );
};
