/**
 * Transient, account-scoped Canvas-only mirror placeholders. This store carries
 * identity/lifecycle only; decoded images stay in the normal queue preview store.
 * A remote can outlive the local queue item, so local status alone cannot drive
 * Canvas's live staging placeholders.
 */
import type { RemoteProgressEnvelope } from '@features/queue';

export interface CanvasRemotePreview {
  queueItemId: string;
  slot: number;
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

const keyFor = (queueItemId: string, slot: number): string => `${queueItemId}::${slot}`;

export const recordCanvasRemotePreview = (remote: RemoteProgressEnvelope): void => {
  const key = keyFor(remote.queueItemId, remote.slot);
  if (remote.state === 'failed') {
    forgetCanvasRemotePreview(remote.queueItemId, remote.slot);
    return;
  }
  const previous = snapshot[key];
  if (previous?.state === remote.state) {
    return;
  }
  const next = {
    ...snapshot,
    [key]: { queueItemId: remote.queueItemId, slot: remote.slot, state: remote.state },
  };
  // Bound old completed entries across long-running sessions. Live image
  // bytes remain in the queue store, never in this registry.
  if (Object.keys(next).length > 256) {
    delete next[Object.keys(next)[0]!];
  }
  publish(next);
};

export const forgetCanvasRemotePreview = (queueItemId: string, slot: number): void => {
  const key = keyFor(queueItemId, slot);
  if (!snapshot[key]) {
    return;
  }
  const next = { ...snapshot };
  delete next[key];
  publish(next);
};
