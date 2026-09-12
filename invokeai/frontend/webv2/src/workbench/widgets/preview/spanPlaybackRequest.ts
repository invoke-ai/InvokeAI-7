import type { GalleryItemKey } from '@features/gallery';

/**
 * "Play this video item from A to B, on a loop" — the gesture behind the Video panel's
 * play buttons, which ask Preview to show what a trim actually selected.
 *
 * An ephemeral intent aimed at whichever player is mounted, not a piece of state: it is
 * module-scoped so it is never replayed in a later session, and it carries a token so a
 * repeated press on an unchanged window still reads as a new request. The publisher lives
 * in App (it has to select the item and raise the widget first); the consumer is this
 * widget's `<video>` element, which is why the channel is owned here rather than beside
 * the gallery's reveal request — that one's consumer is the gallery grid itself.
 *
 * The timestamp bounds it. The publisher raises Preview before publishing, so a player
 * mounts promptly; a request read long afterwards belongs to a gesture the user has moved
 * on from, and honouring it would start unmuted audio out of nowhere.
 */

export interface VideoSpanPlaybackRequest {
  endSeconds: number;
  itemKey: GalleryItemKey;
  requestedAt: number;
  startSeconds: number;
  token: number;
}

/** How long a published span request stays honourable. */
export const VIDEO_SPAN_PLAYBACK_TTL_MS = 15_000;

let currentRequest: VideoSpanPlaybackRequest | null = null;
let nextToken = 0;

const listeners = new Set<() => void>();

const notifyListeners = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const requestVideoSpanPlayback = (span: {
  endSeconds: number;
  itemKey: GalleryItemKey;
  startSeconds: number;
}): void => {
  nextToken += 1;
  currentRequest = { ...span, requestedAt: Date.now(), token: nextToken };
  notifyListeners();
};

export const getVideoSpanPlaybackRequest = (): VideoSpanPlaybackRequest | null => currentRequest;

/** True while `requestedAt` is recent enough to act on. */
export const isVideoSpanPlaybackFresh = (requestedAt: number): boolean =>
  Date.now() - requestedAt <= VIDEO_SPAN_PLAYBACK_TTL_MS;

/** Retires `token`, whether or not the player could act on it. A newer request is left alone. */
export const consumeVideoSpanPlaybackRequest = (token: number): void => {
  if (currentRequest?.token !== token) {
    return;
  }

  currentRequest = null;
  notifyListeners();
};

export const subscribeVideoSpanPlaybackRequests = (listener: () => void): (() => void) => {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
};
