import { getQueueItemProgressTargetId, type QueueItemProgressTarget } from '@features/queue/core/types';
import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/** Preview-only visibility. The shared active target and Gallery/Canvas slots
 * still include remotes waiting in their worker queues. */
const store = createExternalStore<{ ids: ReadonlySet<string> }>({ ids: new Set<string>() });

export const remotePreviewActivityStore = {
  set(target: QueueItemProgressTarget, generating: boolean): void {
    const id = getQueueItemProgressTargetId(target);
    const current = store.getSnapshot().ids;
    if (current.has(id) === generating) {
      return;
    }
    const next = new Set(current);
    if (generating) {
      next.add(id);
    } else {
      next.delete(id);
    }
    store.patchSnapshot({ ids: next });
  },
  clear(target: QueueItemProgressTarget): void {
    remotePreviewActivityStore.set(target, false);
  },
  clearAll(): void {
    if (store.getSnapshot().ids.size > 0) {
      store.patchSnapshot({ ids: new Set<string>() });
    }
  },
};

registerAccountOwnedResource({
  name: 'queue-remote-preview-activity',
  clear: remotePreviewActivityStore.clearAll,
});

/** Changes only on queued/started/finished transitions, not on every frame. */
export const useGeneratingRemotePreviewIds = (): ReadonlySet<string> => store.useSelector((snapshot) => snapshot.ids);
