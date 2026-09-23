import type { SystemStyleObject } from '@chakra-ui/react';
import type { LucideIcon } from 'lucide-react';

import { Box, Icon, Stack, Text } from '@chakra-ui/react';
import { Tabs } from '@platform/ui';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { HelpMenu } from './HelpMenu';

const NAV_BORDER_END_WIDTH = { md: '1px' } as const;
const NAV_BORDER_BOTTOM_WIDTH = { base: '1px', md: '0' } as const;
const NAV_WIDTH = { base: 'full', md: '56' } as const;
/** Below md, size the stacked rail to content; full height would consume the fixed shell and leave no page area. */
const NAV_HEIGHT = { base: 'auto', md: 'full' } as const;
const FOOTER_MARGIN_TOP = { md: 'auto' } as const;

/**
 * Keep decorative group headings inside one Tabs.List so arrow navigation crosses groups while separating work
 * from administration.
 */

export type LaunchpadNavGroupId = 'workspace' | 'manage';

export interface LaunchpadNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  group: LaunchpadNavGroupId;
}

const GROUP_ORDER: readonly LaunchpadNavGroupId[] = ['workspace', 'manage'];

const GROUP_LABEL_KEY: Record<LaunchpadNavGroupId, string> = {
  manage: 'launchpad.groups.manage',
  workspace: 'launchpad.groups.workspace',
};

/** Use fg.muted for rail-heading contrast; the menu label's fg.subtle falls below 4.5:1 here. */
const GROUP_LABEL_SX: SystemStyleObject = {
  color: 'fg.muted',
  fontSize: '2xs',
  fontWeight: '600',
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
};

export const LaunchpadNav = ({ items }: { items: LaunchpadNavItem[] }) => {
  const { t } = useTranslation();
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
        (entry) => entry.items.length > 0
      ),
    [items]
  );
  // Show headings only when multiple groups need distinguishing.
  const showGroupLabels = groups.length > 1;

  return (
    <Stack
      aria-label={t('launchpad.sectionsLabel')}
      as="nav"
      borderColor="border.subtle"
      borderBottomWidth={NAV_BORDER_BOTTOM_WIDTH}
      borderEndWidth={NAV_BORDER_END_WIDTH}
      flexShrink={0}
      gap="2"
      h={NAV_HEIGHT}
      minH="0"
      p="2"
      w={NAV_WIDTH}
    >
      {items.length > 1 ? (
        <Tabs.List flexShrink={0} gap="0.5">
          {groups.map((entry, index) => (
            <Fragment key={entry.group}>
              {showGroupLabels ? (
                // A `role="separator"` element is an invalid tablist child, so
                // the spacing above each heading does the dividing instead.
                <Text css={GROUP_LABEL_SX} pb="1" pt={index > 0 ? '3' : '1'} px="2" role="presentation">
                  {t(GROUP_LABEL_KEY[entry.group])}
                </Text>
              ) : null}
              {entry.items.map((item) => (
                <Tabs.Trigger key={item.id} value={item.id}>
                  <Icon as={item.icon} boxSize="3.5" flexShrink={0} />
                  <Text truncate>{item.label}</Text>
                </Tabs.Trigger>
              ))}
            </Fragment>
          ))}
        </Tabs.List>
      ) : null}

      <Box mt={FOOTER_MARGIN_TOP}>
        <HelpMenu />
      </Box>
    </Stack>
  );
};
