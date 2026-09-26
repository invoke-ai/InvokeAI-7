import { assertAccountScopeCurrent, captureAccountScope } from '@platform/state/accountLifecycle';

import type { QueueFeatureCommands, QueueQueryScope, QueueReadModel, QueueWorkflowRunSink } from './core/types';
import type { QueueItemProgressPort, QueueRealtimeRuntime } from './data/realtimeRuntime';
import type {
  QueueHistoryPort,
  QueueResultDestinationPort,
  QueueRunJournalPort,
  QueueRunLockPort,
  QueueRuntime,
} from './runtime';
import type { QueueModelLoadPort, QueueNodeExecutionPort } from './runtime/coordinator';

import { queueBackend } from './data/httpRealtimeQueueBackend';
import { queueReadModelOptions } from './data/queries';
import { createQueueRealtimeRuntime } from './data/realtimeRuntime';
import { cancelWithRemoteWorkers } from './data/remoteQueueCancellation';
import { getCurrentQueueItem } from './data/serverApi';
import { createQueueRuntime } from './runtime';
import { createQueueReceiptAcknowledgements, type QueueReceiptStorePort } from './runtime/receiptAcknowledgements';

export const createProductionQueueReceiptAcknowledgements = (store: QueueReceiptStorePort, isActive: () => boolean) =>
  createQueueReceiptAcknowledgements({
    acknowledge: (projectId, queueItemId) => queueBackend.acknowledgeEnqueue!(projectId, queueItemId),
    isActive,
    store,
  });

export const queueCommands: QueueFeatureCommands = {
  cancelCurrentItem: async () => {
    const owner = captureAccountScope();
    const current = await getCurrentQueueItem({}, owner.signal);
    assertAccountScopeCurrent(owner);
    if (current) {
      await cancelWithRemoteWorkers(
        { item_id: current.item_id },
        () => queueBackend.cancelItem(current.item_id),
        owner
      );
    }
  },
  cancelItem: async (itemId) => {
    const owner = captureAccountScope();
    await cancelWithRemoteWorkers({ item_id: itemId }, () => queueBackend.cancelItem(itemId), owner);
  },
  cancelScopedItems: async (scope = {}, options = {}) => {
    const owner = captureAccountScope();
    await cancelWithRemoteWorkers(
      { origin_prefix: scope.originPrefix ?? null, keep_current: options.keepCurrent ?? false },
      () => queueBackend.cancelScopedItems(scope, options),
      owner
    );
  },
  clearFailedItems: queueBackend.clearFailedItems,
  clearItems: queueBackend.clearItems,
  pauseProcessor: async () => {
    await queueBackend.pauseProcessor();
  },
  resumeProcessor: async () => {
    await queueBackend.resumeProcessor();
  },
};

export const getQueueReadModelOptions = (scope: QueueQueryScope, onRead?: (model: QueueReadModel) => void) =>
  queueReadModelOptions(queueBackend, scope, onRead);

export const createProductionQueueRealtimeRuntime = ({
  coalesceMs,
  invalidate,
  progress,
  refreshModelCache,
}: {
  coalesceMs?: number;
  invalidate: () => void | Promise<void>;
  progress: QueueItemProgressPort;
  refreshModelCache: () => void | Promise<void>;
}): QueueRealtimeRuntime =>
  createQueueRealtimeRuntime({ backend: queueBackend, coalesceMs, invalidate, progress, refreshModelCache });

export const createProductionQueueRuntime = ({
  destinations,
  ensureProjectPersisted,
  ensureTemplatesLoaded,
  history,
  journal,
  locks,
  modelLoads,
  nodeExecution,
  workflowRuns,
}: {
  destinations: QueueResultDestinationPort;
  ensureProjectPersisted?(projectId: string): Promise<'ready' | 'refused' | 'retry'>;
  ensureTemplatesLoaded: () => void;
  history: QueueHistoryPort;
  journal?: QueueRunJournalPort;
  locks?: QueueRunLockPort;
  modelLoads: QueueModelLoadPort;
  nodeExecution: QueueNodeExecutionPort;
  workflowRuns?: QueueWorkflowRunSink;
}): QueueRuntime =>
  createQueueRuntime({
    backend: queueBackend,
    destinations,
    ensureProjectPersisted,
    ensureTemplatesLoaded,
    history,
    journal,
    locks,
    modelLoads,
    nodeExecution,
    workflowRuns,
  });
