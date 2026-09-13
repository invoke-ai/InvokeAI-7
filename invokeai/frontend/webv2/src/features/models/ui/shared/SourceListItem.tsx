/* eslint-disable react-perf/jsx-no-jsx-as-prop, react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop */
import type { ReactNode } from 'react';

import { Badge, HStack, Icon, Spinner, Stack, Text } from '@chakra-ui/react';
import { useActiveInstallSources } from '@features/models/data/installsStore';
import { openInstallQueue, openModelDetail } from '@features/models/ui/uiStore';
import { Button, Panel } from '@platform/ui';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The shared row used by every installable-source list (starter models,
 * HuggingFace files, folder-scan results, related models): title + badges on
 * top, optional description below, action on the right.
 */
export const SourceListItem = ({
  badges,
  description,
  title,
  titleTooltip,
  trailing,
}: {
  badges?: ReactNode;
  description?: ReactNode;
  title: string;
  titleTooltip?: string;
  trailing?: ReactNode;
}) => (
  <Panel alignItems="center" flexDirection="row" gap="3" p="2.5">
    <Stack flex="1" gap="0.5" minW="0">
      <HStack gap="1.5" minW="0">
        <MiddleTruncate fontSize="xs" fontWeight="600" text={title} title={titleTooltip} />
        {badges}
      </HStack>
      {description ? (
        // `fg.subtle` at this size only reaches 3.56:1 on the panel surface,
        // short of WCAG AA. `fg.muted` clears 4.5:1.
        <Text color="fg.muted" fontSize="2xs" lineClamp={2}>
          {description}
        </Text>
      ) : null}
    </Stack>
    {trailing}
  </Panel>
);

/**
 * Install action with live state: idle → Install button; queuing/active →
 * disabled "Installing…" with a jump to the install queue; done → badge with a
 * jump to the installed model's page when the library knows which one it is.
 */
export const InstallSourceButton = ({
  installedModelKey = null,
  isInstalled = false,
  isPending = false,
  onInstall,
  source,
}: {
  /** The library model this source landed as; implies installed. */
  installedModelKey?: string | null;
  /** Already in the library, without a known model to open. */
  isInstalled?: boolean;
  /** The install POST is in flight (before a job exists). */
  isPending?: boolean;
  onInstall: () => void;
  /** Source string used to match an active install job. */
  source: string;
}) => {
  const { t } = useTranslation();
  const activeSources = useActiveInstallSources();
  const isInstalling = isPending || activeSources.has(source);

  if (isInstalled || installedModelKey !== null) {
    return (
      <HStack flexShrink={0} gap="1.5">
        <Badge colorPalette="green" fontSize="2xs" size="sm" variant="surface">
          {t('models.installed')}
        </Badge>
        {installedModelKey !== null ? (
          <Button
            size="2xs"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              openModelDetail(installedModelKey);
            }}
          >
            {t('models.viewModel')}
          </Button>
        ) : null}
      </HStack>
    );
  }

  if (isInstalling) {
    return (
      <HStack flexShrink={0} gap="1.5">
        <Badge colorPalette="blue" fontSize="2xs" size="sm" variant="surface">
          <Spinner borderWidth="1.5px" boxSize="2.5" />
          {t('models.installing')}
        </Badge>
        <Button
          size="2xs"
          variant="ghost"
          onClick={(event) => {
            event.stopPropagation();
            openInstallQueue();
          }}
        >
          {t('models.viewQueue')}
        </Button>
      </HStack>
    );
  }

  return (
    <Button
      flexShrink={0}
      size="2xs"
      variant="outline"
      onClick={(event) => {
        event.stopPropagation();
        onInstall();
      }}
    >
      <Icon as={DownloadIcon} boxSize="3" />
      {t('models.install')}
    </Button>
  );
};
