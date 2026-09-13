import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeVideoSpanPlaybackRequest,
  getVideoSpanPlaybackRequest,
  isVideoSpanPlaybackFresh,
  requestVideoSpanPlayback,
  subscribeVideoSpanPlaybackRequests,
  VIDEO_SPAN_PLAYBACK_TTL_MS,
} from './spanPlaybackRequest';

const retireOutstandingRequest = (): void => {
  const request = getVideoSpanPlaybackRequest();

  if (request) {
    consumeVideoSpanPlaybackRequest(request.token);
  }
};

afterEach(() => {
  retireOutstandingRequest();
  vi.useRealTimers();
});

describe('video span playback requests', () => {
  it('mints a fresh token per gesture, even on an unchanged span', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVideoSpanPlaybackRequests(listener);
    const span = { endSeconds: 4, itemKey: 'video:clip.mp4', startSeconds: 2 } as const;

    requestVideoSpanPlayback(span);
    const first = getVideoSpanPlaybackRequest();

    requestVideoSpanPlayback(span);
    const second = getVideoSpanPlaybackRequest();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject(span);
    // Pressing play again on a window the user has not touched must still read as a new
    // request: the player has already retired the first one.
    expect(second?.token).not.toBe(first?.token);

    unsubscribe();
    requestVideoSpanPlayback(span);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('retires only the request the consumer actually read', () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: 'video:first.mp4', startSeconds: 2 });
    const stale = getVideoSpanPlaybackRequest();

    requestVideoSpanPlayback({ endSeconds: 9, itemKey: 'video:second.mp4', startSeconds: 8 });
    // A player that reads late must not clear the gesture that superseded it — pressing
    // play on a second reference while the first is still resolving is exactly that race.
    consumeVideoSpanPlaybackRequest(stale?.token ?? -1);

    expect(getVideoSpanPlaybackRequest()?.itemKey).toBe('video:second.mp4');

    consumeVideoSpanPlaybackRequest(getVideoSpanPlaybackRequest()?.token ?? -1);

    expect(getVideoSpanPlaybackRequest()).toBeNull();
  });

  it('stops vouching for a gesture the user has moved on from', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: 'video:clip.mp4', startSeconds: 2 });
    const request = getVideoSpanPlaybackRequest();

    expect(isVideoSpanPlaybackFresh(request?.requestedAt ?? 0)).toBe(true);

    vi.setSystemTime(Date.now() + VIDEO_SPAN_PLAYBACK_TTL_MS + 1);

    expect(isVideoSpanPlaybackFresh(request?.requestedAt ?? 0)).toBe(false);
  });
});
