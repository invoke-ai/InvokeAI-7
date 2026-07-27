import { useCallback } from 'react';

/**
 * Props that start a deferred load as soon as the user shows intent, before the
 * click that needs the value has happened. A `null` preloader means there is
 * nothing to warm, so callers can decide that conditionally without branching
 * around the hook.
 *
 * Pointer entry and focus both count, so the keyboard path warms too — the
 * pointer alone would leave tab-and-Enter users paying the full fetch.
 */
export const usePreloadOnIntentProps = (preload: (() => void) | null) => {
  const handleIntent = useCallback(() => {
    preload?.();
  }, [preload]);

  return { onFocus: handleIntent, onPointerEnter: handleIntent };
};
