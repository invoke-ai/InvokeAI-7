import type { RemoteQueueProgressItem, RemoteQueueProgressSlot } from '@features/queue/data/remoteWorkersDispatch';

import { HStack, Stack, Text } from '@chakra-ui/react';
import { useItemProgress } from '@features/queue/data/itemProgressStore';
import { getApiErrorMessage } from '@platform/transport/http';
import { IconButton } from '@platform/ui/Button';
import { XIcon } from 'lucide-react';
import { useCallback, useState } from 'react';

import { QueueItemThumbnail } from './QueueItemThumbnail';
import { QueueStepProgress } from './QueueStepProgress';
import { useQueueUi } from './QueueUiContext';
import { SectionHeader } from './SectionHeader';

/** Overlay for the active project, including remote work after its native queue item completes. */
export const QueueRemoteProgressSection = () => {
  const { remoteQueueProgressItems, cancelRemoteGeneration } = useQueueUi();
  const items = remoteQueueProgressItems ?? [];
  if (items.length === 0) {
    return null;
  }
  return (
    <Stack aria-label="Remote Workers" gap="2">
      <SectionHeader count={items.length} title="Remote Workers" />
      <Stack gap="2">
        {items.map((item) => (
          <RemoteGenerationRows key={item.queueItemId} item={item} onCancel={cancelRemoteGeneration} />
        ))}
      </Stack>
    </Stack>
  );
};

/** One cancel action per generation; it cancels all associated remotes, not an individual worker. */
const RemoteGenerationRows = ({
  item,
  onCancel,
}: {
  item: RemoteQueueProgressItem;
  onCancel?: (queueItemId: string) => Promise<void>;
}) => {
  const { notify } = useQueueUi();
  const [canceling, setCanceling] = useState(false);
  const cancel = useCallback(async () => {
    if (canceling || !onCancel) {
      return;
    }
    setCanceling(true);
    try {
      await onCancel(item.queueItemId);
    } catch (error: unknown) {
      notify.error('Could not cancel remote generation', getApiErrorMessage(error, 'Remote cancellation failed'));
    } finally {
      setCanceling(false);
    }
  }, [canceling, item.queueItemId, notify, onCancel]);

  return (
    <HStack align="start" gap="1" minW="0" px="1" py="1">
      <Stack flex="1" gap="2" minW="0">
        {item.slots.map((slot) => (
          <RemoteSlot key={slot.id} prompt={item.prompt} slot={slot} />
        ))}
      </Stack>
      {onCancel ? (
        <IconButton
          aria-label="Cancel remote generation (all workers)"
          title="Cancel all remote workers for this generation"
          loading={canceling}
          size="2xs"
          variant="ghost"
          onClick={cancel}
        >
          <XIcon size={14} />
        </IconButton>
      ) : null}
    </HStack>
  );
};

const RemoteSlot = ({ prompt, slot }: { prompt: string; slot: RemoteQueueProgressSlot }) => {
  // The same synthetic backend item ID feeds Gallery and Canvas previews.
  // Subscribe directly: do not start another network stream or copy large data URLs.
  const progress = useItemProgress(slot.backendItemId);
  const queued = slot.state === 'queued' || (progress?.message === `Remote ${slot.slot} queued` && !progress.image);
  const worker = slot.total > 1 ? `R${slot.slot} · ${slot.iteration}/${slot.total}` : `R${slot.slot}`;
  return (
    <Stack gap="1.5" minW="0">
      <HStack gap="2.5" minW="0">
        <QueueItemThumbnail boxSize="8" imageName={null} liveImage={progress?.image} />
        <Stack flex="1" gap="0.5" minW="0">
          <Text fontSize="xs" truncate>
            {prompt}
          </Text>
          <Text color="fg.muted" fontSize="2xs" fontVariantNumeric="tabular-nums" truncate>
            {worker} · {queued ? 'Queued' : 'Generating'}
          </Text>
        </Stack>
      </HStack>
      {!queued ? (
        <QueueStepProgress message={progress?.message || 'Preparing'} percentage={progress?.percentage ?? null} />
      ) : null}
    </Stack>
  );
};
