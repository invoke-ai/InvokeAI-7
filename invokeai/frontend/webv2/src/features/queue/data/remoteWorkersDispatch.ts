import type { QueueProgressSession } from '@features/queue/core/activeSessions';
import type { QueueItem } from '@features/queue/core/historyTypes';

import {
  getQueueItemSnapshotBatchCount,
  getQueueItemSnapshotDimensions,
  getQueueItemSnapshotPositivePrompt,
} from '@features/queue/core/historySnapshot';
import {
  getRemoteProgressIdentity,
  getRemoteProgressTarget,
  getRemoteSyntheticBackendItemId,
} from '@features/queue/core/remoteProgress';
import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';

import type { RemoteDispatchMode } from './remoteWorkersStore';

import { hasRemoteWorkerDispatchNode } from './remoteWorkersGraphContract';
import { getOnlineRemoteWorkerUrls } from './remoteWorkersHealth';
import { getRemoteWorkerUrls, getRemoteWorkersSettings, isRemoteWorkerEnabled } from './remoteWorkersStore';

export interface RemoteDispatchPlan {
  local: boolean;
  remoteUrls: string[];
  /** The configured 1-based slot; a single-target R3 still displays as R3. */
  remoteSlots: number[];
}

type Assignment = {
  localActive: boolean;
  remoteActive: Set<string>;
  createdAt: number;
  settledRemoteItems: Set<string>;
  settledRemoteCounts: Map<number, number>;
  expectedRemoteItems: number;
  plan: RemoteDispatchPlan;
};

const MAX_LEASE_AGE_MS = 4 * 60 * 60 * 1000;
const assignments = new Map<string, Assignment>();
let lastTargetId: string | null = null;

registerAccountOwnedResource({
  name: 'remote-workers-dispatch-assignments',
  clear: () => {
    assignments.clear();
    lastTargetId = null;
  },
});

const pruneExpired = (): void => {
  const now = Date.now();
  for (const [id, assignment] of assignments) {
    const isActive = assignment.localActive || assignment.remoteActive.size > 0;
    if (!isActive && now - assignment.createdAt > MAX_LEASE_AGE_MS) {
      assignments.delete(id);
    }
  }
};

/** Local jobs release when Queue has settled; remote jobs release on the bridge's terminal event. */
export const syncLocalDispatches = (activeQueueItemIds: ReadonlySet<string>): void => {
  pruneExpired();
  for (const [id, assignment] of assignments) {
    if (assignment.localActive && !activeQueueItemIds.has(id)) {
      assignment.localActive = false;
    }
    // Keep the immutable plan after the job settles: Gallery/Canvas may still
    // need the worker identity while importing late results. Expiry/account reset
    // bound memory; inactive leases do not count towards auto-balance.
  }
};

export const noteRemoteDispatchProgress = (
  queueItemId: string,
  slot: number,
  state: 'running' | 'completed' | 'failed',
  backendItemId?: number
): void => {
  if (state === 'running') {
    return;
  }
  const assignment = assignments.get(queueItemId);
  if (!assignment) {
    return;
  }
  const remoteIndex = assignment.plan.remoteSlots.indexOf(slot);
  const url = remoteIndex >= 0 ? assignment.plan.remoteUrls[remoteIndex] : undefined;
  if (!url) {
    return;
  }
  const key = `${slot}:${backendItemId ?? 0}`;
  if (!assignment.settledRemoteItems.has(key)) {
    assignment.settledRemoteItems.add(key);
    const completed = (assignment.settledRemoteCounts.get(slot) ?? 0) + 1;
    assignment.settledRemoteCounts.set(slot, completed);
    if (completed >= assignment.expectedRemoteItems) {
      assignment.remoteActive.delete(url);
    }
  }
  // Keep slot->URL for other iterations of the same Invoke. A worker can finish
  // image 1 long before image 2; deleting this on the first completion loses
  // all subsequent terminal events and leaves phantom progress placeholders.
};

