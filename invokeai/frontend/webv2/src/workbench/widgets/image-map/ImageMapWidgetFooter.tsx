import type { WidgetViewProps } from '@workbench/widgetContracts';

import { HStack, Icon, Text } from '@chakra-ui/react';
import { IconButton, Tooltip } from '@platform/ui';
import { imageMapStore, refreshImageIndexStatus, refreshImageMapPoints } from '@workbench/image-map/imageMapStore';
import { isIndexing } from '@workbench/image-map/indexProgress';
import { RefreshCwIcon } from 'lucide-react';

import { ImageIndexProgressInline } from './ImageIndexProgress';

const handleRefresh = () => {
  void refreshImageMapPoints();
  // Refresh counts too, recovering final status events missed while offline.
  refreshImageIndexStatus();
};

export const ImageMapWidgetFooter = (_props: WidgetViewProps) => {
  const { data, indexCounts, indexUpdatedAt, loadState } = imageMapStore.useSnapshot();

  // Show footer controls only with a rendered map; other data states own their explanations and retry controls.
  if (loadState === 'idle' || !data || data.state !== 'ready') {
    return null;
  }

  const indexing = isIndexing(indexCounts);
  // Explain failed images when indexing drains below total.
  const skipped = indexCounts && indexCounts.pending === 0 && indexCounts.failed > 0;

  return (
    <HStack borderTopWidth="1px" color="fg.muted" fontSize="2xs" gap="2" justify="space-between" px="3" py="1" w="full">
      <HStack gap="2" minW="0">
        <Text whiteSpace="nowrap">{data.pointCount} points</Text>
        {data.stale ? <Text whiteSpace="nowrap">· updating…</Text> : null}
        {indexing ? (
          <>
            <Text>·</Text>
            <ImageIndexProgressInline counts={indexCounts} updatedAt={indexUpdatedAt} />
          </>
        ) : null}
        {skipped ? (
          <Tooltip content="These items repeatedly failed to embed and were given up on.">
            <Text truncate>· {indexCounts.failed} skipped</Text>
          </Tooltip>
        ) : null}
      </HStack>
      <Tooltip content="Refresh map">
        <IconButton aria-label="Refresh map" color="fg.muted" size="2xs" variant="ghost" onClick={handleRefresh}>
          <Icon as={RefreshCwIcon} boxSize="3" />
        </IconButton>
      </Tooltip>
    </HStack>
  );
};
