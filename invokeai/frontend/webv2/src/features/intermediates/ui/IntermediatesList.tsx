/* eslint-disable react-perf/jsx-no-new-function-as-prop */
import type { IntermediatesRow } from '@features/intermediates/core/types';
import type { TFunction } from 'i18next';

import { Badge, Checkbox, Flex, HStack, Icon, Image, Stack, Text } from '@chakra-ui/react';
import { getIntermediatesRowKey, getKindInUse } from '@features/intermediates/core/types';
import { formatBytes, formatCount } from '@platform/i18n/languages';
import { absolutizeApiUrl } from '@platform/transport/http';
import { Row } from '@platform/ui/Row';
import { FolderIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export const getRowLabel = (row: IntermediatesRow, unassignedLabel: string): string =>
  row.projectId === null ? unassignedLabel : row.projectName || row.projectId;

export const getOwnerLabel = (row: IntermediatesRow, t: TFunction): string =>
  row.userDisplayName || row.userEmail || t('intermediates.owner.unknownAccount');

/**
 * Adds the email to a display name, or a short id to an account with neither, so rows of different accounts stay
 * distinguishable to assistive tech.
 */
const getOwnerAccessibleLabel = (row: IntermediatesRow, t: TFunction): string =>
  row.userDisplayName && row.userEmail
    ? t('intermediates.owner.nameWithEmail', { email: row.userEmail, name: row.userDisplayName })
    : row.userDisplayName || row.userEmail
      ? getOwnerLabel(row, t)
      : t('intermediates.owner.unknownAccountWithId', { id: row.userId.slice(0, 8) });

const Cover = ({ imageName }: { imageName: string | null }) =>
  imageName ? (
    <Image
      alt=""
      boxSize="9"
      fit="cover"
      flexShrink={0}
      loading="lazy"
      rounded="md"
      src={absolutizeApiUrl(`/api/v1/images/i/${imageName}/thumbnail`)}
    />
  ) : (
    <Flex
      align="center"
      bg="bg.emphasized"
      borderColor="border.subtle"
      borderWidth="1px"
      boxSize="9"
      color="fg.subtle"
      flexShrink={0}
      justify="center"
      rounded="md"
    >
      <Icon as={FolderIcon} boxSize="4" />
    </Flex>
  );

const Figure = ({ label, value }: { label: string; value: number }) => (
  <Stack align="flex-end" flexShrink={0} gap="0" minW="3.25rem">
    <Text
      color={value === 0 ? 'fg.muted' : 'fg'}
      fontSize="xs"
      fontVariantNumeric="tabular-nums"
      fontWeight="600"
      lineHeight="shorter"
    >
      {formatCount(value)}
    </Text>
    <Text color="fg.muted" fontSize="2xs" lineHeight="shorter">
      {label}
    </Text>
  </Stack>
);

const describeRow = (row: IntermediatesRow, showOwner: boolean, t: TFunction): string => {
  const size = t('intermediates.list.rowSummary', {
    size: formatBytes(row.reclaimableBytes),
    unmeasured: row.unknownSizeCount > 0 ? t('intermediates.list.unmeasured', { count: row.unknownSizeCount }) : '',
  }).trim();

  return showOwner ? t('intermediates.list.ownerAndSize', { owner: getOwnerLabel(row, t), size }) : size;
};

export interface IntermediatesListProps {
  /** The previous page stays visible while the next loads; it is shown, not selectable. */
  isBusy: boolean;
  rows: readonly IntermediatesRow[];
  showOwner: boolean;
  isSelected: (row: IntermediatesRow) => boolean;
  onToggleRow: (row: IntermediatesRow) => void;
}

/** One row per project, as the sketch: checkbox, cover, name over owner, then the used and unused counts. */
export const IntermediatesList = ({ isBusy, isSelected, onToggleRow, rows, showOwner }: IntermediatesListProps) => {
  const { t } = useTranslation();
  const unassigned = t('intermediates.list.unassigned');

  return (
    <Stack
      as="ul"
      aria-busy={isBusy || undefined}
      aria-label={t('intermediates.title')}
      gap="0.5"
      listStyleType="none"
      m="0"
      p="0"
      role="list"
    >
      {rows.map((row) => {
        const label = getRowLabel(row, unassigned);
        const selected = isSelected(row);
        const used = getKindInUse(row.images) + getKindInUse(row.videos);
        const unused = row.images.safe + row.videos.safe;

        return (
          <Row
            as="li"
            active={selected ? 'selected' : 'none'}
            cursor={isBusy ? 'progress' : 'pointer'}
            data-selected={selected || undefined}
            gap="2.5"
            key={getIntermediatesRowKey(row)}
            minW="0"
            px="2"
            py="1.5"
            rounded="md"
            onClick={isBusy ? undefined : () => onToggleRow(row)}
          >
            <Checkbox.Root
              aria-label={
                showOwner
                  ? t('intermediates.list.selectRowForOwner', { name: label, owner: getOwnerAccessibleLabel(row, t) })
                  : t('intermediates.list.selectRow', { name: label })
              }
              checked={selected}
              colorPalette="accent"
              disabled={isBusy}
              size="xs"
              onCheckedChange={() => onToggleRow(row)}
              onClick={(event) => event.stopPropagation()}
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
            </Checkbox.Root>
            <Cover imageName={row.coverImageName} />
            <Stack flex="1" gap="0.5" minW="0">
              <HStack gap="1.5" minW="0">
                <Text fontSize="xs" fontWeight="600" truncate>
                  {label}
                </Text>
                {row.projectId === null ? (
                  <Badge flexShrink={0} fontSize="2xs" variant="surface">
                    {t('intermediates.list.unassignedBadge')}
                  </Badge>
                ) : null}
              </HStack>
              <Text color="fg.muted" fontSize="2xs" truncate>
                {describeRow(row, showOwner, t)}
              </Text>
            </Stack>
            <HStack flexShrink={0} gap="4" pe="1">
              <Figure label={t('intermediates.list.used')} value={used} />
              <Figure label={t('intermediates.list.unused')} value={unused} />
            </HStack>
          </Row>
        );
      })}
    </Stack>
  );
};
