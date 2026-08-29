import type { QueueItemReadModel } from '@features/queue/contracts';

import { Dialog, Icon, Portal } from '@chakra-ui/react';
import { createGenerateFormValuesSelector } from '@features/generation/react';
import { isSupportedGenerateModel } from '@features/generation/settings';
import { ensureModelsLoaded, useModelsSelector } from '@features/models';
import { extractGenerationMeta } from '@features/queue/contracts';
import { useMountEffect } from '@platform/react/useMountEffect';
import { Button, CloseButton } from '@platform/ui/Button';
import { JsonPreview } from '@platform/ui/JsonPreview';
import {
  getCurrentGenerateValues,
  getImageRecallTitle,
  RecallActionButtons,
  type ImageRecallKind,
} from '@workbench/image-actions';
import { useNotify } from '@workbench/useNotify';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { useWidgetValuesSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { FileTextIcon, WandSparklesIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getQueueRecallCapabilities, planQueueRecall } from './queueRecall';
import { useLocalGenerateValues, useLocalQueueItemSource } from './useLocalGenerateValues';

const selectGenerateRecallValues = createGenerateFormValuesSelector();

/**
 * Per-item actions for the RECENT details panel. Recall uses the shared
 * {@link RecallActionButtons} verbs (same look as the preview's metadata
 * panel): items this client submitted recall from the exact submission
 * snapshot; foreign items still offer prompts + the executed seed from the
 * session. "View JSON" opens the raw queue item in a dialog.
 */
export const QueueItemActions = ({ item }: { item: QueueItemReadModel }) => {
  const { t } = useTranslation();
  const { generation, widgets } = useWorkbenchCommands();
  const openWidget = useOpenWorkbenchWidget();
  const notify = useNotify();
  const localGenerateValues = useLocalGenerateValues(item.origin);
  // A video item's prompt belongs to the Video panel, which owns its own prompt
  // values. Only knowable for items this client submitted; see the hook's note.
  const isVideoItem = useLocalQueueItemSource(item.origin) === 'video';
  const [jsonOpen, setJsonOpen] = useState(false);
  const generateValues = useWidgetValuesSelector('generate', selectGenerateRecallValues);
  const models = useModelsSelector((snapshot) => snapshot.models);
  const supportedModels = useMemo(() => models.filter(isSupportedGenerateModel), [models]);
  const meta = useMemo(() => extractGenerationMeta(item), [item]);
  const capabilities = useMemo(
    () => getQueueRecallCapabilities(localGenerateValues, meta),
    [localGenerateValues, meta]
  );

  useMountEffect(() => {
    void ensureModelsLoaded();
  });

  const onRecall = useCallback(
    (kind: ImageRecallKind) => {
      const current = getCurrentGenerateValues({ generateValues, supportedModels });
      const plan = planQueueRecall(kind, { current, isVideoItem, meta, snapshot: localGenerateValues });

      if (!plan) {
        notify.info(
          getImageRecallTitle(kind),
          // The Generate copy names a missing Generate model, which is not why
          // a video recall would come back empty.
          t(isVideoItem ? 'widgets.queue.recallUnavailableForItem' : 'widgets.queue.recallUnavailable')
        );
        return;
      }

      // Both branches write to the ACTIVE project, not the project that owns the
      // item: with the default `all` queue scope Recent lists other projects'
      // items too, and "recall" means "load this into the panel I am looking at".
      // `openWidget` follows the same rule, so the write and the reveal agree.
      if (plan.target === 'video') {
        widgets.patchValues('video', plan.patch);
        openWidget('video', { preferredRegions: ['left'] });
        notify.success(getImageRecallTitle(kind), t('widgets.queue.settingsRecalledIntoVideoDescription'));
        return;
      }

      generation.setSettings(plan.values);
      openWidget('generate', { preferredRegions: ['left'] });
      notify.success(getImageRecallTitle(kind), t('widgets.queue.settingsRecalledDescription'));
    },
    [
      generateValues,
      generation,
      isVideoItem,
      localGenerateValues,
      meta,
      notify,
      openWidget,
      supportedModels,
      t,
      widgets,
    ]
  );

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

      <Dialog.Root open={jsonOpen} placement="center" scrollBehavior="inside" size="lg" onOpenChange={closeJson}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content bg="bg.subtle" borderColor="border.subtle" borderWidth="1px" color="fg">
              <Dialog.Header>
                <Dialog.Title>{t('widgets.queue.itemTitle', { id: item.id })}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <JsonPreview label={t('widgets.queue.itemJsonLabel', { id: item.id })} maxH="60vh" value={item} />
              </Dialog.Body>
              <Dialog.CloseTrigger asChild>
                <CloseButton color="fg.muted" size="sm" />
              </Dialog.CloseTrigger>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
};
