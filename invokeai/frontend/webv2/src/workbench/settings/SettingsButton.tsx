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
 * first open, warmed by hovering or focusing this button.
 *
 * Deliberately not warmed at idle, unlike the command palette. The dialog body
 * reaches the workbench aggregate through `clearAllWorkbenchData` and the
 * optional workbench selectors, which drags the canvas engine and the
 * generation, workflow, and upscale cores along with it — on the Launchpad that
 * measured as 19 requests becoming 40 and 1.57MB becoming 1.90MB, for a route
 * whose whole point is not to load the editor. Warming it there would trade a
 * felt cost for a much larger unfelt one.
 */
export const SettingsButton = () => {
  const isOpen = settingsDialogStore.useSelector((snapshot) => snapshot.isOpen);
  const intentProps = usePreloadOnIntentProps(settingsDialogResource.preload);
  const handleOpen = useCallback(() => openWorkbenchSettings(), []);

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
