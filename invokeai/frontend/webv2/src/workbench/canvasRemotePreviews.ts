/**
 * Transient, account-scoped Canvas-only mirror placeholders. This store carries
 * identity/lifecycle only; decoded images stay in the normal queue preview store.
 * A remote can outlive the local queue item, so local status alone cannot drive
 * Canvas's live staging placeholders.
 */
import type { InvocationProgressEvent, QueueItem, RemoteProgressEnvelope } from '@features/queue';

import { parseQueueItemOriginProjectId, parseRemoteProgressMessage } from '@features/queue';

export interface CanvasRemotePreview {
  queueItemId: string;
  slot: number;
  backendItemId?: number;
  state: 'running' | 'completed';
}

type Snapshot = Readonly<Record<string, CanvasRemotePreview>>;
const EMPTY_SNAPSHOT: Snapshot = Object.freeze({});
let snapshot: Snapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

export const subscribeCanvasRemotePreviews = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getCanvasRemotePreviewSnapshot = (): Snapshot => snapshot;
const publish = (next: Snapshot): void => {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
};
export const resetCanvasRemotePreviews = (): void => {
  if (Object.keys(snapshot).length > 0) {
    publish(EMPTY_SNAPSHOT);
  }
};

const keyFor = (queueItemId: string, slot: number, backendItemId?: number): string =>
  `${queueItemId}::${slot}::${backendItemId ?? 0}`;

export const recordCanvasRemotePreview = (remote: RemoteProgressEnvelope): void => {
  const key = keyFor(remote.queueItemId, remote.slot, remote.backendItemId);
  if (remote.state === 'failed') {
    forgetCanvasRemotePreview(remote.queueItemId, remote.slot, remote.backendItemId);
    return;
  }
  const previous = snapshot[key];
  if (previous?.state === remote.state) {
    return;
  }
  const next = {
    ...snapshot,
    [key]: {
      queueItemId: remote.queueItemId,
      slot: remote.slot,
      backendItemId: remote.backendItemId,
      state: remote.state,
    },
  };
  // Bound old completed entries across long-running sessions. Live image
  // bytes remain in the queue store, never in this registry.
  if (Object.keys(next).length > 256) {
    delete next[Object.keys(next)[0]!];
  }
  publish(next);
};

export const forgetCanvasRemotePreview = (queueItemId: string, slot: number, backendItemId?: number): void => {
  const key = keyFor(queueItemId, slot, backendItemId);
  if (!snapshot[key]) {
    return;
  }
  const next = { ...snapshot };
  delete next[key];
  publish(next);
};

/**
 * Bridge recovery can precede Workbench hydration. Recreate Canvas's display-only
 * slots from the retained snapshot when their original project item becomes available.
 * Never infer a Canvas placement from a missing parent or another project.
 */
export const getCanvasRemotePreviewsForDisplay = (
  live: Readonly<Record<string, CanvasRemotePreview>>,
  recovered: readonly InvocationProgressEvent[],
  items: readonly QueueItem[],
  projectId: string
): CanvasRemotePreview[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const merged = new Map(Object.entries(live));
  for (const event of recovered) {
    const remote = typeof event.message === 'string' ? parseRemoteProgressMessage(event.message) : null;
    if (!remote || remote.state !== 'running') {
      continue;
    }
    const item = byId.get(remote.queueItemId);
    if (
      !item ||
      item.snapshot.destination !== 'canvas' ||
      item.status === 'cancelled' ||
      item.status === 'failed' ||
      (event.destination !== null && event.destination !== undefined && event.destination !== 'canvas')
    ) {
      continue;
    }
    const originProjectId = parseQueueItemOriginProjectId(event.origin);
    if (originProjectId !== null && originProjectId !== projectId) {
      continue;
    }
    const key = keyFor(remote.queueItemId, remote.slot, remote.backendItemId);
    if (!merged.has(key)) {
      merged.set(key, {
        queueItemId: remote.queueItemId,
        slot: remote.slot,
        backendItemId: remote.backendItemId,
        state: 'running',
      });
    }
  }
  return [...merged.values()];
};
