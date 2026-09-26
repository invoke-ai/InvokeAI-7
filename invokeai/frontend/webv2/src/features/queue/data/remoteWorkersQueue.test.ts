import type { QueueProgressSession } from '@features/queue/core/activeSessions';
import type { QueueItem } from '@features/queue/core/historyTypes';

import { getRemoteProgressTarget, getRemoteSyntheticBackendItemId } from '@features/queue/core/remoteProgress';
import { describe, expect, it } from 'vitest';

import { getRemoteQueueProgressItems } from './remoteWorkersDispatch';

const source = {
  id: 'generation-1',
  status: 'completed',
  backendItemIds: [55],
  snapshot: {
    graph: { label: 'Example' },
    presentation: { positivePrompt: 'A portrait', batchCount: 1 },
  },
} as QueueItem;

const target = getRemoteProgressTarget(source.id, 2, 55);
const running = {
  ...target,
  id: `${target.queueItemId}:${target.itemIndex}`,
  backendItemId: getRemoteSyntheticBackendItemId(source.id, 2, 55),
  state: 'running',
} as QueueProgressSession;

describe('Remote queue display model', () => {
  it('keeps a remote job active after its native queue item completes', () => {
    expect(getRemoteQueueProgressItems([source], [running])).toMatchObject([
      {
        queueItemId: source.id,
        prompt: 'A portrait',
        localStatus: 'completed',
        slots: [{ slot: 2, iteration: 1, total: 1, state: 'running' }],
      },
    ]);
  });

  it('omits settled remote work without mutating the local queue item', () => {
    expect(getRemoteQueueProgressItems([source], [{ ...running, state: 'settling' }])).toEqual([]);
    expect(source.status).toBe('completed');
  });

  it('does not expose another project’s remote sessions', () => {
    expect(getRemoteQueueProgressItems([], [running])).toEqual([]);
  });
});

// A recovered bridge may outlive the browser's Workbench queue history.
it('displays an authorized recovered session even when its parent is absent', () => {
  expect(getRemoteQueueProgressItems([], [running], new Set([running.id]))).toMatchObject([
    { queueItemId: source.id, prompt: 'Remote dispatch', slots: [{ slot: 2, state: 'running' }] },
  ]);
});
