import type { InvocationProgressEvent, QueueItem } from '@features/queue';

import { buildQueueItemOrigin } from '@features/queue';
import { describe, expect, it } from 'vitest';

import { getCanvasRemotePreviewsForDisplay, type CanvasRemotePreview } from './canvasRemotePreviews';

const parent = {
  id: 'generation-1',
  status: 'completed',
  snapshot: { destination: 'canvas' },
} as QueueItem;

const event = (overrides: Partial<InvocationProgressEvent> = {}): InvocationProgressEvent =>
  ({
    message: '[[IRW_REMOTE|generation-1|2|running|55]] Remote 2 rendering',
    origin: buildQueueItemOrigin('generation-1', 'project-a'),
    destination: 'canvas',
    ...overrides,
  }) as InvocationProgressEvent;

const live: CanvasRemotePreview = {
  queueItemId: 'generation-1',
  slot: 2,
  backendItemId: 55,
  state: 'running',
};

describe('Canvas remote preview recovery', () => {
  it('restores a running Canvas slot when history hydrates after the bridge snapshot', () => {
    expect(getCanvasRemotePreviewsForDisplay({}, [event()], [parent], 'project-a')).toEqual([live]);
  });

  it('does not duplicate a Canvas slot already received from the socket', () => {
    const existing = { 'generation-1::2::55': live };
    expect(getCanvasRemotePreviewsForDisplay(existing, [event()], [parent], 'project-a')).toEqual([live]);
  });

  it('keeps Canvas sessions out of other projects and rejects non-Canvas destinations', () => {
    expect(getCanvasRemotePreviewsForDisplay({}, [event()], [parent], 'project-b')).toEqual([]);
    expect(getCanvasRemotePreviewsForDisplay({}, [event({ destination: 'gallery' })], [parent], 'project-a')).toEqual(
      []
    );
    expect(
      getCanvasRemotePreviewsForDisplay(
        {},
        [event()],
        [{ ...parent, snapshot: { ...parent.snapshot, destination: 'gallery' } }],
        'project-a'
      )
    ).toEqual([]);
  });

  it('does not invent Canvas placement without the original project queue item', () => {
    expect(getCanvasRemotePreviewsForDisplay({}, [event()], [], 'project-a')).toEqual([]);
  });

  it('does not revive terminal or cancelled remote work', () => {
    expect(
      getCanvasRemotePreviewsForDisplay(
        {},
        [event({ message: '[[IRW_REMOTE|generation-1|2|completed|55]] Done' })],
        [parent],
        'project-a'
      )
    ).toEqual([]);
    expect(getCanvasRemotePreviewsForDisplay({}, [event()], [{ ...parent, status: 'cancelled' }], 'project-a')).toEqual(
      []
    );
  });
});
