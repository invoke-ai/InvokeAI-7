import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { SettingsIcon } from 'lucide-react';

import { SettingsDialogHost } from './SettingsDialogHost';
import { openWorkbenchSettings } from './settingsDialogStore';

const handleOpen = () => openWorkbenchSettings();

/**
 * Launchpad settings entry; the workbench opens settings from its app menu and hosts {@link SettingsDialogHost}
 * separately.
 */
export const SettingsButton = () => {
  return (
    <>
      <Tooltip content="Settings">
        <IconButton aria-label="Settings" size="sm" variant="ghost" onClick={handleOpen}>
          <SettingsIcon />
        </IconButton>
      </Tooltip>
      <SettingsDialogHost />
    </>
  );
};
