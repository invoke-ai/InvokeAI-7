import type { DeferredResource } from '@platform/state/deferredResource';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createDeferredCommit } from '@platform/state/deferredCommit';
import { createExternalStoreCore } from '@platform/state/externalStoreCore';
import { useSyncExternalStore } from 'react';

/**
 * Open/close state for the command palette, addressable from anywhere: the
 * top-bar buttons, the `app.openCommandPalette` command, and the Launchpad's
 * own mod+K binding all funnel through here. The dialog is hosted per surface
 * (WorkbenchCommandPalette in the editor, LaunchpadCommandPalette on the
 * launchpad) and subscribes to this store.
 */

export const commandPaletteStore = createExternalStoreCore<{ isOpen: boolean }>({ isOpen: false });

export const useIsCommandPaletteOpen = (): boolean =>
  useSyncExternalStore(commandPaletteStore.subscribe, commandPaletteStore.getSnapshot, commandPaletteStore.getSnapshot)
    .isOpen;

let returnFocusElement: HTMLElement | null = null;
let dialogResource: DeferredResource<unknown> | null = null;

/**
 * Tells the store which dialog body the mounted surface will show, so opening
 * can wait for that module instead of committing and suspending.
 *
 * Registration is scoped to the host's mount rather than module evaluation: the
 * launchpad and the editor load different dialogs, and navigating between them
 * would otherwise leave the store waiting on the other surface's module — which
 * is both the wrong download and no protection against the suspension.
 */
export const registerCommandPaletteDialog = (resource: DeferredResource<unknown>): (() => void) => {
  dialogResource = resource;

  return () => {
    if (dialogResource === resource) {
      dialogResource = null;
    }
  };
};

/** Warms the mounted surface's dialog; a no-op before any host has registered. */
export const preloadCommandPaletteDialog = (): void => {
  dialogResource?.preload();
};

const openCommit = createDeferredCommit<void>(
  () => dialogResource,
  () => {
    commandPaletteStore.setSnapshot({ isOpen: true });
  }
);

registerAccountOwnedResource({
  clear: () => {
    returnFocusElement = null;
    openCommit.cancel();
    commandPaletteStore.setSnapshot({ isOpen: false });
  },
  name: 'command-palette',
});

const captureReturnFocusElement = (): void => {
  const activeElement = document.activeElement;

  returnFocusElement = activeElement instanceof HTMLElement ? activeElement : null;
};

export const getCommandPaletteReturnFocusElement = (): HTMLElement | null =>
  returnFocusElement?.isConnected ? returnFocusElement : null;

export const openCommandPalette = (): void => {
  if (commandPaletteStore.getSnapshot().isOpen) {
    return;
  }
  // Captured now, not after the dialog module resolves: focus has to return to
  // whatever the user was on when they asked for the palette.
  captureReturnFocusElement();
  openCommit.request();
};

export const closeCommandPalette = (): void => {
  openCommit.cancel();
  commandPaletteStore.setSnapshot({ isOpen: false });
};

export const toggleCommandPalette = (): void => {
  // A palette that is still loading counts as open, so a second mod+K reads as
  // "never mind" rather than doing nothing and then opening anyway.
  if (commandPaletteStore.getSnapshot().isOpen || openCommit.isPending()) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
};
