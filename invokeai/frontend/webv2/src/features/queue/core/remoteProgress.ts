import type { QueueItemProgressTarget } from './types';

const REMOTE_PROGRESS_PREFIX = '[[IRW_REMOTE|';
const REMOTE_QUEUE_ITEM_MARKER = '::irw-remote:';

export type RemoteProgressState = 'running' | 'completed' | 'failed';

export interface RemoteProgressEnvelope {
  queueItemId: string;
  slot: number;
  /** Parent InvokeAI backend item: distinguishes iterations on the same R1/R2. */
  backendItemId?: number;
  state: RemoteProgressState;
  message: string;
  /** Returned Canvas candidate names, never passwords or remote tokens. */
  imageNames?: string[];
}

interface RemoteProgressIdentity {
  localQueueItemId: string;
  slot: number;
  backendItemId?: number;
}

export const parseRemoteProgressMessage = (message: string): RemoteProgressEnvelope | null => {
  if (!message.startsWith(REMOTE_PROGRESS_PREFIX)) {
    return null;
  }
  const match = /^\[\[IRW_REMOTE\|([^|]+)\|(\d+)\|(running|completed|failed)(?:\|(\d+))?\]\]\s?(.*)$/s.exec(message);
  if (!match) {
    return null;
  }
  const slot = Number(match[2]);
  if (!Number.isInteger(slot) || slot < 1) {
    return null;
  }
  const backendItemId = match[4] === undefined ? undefined : Number(match[4]);
  if (backendItemId !== undefined && (!Number.isSafeInteger(backendItemId) || backendItemId < 1)) {
    return null;
  }
  const rawMessage = match[5] ?? '';
  const trailer = / \[\[IRW_CANVAS_IMAGES\|(\[[^\r\n]*\])\]\]$/.exec(rawMessage);
  let imageNames: string[] | undefined;
  if (trailer) {
    try {
      const parsed: unknown = JSON.parse(trailer[1]!);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.length <= 128 &&
        parsed.every((name) => typeof name === 'string' && name.length > 0 && name.length <= 255)
      ) {
        imageNames = parsed as string[];
      }
    } catch {
      // Malformed completion metadata is not a remote image result.
    }
  }
  return {
    queueItemId: match[1]!,
    slot,
    ...(backendItemId === undefined ? {} : { backendItemId }),
    state: match[3] as RemoteProgressState,
    message: trailer ? rawMessage.slice(0, trailer.index) : rawMessage,
    ...(imageNames ? { imageNames } : {}),
  };
};

/**
 * Remote previews must not share the local queue-item identity. The native preview
 * system keys several bits of transient/held state by queueItemId, so sharing that
 * id can make local and remote frames occupy the same media session. Give every
 * remote worker a synthetic queue item id and a normal 1-based slot instead.
 */
export const getRemoteProgressTarget = (
  localQueueItemId: string,
  slot: number,
  backendItemId?: number
): QueueItemProgressTarget => ({
  queueItemId: `${localQueueItemId}${REMOTE_QUEUE_ITEM_MARKER}${slot}${backendItemId ? `:${backendItemId}` : ''}`,
  itemIndex: 1,
});

export const getRemoteProgressIdentity = (
  target: Pick<QueueItemProgressTarget, 'queueItemId'>
): RemoteProgressIdentity | null => {
  const markerIndex = target.queueItemId.lastIndexOf(REMOTE_QUEUE_ITEM_MARKER);
  if (markerIndex <= 0) {
    return null;
  }
  const localQueueItemId = target.queueItemId.slice(0, markerIndex);
  const slotText = target.queueItemId.slice(markerIndex + REMOTE_QUEUE_ITEM_MARKER.length);
  const match = /^(\d+)(?::(\d+))?$/.exec(slotText);
  if (!match || !localQueueItemId) {
    return null;
  }
  const slot = Number(match[1]);
  const backendItemId = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(slot) ||
    slot < 1 ||
    (backendItemId !== undefined && (!Number.isSafeInteger(backendItemId) || backendItemId < 1))
  ) {
    return null;
  }
  return { localQueueItemId, slot, ...(backendItemId === undefined ? {} : { backendItemId }) };
};

export const getRemoteProgressSlot = (target: Pick<QueueItemProgressTarget, 'queueItemId'>): number | null =>
  getRemoteProgressIdentity(target)?.slot ?? null;

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** Stable UI-only IDs; no API request uses these. The indexed form is reversible
 * so Canvas can order completed results by their ORIGINAL batch iteration. */
const INDEXED_REMOTE_ID_BASE = 1_000_000_000_000;
const INDEXED_REMOTE_ID_STRIDE = 1024;
export const getRemoteSyntheticBackendItemId = (queueItemId: string, slot: number, backendItemId?: number): number => {
  if (backendItemId !== undefined) {
    const id = INDEXED_REMOTE_ID_BASE + backendItemId * INDEXED_REMOTE_ID_STRIDE + slot;
    if (Number.isSafeInteger(id) && slot > 0 && slot < INDEXED_REMOTE_ID_STRIDE) {
      return id;
    }
  }
  return 2_000_000_000 + (hashString(queueItemId) % 1_000_000) * 1000 + Math.min(Math.max(slot, 1), 999);
};

/** Old unindexed IDs return null; caller retains legacy display order. */
export const getRemoteParentBackendItemId = (syntheticId: number): number | null => {
  if (!Number.isSafeInteger(syntheticId) || syntheticId < INDEXED_REMOTE_ID_BASE + INDEXED_REMOTE_ID_STRIDE) {
    return null;
  }
  const parent = Math.floor((syntheticId - INDEXED_REMOTE_ID_BASE) / INDEXED_REMOTE_ID_STRIDE);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
};
