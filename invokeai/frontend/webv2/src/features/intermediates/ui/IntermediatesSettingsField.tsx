import type { SettingFieldProps } from '@platform/ui/settings/contracts';

import { Box } from '@chakra-ui/react';
import { useAuthSession, useCapabilities } from '@features/identity';

import { IntermediatesManager } from './IntermediatesManager';

/** The Settings section body: a filling editor that owns its own scrolling. */
export const IntermediatesSettingsField = (_props: SettingFieldProps) => {
  const session = useAuthSession();
  const { canClearOthersIntermediates } = useCapabilities();
  const user = session.phase === 'ready' ? session.user : null;

  return (
    <Box display="flex" flex="1" flexDirection="column" minH="0">
      <IntermediatesManager
        canClearOthersIntermediates={canClearOthersIntermediates}
        currentUserId={user?.user_id ?? null}
        currentUserLabel={user ? user.display_name || user.email : null}
      />
    </Box>
  );
};
