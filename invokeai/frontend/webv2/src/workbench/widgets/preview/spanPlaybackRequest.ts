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
 *
 * The return channel is the playback STATE below: the player that honoured a request
 * reports, under that request's token, whether the window is running and how to stop it,
 * so the button that made the request can show a pause control for as long as — and only
 * as long as — its own loop is the one on screen.
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

/** Publishes a request and returns its token, the handle playback state is reported under. */
export const requestVideoSpanPlayback = (span: {
  endSeconds: number;
  itemKey: GalleryItemKey;
  startSeconds: number;
}): number => {
  nextToken += 1;
  currentRequest = { ...span, requestedAt: Date.now(), token: nextToken };
  notifyListeners();

  return nextToken;
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

/**
 * What the player is doing with the request it last honoured. `null` between loops: before
 * any request has been acted on, once the user takes the playhead out of the window, and
 * whenever the player leaves the screen.
 *
 * `isPlaying` follows the element's own `play`/`pause` events rather than the request, so
 * a pause from the native controls — or an autoplay refusal — shows in the panel as
 * faithfully as one from the panel's button, and a native play resumes it. `pause` leaves
 * the loop armed for the same reason the autoplay case does: the native play control then
 * resumes the selection, not the whole clip.
 */
export interface VideoSpanPlaybackState {
  isPlaying: boolean;
  pause: () => void;
  token: number;
}

let currentState: VideoSpanPlaybackState | null = null;

const stateListeners = new Set<() => void>();

const notifyStateListeners = (): void => {
  for (const listener of stateListeners) {
    listener();
  }
};

/** The player's report. Replaces whatever stood before: one loop is on screen at a time. */
export const publishVideoSpanPlaybackState = (state: VideoSpanPlaybackState): void => {
  if (
    currentState !== null &&
    currentState.token === state.token &&
    currentState.isPlaying === state.isPlaying &&
    currentState.pause === state.pause
  ) {
    return;
  }

  currentState = state;
  notifyStateListeners();
};

/** Retires `token`'s state. A report from a newer loop is left alone. */
export const clearVideoSpanPlaybackState = (token: number): void => {
  if (currentState?.token !== token) {
    return;
  }

  currentState = null;
  notifyStateListeners();
};

export const getVideoSpanPlaybackState = (): VideoSpanPlaybackState | null => currentState;

export const subscribeVideoSpanPlaybackState = (listener: () => void): (() => void) => {
  stateListeners.add(listener);

  return () => {
    stateListeners.delete(listener);
  };
};
