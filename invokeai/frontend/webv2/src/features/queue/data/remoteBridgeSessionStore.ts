import type { QueueActiveSession } from '@features/queue/core/activeSessions';
import type { QueueItem } from '@features/queue/core/historyTypes';
import type { InvocationProgressEvent } from '@features/queue/data/events';

import { getQueueItemSnapshotDimensions } from '@features/queue/core/historySnapshot';
import {
  getRemoteProgressTarget,
  getRemoteSyntheticBackendItemId,
  parseRemoteProgressMessage,
} from '@features/queue/core/remoteProgress';
import { getQueueItemProgressTargetId } from '@features/queue/core/types';
import { parseQueueItemOriginProjectId } from '@features/queue/data/events';
import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

import { subscribeRecoveredRemoteBridges } from './remoteBridgeRecovery';

type LiveBridge = { event: InvocationProgressEvent; seenAt: number };
const store = createExternalStore<{ bridges: readonly LiveBridge[] }>({ bridges: [] });
const terminal = new Set<string>();
const MAX_TERMINAL_KEYS = 256;

const bridgeKey = (event: InvocationProgressEvent): string | null => {
  const remote = typeof event.message === 'string' ? parseRemoteProgressMessage(event.message) : null;
  if (!remote) {
    return null;
  }
  const target = getRemoteProgressTarget(remote.queueItemId, remote.slot, remote.backendItemId);
  return getQueueItemProgressTargetId(target);
};

/** Preserve backend-authenticated bridge metadata until the Workbench project hydrates. */
export const noteLiveRemoteBridge = (event: InvocationProgressEvent): void => {
  const key = bridgeKey(event);
  if (!key) {
    return;
  }
  const remote = parseRemoteProgressMessage(event.message)!;
  const current = store.getSnapshot().bridges;
  const old = current.find(({ event: prior }) => bridgeKey(prior) === key);
  const normalized = {
    ...event,
    destination: event.destination ?? old?.event.destination ?? null,
    origin: event.origin ?? old?.event.origin ?? null,
  };
  if (remote.state !== 'running') {
    terminal.add(key);
    if (terminal.size > MAX_TERMINAL_KEYS) {
      terminal.delete(terminal.values().next().value!);
    }
    if (old) {
      store.patchSnapshot({ bridges: current.filter(({ event: prior }) => bridgeKey(prior) !== key) });
    }
    return;
  }
  if (terminal.has(key)) {
    return;
  }
  // Frame images are stored by the coordinator. This model only needs identity,
  // ownership, destination and queued/rendering transitions, not every frame.
  const activity = remote.message === `Remote ${remote.slot} queued`;
  const oldRemote = old && parseRemoteProgressMessage(old.event.message);
  if (
    old &&
    old.event.origin === normalized.origin &&
    old.event.destination === normalized.destination &&
    (oldRemote?.message === `Remote ${remote.slot} queued`) === activity
  ) {
    return;
  }
  store.patchSnapshot({
    bridges: [
      ...current.filter(({ event: prior }) => bridgeKey(prior) !== key),
      { event: { ...normalized, image: null }, seenAt: Date.now() },
    ],
  });
};

subscribeRecoveredRemoteBridges(({ events, requestedAt }) => {
  const incoming = new Set<string>();
  for (const event of events) {
    const key = bridgeKey(event);
    if (!key) {
      continue;
    }
    incoming.add(key);
    if (terminal.has(key)) {
      continue;
    }
    const previous = store.getSnapshot().bridges.find(({ event: prior }) => bridgeKey(prior) === key);
    if (!previous || previous.seenAt <= requestedAt) {
      noteLiveRemoteBridge(event);
    }
  }
  // Do not retain a bridge absent from a newer complete snapshot. A live event
  // received after the request started wins over that snapshot.
  const latest = store.getSnapshot().bridges;
  const survivors = latest.filter(({ event, seenAt }) => incoming.has(bridgeKey(event) ?? '') || seenAt > requestedAt);
  if (survivors.length !== latest.length) {
    store.patchSnapshot({ bridges: survivors });
  }
});

registerAccountOwnedResource({
  name: 'queue-recovered-remote-bridges',
  clear: () => {
    terminal.clear();
    store.patchSnapshot({ bridges: [] });
  },
});

export const useRemoteBridgeSessions = (): readonly InvocationProgressEvent[] =>
  store.useSelector((snapshot) => snapshot.bridges.map(({ event }) => event));

/** Reconstruct display-only sessions without requiring a still-running local item.
 * An absent parent is allowed ONLY with a project-scoped backend origin and
 * explicit destination. Neither backend queue state nor project history changes.
 */
export const getRecoveredRemoteSessions = (
  items: readonly QueueItem[],
  projectId: string,
  events: readonly InvocationProgressEvent[],
  destination: 'gallery' | 'all' = 'gallery'
): QueueActiveSession[] => {
  const byId = new Map(items.map((item) => [item.id, item]));
  const sessions: QueueActiveSession[] = [];
  for (const event of events) {
    const remote = typeof event.message === 'string' ? parseRemoteProgressMessage(event.message) : null;
    if (!remote || remote.state !== 'running') {
      continue;
    }
    const source = byId.get(remote.queueItemId);
    const originProjectId = parseQueueItemOriginProjectId(event.origin);
    if (originProjectId !== null && originProjectId !== projectId) {
      continue;
    }
    if (source) {
      if (destination === 'gallery' && source.snapshot.destination !== 'gallery') {
        continue;
      }
    } else if (
      originProjectId !== projectId ||
      (event.destination !== 'gallery' && event.destination !== 'canvas') ||
      (destination === 'gallery' && event.destination !== 'gallery')
    ) {
      continue;
    }
    const target = getRemoteProgressTarget(remote.queueItemId, remote.slot, remote.backendItemId);
    sessions.push({
      ...target,
      ...(source
        ? getQueueItemSnapshotDimensions(source, { width: 1024, height: 1024 })
        : { width: 1024, height: 1024 }),
      id: getQueueItemProgressTargetId(target),
      backendItemId: getRemoteSyntheticBackendItemId(remote.queueItemId, remote.slot, remote.backendItemId),
      itemCount: 1,
      label: `Remote ${remote.slot}`,
      sourceId: source?.snapshot.sourceId ?? 'generate',
      state: 'running',
    });
  }
  return sessions;
};
