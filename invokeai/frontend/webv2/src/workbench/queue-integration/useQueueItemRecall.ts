import type { QueueGenerationMeta } from '@features/queue/contracts';
import type { ImageRecallCapabilities, ImageRecallKind } from '@workbench/image-actions';

import { createGenerateFormValuesSelector } from '@features/generation/react';
import { isSupportedGenerateModel } from '@features/generation/settings';
import { ensureModelsLoaded, useModelsSelector } from '@features/models';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  EMPTY_IMAGE_RECALL_CAPABILITIES,
  getCurrentGenerateValues,
  getImageRecallTitle,
} from '@workbench/image-actions';
import { useNotify } from '@workbench/useNotify';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { useWidgetValuesSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getQueueRecallCapabilities, getVideoQueueRecallCapabilities, planQueueRecall } from './queueRecall';
import { useLocalRecallSnapshot } from './useLocalRecallSnapshot';

const selectGenerateRecallValues = createGenerateFormValuesSelector();

/**
 * Recall for a queue item by origin, shared by every surface that offers it
 * (the Recent details panel, staged canvas results). Items this client
 * submitted recall from the exact submission snapshot; foreign items still
 * offer prompts + the executed seed from `meta`. Recalls write to the ACTIVE
 * project — "recall" means "load this into the panel I am looking at" — and
 * reveal the panel they wrote to.
 */
export const useQueueItemRecall = (
  origin: string | null | undefined,
  meta: QueueGenerationMeta
): { capabilities: ImageRecallCapabilities; isPending: boolean; recall: (kind: ImageRecallKind) => void } => {
  const { t } = useTranslation();
  const { generation, widgets } = useWorkbenchCommands();
  const openWidget = useOpenWorkbenchWidget();
  const notify = useNotify();
  const snapshot = useLocalRecallSnapshot(origin);
  const isPending = snapshot === undefined;
  const localGenerateValues = snapshot?.generateValues ?? null;
  const videoSnapshot = snapshot?.videoValues ?? null;
  const isVideoItem = snapshot?.sourceId === 'video';
  const generateValues = useWidgetValuesSelector('generate', selectGenerateRecallValues);
  const models = useModelsSelector((state) => state.models);
  const supportedModels = useMemo(() => models.filter(isSupportedGenerateModel), [models]);
  const capabilities = useMemo(
    () =>
      isPending
        ? EMPTY_IMAGE_RECALL_CAPABILITIES
        : isVideoItem
          ? getVideoQueueRecallCapabilities(videoSnapshot, meta)
          : getQueueRecallCapabilities(localGenerateValues, meta),
    [isPending, isVideoItem, localGenerateValues, meta, videoSnapshot]
  );

  useMountEffect(() => {
    void ensureModelsLoaded();
  });

  const recall = useCallback(
    (kind: ImageRecallKind) => {
      if (isPending) {
        return;
      }
      const current = getCurrentGenerateValues({ generateValues, supportedModels });
      const plan = planQueueRecall(kind, { current, isVideoItem, meta, snapshot: localGenerateValues, videoSnapshot });

      if (!plan) {
        notify.info(
          getImageRecallTitle(kind),
          // The Generate copy names a missing Generate model, which is not why
          // a video recall would come back empty.
          t(isVideoItem ? 'widgets.queue.recallUnavailableForItem' : 'widgets.queue.recallUnavailable')
        );
        return;
      }

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
      isPending,
      isVideoItem,
      localGenerateValues,
      meta,
      notify,
      openWidget,
      supportedModels,
      t,
      videoSnapshot,
      widgets,
    ]
  );

  return { capabilities, isPending, recall };
};