const activeCount = (targetId: string): number => {
  let count = 0;
  for (const assignment of assignments.values()) {
    if (targetId === 'local' ? assignment.localActive : assignment.remoteActive.has(targetId)) {
      count += 1;
    }
  }
  return count;
};

/**
 * Selection is stable for a queue item, including retry/reconciliation. All modes
 * include the local machine where requested. Auto-balance uses outstanding work
 * dispatched in this browser account, not worker-reported global GPU occupancy.
 */
export const selectRemoteDispatch = (
  mode: RemoteDispatchMode,
  urls: readonly string[],
  queueItemId: string,
  onlineUrls: readonly string[] = urls
): RemoteDispatchPlan => {
  pruneExpired();
  const existing = assignments.get(queueItemId);
  if (existing) {
    return existing.plan;
  }
  // Enforce the toggle even for callers supplying an explicit online list.
  const eligibleUrls = onlineUrls.filter(isRemoteWorkerEnabled);
  const targetIds = ['local', ...eligibleUrls];
  let selected: string[];
  if (mode === 'mirror_all') {
    selected = targetIds;
  } else if (mode === 'remotes_only') {
    selected = [...eligibleUrls];
  } else {
    const previousIndex = lastTargetId === null ? -1 : targetIds.indexOf(lastTargetId);
    const start = previousIndex < 0 ? 0 : (previousIndex + 1) % targetIds.length;
    let chosen = targetIds[start]!;
    if (mode === 'auto_balance') {
      let least = Number.POSITIVE_INFINITY;
      for (let step = 0; step < targetIds.length; step += 1) {
        const targetId = targetIds[(start + step) % targetIds.length]!;
        const load = activeCount(targetId);
        if (load < least) {
          chosen = targetId;
          least = load;
        }
      }
    }
    lastTargetId = chosen;
    selected = [chosen];
  }
  const selectedUrls = urls.filter((url) => eligibleUrls.includes(url) && selected.includes(url));
  const plan: RemoteDispatchPlan = {
    local: selected.includes('local'),
    remoteUrls: selectedUrls,
    remoteSlots: selectedUrls.map((url) => urls.indexOf(url) + 1),
  };
  assignments.set(queueItemId, {
    createdAt: Date.now(),
    settledRemoteItems: new Set<string>(),
    settledRemoteCounts: new Map<number, number>(),
    expectedRemoteItems: 1,
    localActive: plan.local,
    plan,
    remoteActive: new Set(plan.remoteUrls),
  });
  return plan;
};

/** Replan only a not-yet-submitted item after a fresh availability check. */
export const resetUnsubmittedRemoteDispatchPlan = (queueItemId: string): void => {
  assignments.delete(queueItemId);
};

/** Read only: queued Gallery tiles may need their assigned R# before progress starts. */
export const getRemoteDispatchPlan = (queueItemId: string): RemoteDispatchPlan | null =>
  assignments.get(queueItemId)?.plan ?? null;

/** Only one selected remote can own a queued dispatcher tile unambiguously. */
export const getQueuedRemoteWorkerSlot = (queueItemId: string): number | null => {
  const plan = getRemoteDispatchPlan(queueItemId);
  return plan && !plan.local && plan.remoteSlots.length === 1 ? plan.remoteSlots[0]! : null;
};

