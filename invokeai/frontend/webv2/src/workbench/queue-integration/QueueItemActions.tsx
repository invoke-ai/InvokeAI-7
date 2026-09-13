import type { QueueItemReadModel } from '@features/queue/contracts';

import { Dialog, Icon, Portal } from '@chakra-ui/react';
import { extractGenerationMeta } from '@features/queue/contracts';
import { Button, CloseButton } from '@platform/ui/Button';
import { JsonPreview } from '@platform/ui/JsonPreview';
import { RecallActionButtons } from '@workbench/image-actions';
import { useNotify } from '@workbench/useNotify';
import { FileTextIcon, WandSparklesIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useQueueItemRecall } from './useQueueItemRecall';

/**
 * Per-item actions for the RECENT details panel. Recall uses the shared
 * {@link RecallActionButtons} verbs (same look as the preview's metadata
 * panel) over {@link useQueueItemRecall}. "View JSON" opens the raw queue
 * item in a dialog.
 */
export const QueueItemActions = ({ item }: { item: QueueItemReadModel }) => {
  const { t } = useTranslation();
  const notify = useNotify();
  const [jsonOpen, setJsonOpen] = useState(false);
  const meta = useMemo(() => extractGenerationMeta(item), [item]);
  const { capabilities, recall: onRecall } = useQueueItemRecall(item.origin, meta);

  const onSendToCanvas = useCallback(
    () => notify.info(t('widgets.queue.sendToCanvas'), t('widgets.queue.sendToCanvasComingSoon')),
    [notify, t]
  );

  const openJson = useCallback(() => setJsonOpen(true), []);
  const closeJson = useCallback(() => setJsonOpen(false), []);

  return (
    <>
      <RecallActionButtons
        capabilities={capabilities}
        disabledReason={t('widgets.queue.recallFromGallery')}
        onRecall={onRecall}
      >
        <Button disabled variant="ghost" onClick={onSendToCanvas}>
          <Icon as={WandSparklesIcon} boxSize="3" />
          {t('widgets.queue.sendToCanvas')}
        </Button>
        <Button onClick={openJson}>
          <Icon as={FileTextIcon} boxSize="3" />
          {t('common.viewJson')}
        </Button>
      </RecallActionButtons>

      <Dialog.Root open={jsonOpen} scrollBehavior="inside" size="lg" onOpenChange={closeJson}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content>
              <Dialog.Header>
                <Dialog.Title>{t('widgets.queue.itemTitle', { id: item.id })}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <JsonPreview label={t('widgets.queue.itemJsonLabel', { id: item.id })} maxH="60vh" value={item} />
              </Dialog.Body>
              <Dialog.CloseTrigger asChild>
                <CloseButton />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};
