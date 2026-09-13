import { shallowEqual } from '@platform/state/selectors';
import { applyThemeToRoot } from '@theme/applyTheme';
import { DEFAULT_THEME, THEMES_BY_ID } from '@theme/system';
import { useWorkbenchSettingsSelector } from '@workbench/settings/store';
import { useLayoutEffect } from 'react';

/**
 * Applies the persisted appearance preferences to the document root.
 *
 * Theme switching is intentionally a DOM-attribute flip rather than a React
 * re-theme: the semantic-token conditions in `theme/system.ts` key off
 * `<html data-theme>`, so changing the attribute restyles the whole shell with
 * no component re-render. `data-reduce-motion` is read by global CSS motion
 * tokens. Renders nothing.
 */
/**
 * Read by the pre-paint script in index.html. Dedicated hint keys (rather than
 * the workbench snapshot, which is per-user on multi-user backends) let first
 * paint apply last-used appearance without knowing who is signed in.
 */
const THEME_HINT_STORAGE_KEY = 'invokeai:v7:webv2:theme';
const REDUCE_MOTION_HINT_STORAGE_KEY = 'invokeai:v7:webv2:reduce-motion';
const HIGH_CONTRAST_HINT_STORAGE_KEY = 'invokeai:v7:webv2:high-contrast';

/** Mirrors a boolean appearance flag onto `<html data-*>` and its pre-paint hint. */
const applyRootFlag = (dataKey: 'highContrast' | 'reduceMotion', hintKey: string, enabled: boolean): void => {
  const root = document.documentElement;
  if (enabled) {
    root.dataset[dataKey] = 'true';
  } else {
    delete root.dataset[dataKey];
  }
  try {
    if (enabled) {
      window.localStorage.setItem(hintKey, 'true');
    } else {
      window.localStorage.removeItem(hintKey);
    }
  } catch {
    // Storage unavailable — the next load just waits for settings to resolve.
  }
};

export const ThemeController = () => {
  const { highContrast, reduceMotion, status, themeId } = useWorkbenchSettingsSelector(
    (snapshot) => ({
      highContrast: snapshot.preferences.highContrast,
      reduceMotion: snapshot.preferences.reduceMotion,
      status: snapshot.status,
      themeId: snapshot.preferences.themeId,
    }),
    shallowEqual
  );
  // Until the settings store has resolved, the pre-paint hint script owns the
  // theme; applying the store's defaults here would flash and clobber it.
  const hasResolved = status === 'ready' || status === 'error';

  useLayoutEffect(() => {
    if (!hasResolved) {
      return;
    }

    const theme = THEMES_BY_ID[themeId] ?? DEFAULT_THEME;

    applyThemeToRoot(theme.id);

    try {
      window.localStorage.setItem(THEME_HINT_STORAGE_KEY, theme.id);
    } catch {
      // Storage unavailable — the next load just paints the default theme.
    }
  }, [hasResolved, themeId]);

  useLayoutEffect(() => {
    if (hasResolved) {
      applyRootFlag('reduceMotion', REDUCE_MOTION_HINT_STORAGE_KEY, reduceMotion);
    }
  }, [hasResolved, reduceMotion]);

  useLayoutEffect(() => {
    if (hasResolved) {
      applyRootFlag('highContrast', HIGH_CONTRAST_HINT_STORAGE_KEY, highContrast);
    }
  }, [hasResolved, highContrast]);

  return null;
};