/** Reserve all currently queued invokes in Invoke order, before async submit can race. */
export const reserveRemoteDispatchPlans = (items: readonly QueueItem[]): void => {
  const settings = getRemoteWorkersSettings();
  if (!settings.enabled) {
    return;
  }
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  if (urls.length === 0) {
    return;
  }
  const chronological = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = Date.parse(a.item.snapshot.submittedAt);
      const bt = Date.parse(b.item.snapshot.submittedAt);
      return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? at - bt : b.index - a.index;
    });
  for (const { item } of chronological) {
    if (
      assignments.has(item.id) ||
      // Do not retroactively assign a remote to a local run submitted before workers were enabled.
      // Pre-existing plans remain unchanged; only work not yet sent to the backend can be reserved.
      (item.backendItemIds?.length ?? 0) > 0 ||
      (item.status !== 'pending' && item.status !== 'running') ||
      (item.snapshot.destination !== 'canvas' && item.snapshot.destination !== 'gallery')
    ) {
      continue;
    }
    const submission = item.snapshot.backendSubmission;
    if (
      !submission ||
      submission.kind === 'invalid' ||
      !submission.graph ||
      hasRemoteWorkerDispatchNode(submission.graph)
    ) {
      continue;
    }
    selectRemoteDispatch(settings.dispatchMode, urls, item.id, getOnlineRemoteWorkerUrls(urls));
    const assignment = assignments.get(item.id);
    if (assignment) {
      assignment.expectedRemoteItems = getQueueItemSnapshotBatchCount(item);
    }
  }
};

/** The backend iteration's remote bridge reached a terminal state. */
export const isRemoteDispatchItemSettled = (queueItemId: string, slot: number, backendItemId?: number): boolean => {
  const settled = assignments.get(queueItemId)?.settledRemoteItems;
  return settled?.has(`${slot}:${backendItemId ?? 0}`) === true || settled?.has(`${slot}:0`) === true;
};

/** Expand Gallery's *display* model without modifying InvokeAI's actual backend queue. */
export const expandGalleryRemoteProgressSessions = (
  sessions: readonly QueueProgressSession[],
  queueItems: readonly QueueItem[],
  destination: 'gallery' | 'all' = 'gallery'
): QueueProgressSession[] => {
  if (!queueItems.some((item) => assignments.has(item.id))) {
    // Remote Workers disabled/no planned work: leave stock Gallery untouched.
    return sessions as QueueProgressSession[];
  }
  const byId = new Map(queueItems.map((item) => [item.id, item]));
  const expanded = sessions.filter((session) => {
    const remote = getRemoteProgressIdentity(session);
    if (remote) {
      return true;
    }
    const plan = getRemoteDispatchPlan(session.queueItemId);
    // A remote-only backend item executes only the kickoff helper, NOT a local image.
    return !plan || plan.local;
  });
  const existing = new Set(expanded.map((session) => session.id));
  for (const item of queueItems) {
    const plan = getRemoteDispatchPlan(item.id);
    if (
      !plan?.remoteSlots.length ||
      (item.status !== 'pending' && item.status !== 'running' && item.status !== 'completed')
    ) {
      continue;
    }
    if (destination === 'gallery' && item.snapshot.destination !== 'gallery') {
      continue;
    }
    const itemCount = item.backendItemIds?.length ?? getQueueItemSnapshotBatchCount(item);
    const dimensions = getQueueItemSnapshotDimensions(item, { width: 1024, height: 1024 });
    for (let index = 0; index < itemCount; index += 1) {
      const parentId = item.backendItemIds?.[index];
      for (const slot of plan.remoteSlots) {
        if (isRemoteDispatchItemSettled(item.id, slot, parentId)) {
          continue;
        }
        const target = getRemoteProgressTarget(item.id, slot, parentId);
        // An unsubmitted batch needs distinct placeholders for every iteration.
        const itemIndex = parentId === undefined ? index + 1 : target.itemIndex;
        const id = `${target.queueItemId}:${itemIndex}`;
        if (existing.has(id)) {
          continue;
        }
        existing.add(id);
        expanded.push({
          ...target,
          itemIndex,
          ...dimensions,
          id,
          backendItemId: parentId === undefined ? null : getRemoteSyntheticBackendItemId(item.id, slot, parentId),
          label: `Remote ${slot}`,
          sourceId: item.snapshot.sourceId,
          itemCount: parentId === undefined ? itemCount : 1,
          state: 'queued',
        });
      }
    }
  }
  const chronological = queueItems
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aid = a.item.backendItemIds?.[0];
      const bid = b.item.backendItemIds?.[0];
      if (aid !== undefined && bid !== undefined && aid !== bid) {
        return aid - bid;
      }
      const at = Date.parse(a.item.snapshot.submittedAt);
      const bt = Date.parse(b.item.snapshot.submittedAt);
      return Number.isFinite(at) && Number.isFinite(bt) && at !== bt ? at - bt : b.index - a.index;
    });
  const order = new Map(chronological.map(({ item }, index) => [item.id, index]));
  return expanded.sort((a, b) => {
    const left = getRemoteProgressIdentity(a);
    const right = getRemoteProgressIdentity(b);
    const leftId = left?.localQueueItemId ?? a.queueItemId;
    const rightId = right?.localQueueItemId ?? b.queueItemId;
    const leftItem = byId.get(leftId);
    const rightItem = byId.get(rightId);
    const indexFor = (session: QueueProgressSession, parent: typeof left, item?: QueueItem): number => {
      const index = parent?.backendItemId ? item?.backendItemIds?.indexOf(parent.backendItemId) : undefined;
      return index !== undefined && index >= 0 ? index : session.itemIndex - 1;
    };
    return (
      (order.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (order.get(rightId) ?? Number.MAX_SAFE_INTEGER) ||
      indexFor(a, left, leftItem) - indexFor(b, right, rightItem) ||
      (left?.slot ?? 0) - (right?.slot ?? 0)
    );
  });
};

