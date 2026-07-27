/**
 * Runs `task` once the browser is idle, returning a canceller.
 *
 * `requestIdleCallback` is not universal — Safari only shipped it recently —
 * so this falls back to a macrotask, which still yields to the work already
 * queued for the current turn. Callers use this to warm something the user has
 * not asked for yet, so being late is fine and being early is not.
 */
export const scheduleIdleTask = (task: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(() => {
      task();
    });

    return () => {
      cancelIdleCallback(handle);
    };
  }

  const handle = setTimeout(task, 1);

  return () => {
    clearTimeout(handle);
  };
};
