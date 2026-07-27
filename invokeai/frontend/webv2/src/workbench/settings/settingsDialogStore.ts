import type { SettingsSectionId } from '@workbench/widgetContracts';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createDeferredCommit } from '@platform/state/deferredCommit';
import { createExternalStore } from '@platform/state/externalStore';

import { settingsDialogResource } from './settingsDialogResource';

/**
 * Open/close state for the workbench settings dialog, addressable from
 * anywhere: widget frames, menus, and commands call `openWorkbenchSettings`
 * with the section they want. The dialog itself is hosted by the top bar's
 * `SettingsButton`, which subscribes to this store.
 */

interface SettingsDialogSnapshot {
  isOpen: boolean;
  sectionId: SettingsSectionId;
}

const INITIAL_SETTINGS_DIALOG_SNAPSHOT: SettingsDialogSnapshot = {
  isOpen: false,
  sectionId: 'appearance',
};

export const settingsDialogStore = createExternalStore<SettingsDialogSnapshot>(INITIAL_SETTINGS_DIALOG_SNAPSHOT);

const openCommit = createDeferredCommit<SettingsSectionId>(
  () => settingsDialogResource,
  (sectionId) => {
    settingsDialogStore.setSnapshot({ isOpen: true, sectionId });
  }
);

registerAccountOwnedResource({
  clear: () => {
    openCommit.cancel();
    settingsDialogStore.setSnapshot(INITIAL_SETTINGS_DIALOG_SNAPSHOT);
  },
  name: 'settings-dialog',
});

/**
 * Open the workbench settings dialog, optionally at a specific section.
 *
 * The dialog body is loaded before the store flips, so the dialog mounts
 * against a module that is already in hand instead of suspending. The first
 * open is therefore as fast as the fetch, not the fetch plus React's fallback
 * throttle. Every caller gets that for free — there is no eager path to the
 * body and no second way to open it.
 */
export const openWorkbenchSettings = (sectionId: SettingsSectionId = 'appearance'): void => {
  openCommit.request(sectionId);
};

export const closeWorkbenchSettings = (): void => {
  openCommit.cancel();
  settingsDialogStore.patchSnapshot({ isOpen: false });
};

export const setWorkbenchSettingsSection = (sectionId: SettingsSectionId): void => {
  settingsDialogStore.patchSnapshot({ sectionId });
};