/** Display-only remote work. Never fed back into the server's queue counts or statuses. */
export interface RemoteQueueProgressSlot {
  id: string;
  backendItemId: number | null;
  slot: number;
  iteration: number;
  total: number;
  state: QueueProgressSession['state'];
}

export interface RemoteQueueProgressItem {
  queueItemId: string;
  prompt: string;
  localStatus: QueueItem['status'];
  slots: RemoteQueueProgressSlot[];
}

/** Group live and reserved remote slots under their original Workbench queue item. */
export const getRemoteQueueProgressItems = (
  queueItems: readonly QueueItem[],
  sessions: readonly QueueProgressSession[],
  authorizedRecoveredSessionIds: ReadonlySet<string> = new Set()
): RemoteQueueProgressItem[] => {
  const byId = new Map(queueItems.map((item) => [item.id, item]));
  const grouped = new Map<string, RemoteQueueProgressItem>();
  for (const session of sessions) {
    const remote = getRemoteProgressIdentity(session);
    if (!remote || session.state === 'settling') {
      continue;
    }
    const source = byId.get(remote.localQueueItemId);
    if (
      (!source && !authorizedRecoveredSessionIds.has(session.id)) ||
      (source && isRemoteDispatchItemSettled(source.id, remote.slot, remote.backendItemId))
    ) {
      continue;
    }
    // Missing parents occur after browser/project-history recovery. The caller
    // supplies only project-authorized recovered sessions, never raw socket IDs.
    const queueItemId = source?.id ?? remote.localQueueItemId;
    let group = grouped.get(queueItemId);
    if (!group) {
      group = {
        queueItemId,
        prompt: source ? getQueueItemSnapshotPositivePrompt(source) || source.snapshot.graph.label : 'Remote dispatch',
        localStatus: source?.status ?? 'completed',
        slots: [],
      };
      grouped.set(queueItemId, group);
    }
    group.slots.push({
      id: session.id,
      backendItemId: session.backendItemId,
      slot: remote.slot,
      iteration:
        remote.backendItemId === undefined
          ? session.itemIndex
          : Math.max(1, (source?.backendItemIds?.indexOf(remote.backendItemId) ?? -1) + 1),
      total: source ? getQueueItemSnapshotBatchCount(source) : 1,
      state: session.state,
    });
  }
  return [...grouped.values()];
};
