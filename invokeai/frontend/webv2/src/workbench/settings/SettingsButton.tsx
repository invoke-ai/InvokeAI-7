import { scheduleIdleTask } from '@platform/browser/idle';
import { useMountEffect } from '@platform/react/useMountEffect';
import { usePreloadOnIntentProps } from '@platform/react/usePreloadOnIntent';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { SettingsIcon } from 'lucide-react';
import { Suspense, use, useCallback } from 'react';

import { settingsDialogResource } from './settingsDialogResource';
import { closeWorkbenchSettings, openWorkbenchSettings, settingsDialogStore } from './settingsDialogStore';

/**
 * The top bar's settings entry point, kept deliberately thin.
 *
 * The trigger owns nothing but the store subscription; the body arrives on
 * first open. Two things keep that from being felt: hovering or focusing the
 * button starts the fetch, and the module is warmed at idle regardless, because
 * settings is also reachable from the command palette and from every widget
 * header without this button ever being touched.
 */
export const SettingsButton = () => {
  const isOpen = settingsDialogStore.useSelector((snapshot) => snapshot.isOpen);
  const intentProps = usePreloadOnIntentProps(settingsDialogResource.preload);
  const handleOpen = useCallback(() => openWorkbenchSettings(), []);

  useMountEffect(() => scheduleIdleTask(settingsDialogResource.preload));

  return (
    <>
      <Tooltip content="Settings">
        <IconButton aria-label="Settings" size="sm" variant="ghost" onClick={handleOpen} {...intentProps}>
          <SettingsIcon />
        </IconButton>
      </Tooltip>
      {isOpen ? (
        <Suspense fallback={null}>
          <SettingsDialogHost />
        </Suspense>
      ) : null}
    </>
  );
};

/**
 * The boundary above is a safety net, not the normal path: `openWorkbenchSettings`
 * waits for the module, and the resource hands `use()` a settled promise, so
 * this reads the component synchronously and commits in the same frame.
 */
const SettingsDialogHost = () => {
  const { SettingsDialog } = use(settingsDialogResource.load());

  return <SettingsDialog isOpen onClose={closeWorkbenchSettings} />;
};
