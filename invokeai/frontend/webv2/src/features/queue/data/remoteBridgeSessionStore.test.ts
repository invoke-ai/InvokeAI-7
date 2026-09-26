import type { QueueItem } from '@features/queue/core/historyTypes';
import type { InvocationProgressEvent } from '@features/queue/data/events';

import { buildQueueItemOrigin } from '@features/queue/data/events';
import { describe, expect, it } from 'vitest';

import { getRecoveredRemoteSessions } from './remoteBridgeSessionStore';

const event = (overrides: Partial<InvocationProgressEvent> = {}): InvocationProgressEvent =>
  ({
    message: '[[IRW_REMOTE|generation-1|2|running|55]] Remote 2 rendering',
    origin: buildQueueItemOrigin('generation-1', 'project-a'),
    destination: 'gallery',
    ...overrides,
  }) as InvocationProgressEvent;

const item = {
  id: 'generation-1',
  snapshot: { destination: 'gallery', sourceId: 'generate' },
} as QueueItem;

describe('recovered remote UI sessions', () => {
  it('restores a live remote without a followed target or parent history item', () => {
    expect(getRecoveredRemoteSessions([], 'project-a', [event()])).toMatchObject([
      { label: 'Remote 2', state: 'running', sourceId: 'generate', width: 1024, height: 1024 },
    ]);
  });
  it('does not show bridges from another project or without explicit destination', () => {
    expect(getRecoveredRemoteSessions([], 'project-b', [event()])).toEqual([]);
    expect(getRecoveredRemoteSessions([], 'project-a', [event({ destination: null })])).toEqual([]);
    expect(getRecoveredRemoteSessions([], 'project-a', [event({ origin: 'webv2:generation-1' })])).toEqual([]);
  });
  it('keeps Canvas progress out of Gallery while allowing it in the in-progress Queue', () => {
    const canvas = event({ destination: 'canvas' });
    expect(getRecoveredRemoteSessions([], 'project-a', [canvas])).toEqual([]);
    expect(getRecoveredRemoteSessions([], 'project-a', [canvas], 'all')).toHaveLength(1);
  });
  it('respects the original queue item destination when history is available', () => {
    expect(getRecoveredRemoteSessions([item], 'project-a', [event({ destination: null })])).toHaveLength(1);
    expect(getRecoveredRemoteSessions([item], 'project-a', [event({ destination: null })], 'all')).toHaveLength(1);
  });
  it('never brings back terminal remote progress', () => {
    expect(
      getRecoveredRemoteSessions([], 'project-a', [
        event({ message: '[[IRW_REMOTE|generation-1|2|completed|55]] Done' }),
      ])
    ).toEqual([]);
  });
});
