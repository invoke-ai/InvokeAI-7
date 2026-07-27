import type { ComponentProps } from 'react';

import { useMountEffect } from '@platform/react/useMountEffect';
import { usePreloadOnHotkeyIntent } from '@platform/react/usePreloadOnIntent';
import { createDeferredResource } from '@platform/state/deferredResource';
import { OPEN_COMMAND_PALETTE_HOTKEY } from '@workbench/hotkeys/catalog';
import { formatHotkeyForPlatform, toTinykeysBinding } from '@workbench/hotkeys/keys';
import { applyCustomHotkeys } from '@workbench/hotkeys/resolve';
import { useWorkbenchPreferences, useWorkbenchPreferenceSelector } from '@workbench/settings/store';
import { Suspense, use } from 'react';
import { tinykeys } from 'tinykeys';

import type { LaunchpadCommandPaletteDialog } from './LaunchpadCommandPaletteDialog';

import {
  closeCommandPalette,
  registerCommandPaletteDialog,
  toggleCommandPalette,
  useIsCommandPaletteOpen,
} from './paletteStore';
import { SETTINGS_ENTRY_DEPS } from './settingsEntryDeps';

const dialogResource = createDeferredResource(() => import('./LaunchpadCommandPaletteDialog'));

const LaunchpadCommandPaletteHotkeys = ({ keys }: { keys: readonly string[] }) => {
  useMountEffect(() => {
    if (keys.length === 0) {
      return;
    }

    const onHotkey = (event: KeyboardEvent): void => {
      event.preventDefault();
      toggleCommandPalette();
    };
    const bindings = Object.fromEntries(keys.map((key) => [toTinykeysBinding(key), onHotkey]));

    return tinykeys(window, bindings, { ignore: () => false });
  });

  return null;
};

/**
 * Lightweight Launchpad runtime and deferred dialog host. The dialog is fetched
 * when the hotkey modifier goes down or the top-bar button is hovered, never
 * speculatively — see the editor host for why.
 */
export const LaunchpadCommandPalette = () => {
  const isOpen = useIsCommandPaletteOpen();
  const customHotkeys = useWorkbenchPreferenceSelector((preferences) => preferences.customHotkeys);
  const paletteHotkeys = applyCustomHotkeys(OPEN_COMMAND_PALETTE_HOTKEY, customHotkeys).keys;

  useMountEffect(() => registerCommandPaletteDialog(dialogResource));
  usePreloadOnHotkeyIntent(dialogResource.preload);

  return (
    <>
      <LaunchpadCommandPaletteHotkeys key={paletteHotkeys.join('\n')} keys={paletteHotkeys} />
      {isOpen ? <OpenLaunchpadCommandPalette /> : null}
    </>
  );
};

const OpenLaunchpadCommandPalette = () => {
  const preferences = useWorkbenchPreferences();

  return (
    <Suspense fallback={null}>
      <LaunchpadCommandPaletteDialogHost
        modifierKeyLabel={formatHotkeyForPlatform('mod')[0]!}
        preferences={preferences}
        settingsEntryDeps={SETTINGS_ENTRY_DEPS}
        onClose={closeCommandPalette}
      />
    </Suspense>
  );
};

const LaunchpadCommandPaletteDialogHost = (props: ComponentProps<typeof LaunchpadCommandPaletteDialog>) => {
  const { LaunchpadCommandPaletteDialog: Dialog } = use(dialogResource.load());

  return <Dialog {...props} />;
};
