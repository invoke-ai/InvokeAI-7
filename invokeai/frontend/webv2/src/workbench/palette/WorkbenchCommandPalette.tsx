import type { ComponentProps } from 'react';

import { requestQueueItemReveal } from '@features/queue/reveal';
import { scheduleIdleTask } from '@platform/browser/idle';
import { useMountEffect } from '@platform/react/useMountEffect';
import { createDeferredResource } from '@platform/state/deferredResource';
import { firstPartyHotkeyCatalog } from '@workbench/hotkeys/catalog';
import { formatHotkeyForPlatform } from '@workbench/hotkeys/keys';
import { registerHotkeyModalLayer } from '@workbench/hotkeys/modalLayer';
import { useWorkbenchPreferences } from '@workbench/settings/store';
import { openWidgetPlacement } from '@workbench/widgetPlacementCommands';
import { getWidgetsForRegion } from '@workbench/widgetRegistry';
import { Suspense, use } from 'react';

import type { WorkbenchCommandPaletteDialog } from './WorkbenchCommandPaletteDialog';

import { closeCommandPalette, registerCommandPaletteDialog, useIsCommandPaletteOpen } from './paletteStore';
import { SETTINGS_ENTRY_DEPS } from './settingsEntryDeps';

const dialogResource = createDeferredResource(() => import('./WorkbenchCommandPaletteDialog'));

/**
 * Lightweight route host; the palette implementation is loaded only while open.
 *
 * The module is also warmed at idle, because the palette's primary entry point
 * is mod+K — there is no hover to key a preload off, and nothing else would
 * fetch the chunk before the keypress that needs it.
 */
export const WorkbenchCommandPalette = () => {
  const isOpen = useIsCommandPaletteOpen();

  useMountEffect(() => registerCommandPaletteDialog(dialogResource));
  useMountEffect(() => scheduleIdleTask(dialogResource.preload));

  return isOpen ? <OpenWorkbenchCommandPalette /> : null;
};

const OpenWorkbenchCommandPalette = () => {
  const preferences = useWorkbenchPreferences();

  useMountEffect(() => registerHotkeyModalLayer('command-palette'));

  return (
    <Suspense fallback={null}>
      <WorkbenchCommandPaletteDialogHost
        catalog={firstPartyHotkeyCatalog}
        formatHotkey={formatHotkeyForPlatform}
        getWidgetsForRegion={getWidgetsForRegion}
        modifierKeyLabel={formatHotkeyForPlatform('mod')[0]!}
        openWidgetPlacement={openWidgetPlacement}
        preferences={preferences}
        requestQueueItemReveal={requestQueueItemReveal}
        settingsEntryDeps={SETTINGS_ENTRY_DEPS}
        onClose={closeCommandPalette}
      />
    </Suspense>
  );
};

/**
 * The boundary above is a safety net, not the normal path: opening waits for
 * this module, and the resource hands `use()` a settled promise, so the dialog
 * commits in the same frame as the state change.
 */
const WorkbenchCommandPaletteDialogHost = (props: ComponentProps<typeof WorkbenchCommandPaletteDialog>) => {
  const { WorkbenchCommandPaletteDialog: Dialog } = use(dialogResource.load());

  return <Dialog {...props} />;
};
