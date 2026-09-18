import type { QueueItemProgressTarget } from './types';

const REMOTE_PROGRESS_PREFIX = '[[IRW_REMOTE|';
const REMOTE_QUEUE_ITEM_MARKER = '::irw-remote:';

export type RemoteProgressState = 'running' | 'completed' | 'failed';

export interface RemoteProgressEnvelope {
  queueItemId: string;
  slot: number;
  state: RemoteProgressState;
  message: string;
}

export interface RemoteProgressIdentity {
  localQueueItemId: string;
  slot: number;
}

export const parseRemoteProgressMessage = (message: string): RemoteProgressEnvelope | null => {
  if (!message.startsWith(REMOTE_PROGRESS_PREFIX)) {
    return null;
  }
  const match = /^\[\[IRW_REMOTE\|([^|]+)\|(\d+)\|(running|completed|failed)\]\]\s?(.*)$/s.exec(message);
  if (!match) {
    return null;
  }
  const slot = Number(match[2]);
  if (!Number.isInteger(slot) || slot < 1) {
    return null;
  }
  return {
    queueItemId: match[1]!,
    slot,
    state: match[3] as RemoteProgressState,
    message: match[4] ?? '',
  };
};

/**
 * Remote previews must not share the local queue-item identity. The native preview
 * system keys several bits of transient/held state by queueItemId, so sharing that
 * id can make local and remote frames occupy the same media session. Give every
 * remote worker a synthetic queue item id and a normal 1-based slot instead.
 */
export const getRemoteProgressTarget = (localQueueItemId: string, slot: number): QueueItemProgressTarget => ({
  queueItemId: `${localQueueItemId}${REMOTE_QUEUE_ITEM_MARKER}${slot}`,
  itemIndex: 1,
});

export const getRemoteProgressIdentity = (target: QueueItemProgressTarget): RemoteProgressIdentity | null => {
  const markerIndex = target.queueItemId.lastIndexOf(REMOTE_QUEUE_ITEM_MARKER);
  if (markerIndex <= 0) {
    return null;
  }
  const localQueueItemId = target.queueItemId.slice(0, markerIndex);
  const slotText = target.queueItemId.slice(markerIndex + REMOTE_QUEUE_ITEM_MARKER.length);
  const slot = Number(slotText);
  if (!localQueueItemId || !Number.isInteger(slot) || slot < 1) {
    return null;
  }
  return { localQueueItemId, slot };
};

export const getRemoteProgressSlot = (target: QueueItemProgressTarget): number | null =>
  getRemoteProgressIdentity(target)?.slot ?? null;

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** A stable UI-only backend item id. It never gets sent to InvokeAI's queue API. */
export const getRemoteSyntheticBackendItemId = (queueItemId: string, slot: number): number =>
  2_000_000_000 + (hashString(queueItemId) % 1_000_000) * 1000 + Math.min(Math.max(slot, 1), 999);
