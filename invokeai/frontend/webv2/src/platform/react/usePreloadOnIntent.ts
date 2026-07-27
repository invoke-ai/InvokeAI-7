import { useCallback, useEffect } from 'react';

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

const HOTKEY_MODIFIER_KEYS = new Set(['Control', 'Meta']);

/**
 * Starts a deferred load when the user reaches for a keyboard shortcut.
 *
 * A surface opened by `mod+K` has no pointer to hover and no button to focus,
 * so the alternative is warming it speculatively at idle — which puts its bytes
 * on every route load whether or not the shortcut is ever pressed. Holding the
 * modifier is the earliest honest signal, and it lands well before the second
 * key: enough to cover the fetch, and nothing at all if the user never reaches
 * for it. Repeat presses are free because the resource loads at most once.
 */
export const usePreloadOnHotkeyIntent = (preload: () => void): void => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (HOTKEY_MODIFIER_KEYS.has(event.key)) {
        preload();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [preload]);
};
