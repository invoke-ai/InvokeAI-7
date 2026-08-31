import type { ImageIndexStatusEvent, ImageMapProjectionReadyEvent } from '@workbench/image-map/events';

import { getAuthSession } from '@features/identity';
import { useMountEffect } from '@platform/react/useMountEffect';
import { socketHub } from '@platform/transport/socketHub';
import {
  imageMapStore,
  recordImageIndexStatus,
  refreshImageIndexStatus,
  refreshImageMapPoints,
} from '@workbench/image-map/imageMapStore';

/**
 * Socket-driven refresh for the image map, replacing polling: when the
 * backend announces a recomputed projection (or the socket reconnects after
 * an outage), the point set refetches. Index progress counts feed the footer.
 * Nothing fetches until the widget itself has loaded the map once — a user
 * who never opens the Image Map pays nothing.
 */
/**
 * An event naming a user other than the session's. Admins receive index and
 * projection events for every user, and an admin refetch usually finds its own
 * all-images projection stale and enqueues another full recompute — so one
 * user's activity would drive UMAP fits on every admin's client. Unknown on
 * either side is not evidence of a foreign event: single-user mode has no
 * session user at all, and an event without a user id predates the field.
 */
const isForAnotherUser = (userId: unknown): boolean => {
  const sessionUserId = getAuthSession().user?.user_id;

  return typeof userId === 'string' && typeof sessionUserId === 'string' && userId !== sessionUserId;
};

export const attachImageMapDataRuntime = (): (() => void) => {
  // The widget host is mounted whenever the image-map widget is *available*,
  // not when it is open, so anything unconditional here bills a user who never
  // looks at the map.
  const hasLoadedOnce = () => {
    const { loadState } = imageMapStore.getSnapshot();

    return loadState === 'loaded' || loadState === 'error';
  };

  const refreshIfLoaded = () => {
    const { loadState, renderError } = imageMapStore.getSnapshot();

    // Only once the widget has actually loaded the map. `loading` used to pass
    // this guard, so an event landing during the first fetch queued a rerun
    // and forced a second full point set the moment it settled. It still must
    // not pass here — but `image_map_projection_ready` below is the exception:
    // that one event can announce a projection newer than the in-flight
    // response, where dropping it strands a stale map.
    if (loadState !== 'loaded' && loadState !== 'error') {
      return;
    }

    // A failed canvas is not something fresh data can repair, and every
    // successful refresh clears `renderError` — which remounts the plot, fails
    // again, and flickers once per event for the length of a backfill.
    // Clearing it stays what it was designed to be: the user's deliberate retry.
    if (renderError) {
      return;
    }

    void refreshImageMapPoints();
  };

  // A finished projection recompute can overtake the fetch that triggered it:
  // the request was served the projection the recompute then replaced, so its
  // points are stale and the labels request that follows it answers over the
  // new record — discarded on the hash mismatch, with no labels to show for
  // it. Dropping the event strands that map until some later one happens to
  // fire; admitting `loading` costs one extra point set at most, because the
  // store's dedup queues a single rerun when a refresh lands mid-flight (the
  // `rerunRequested` comment describes exactly this arrival).
  const refreshProjectionReady = () => {
    const { loadState, renderError } = imageMapStore.getSnapshot();

    if (renderError || (loadState !== 'loaded' && loadState !== 'error' && loadState !== 'loading')) {
      return;
    }

    void refreshImageMapPoints();
  };

  const detachers = [
    // The backend routes this to the requesting user's room plus admins, so
    // receipt alone does not mean "my map changed".
    socketHub.on('image_map_projection_ready', (payload: never) => {
      if (!isForAnotherUser((payload as unknown as ImageMapProjectionReadyEvent | undefined)?.user_id)) {
        refreshProjectionReady();
      }
    }),
    // Counts-free per-user poke: the owner's images just reached the index.
    // This is the only index signal non-admins receive (status events below
    // are admin-only), so it is what makes a non-admin's map follow their
    // own generations.
    socketHub.on('image_index_updated', refreshIfLoaded),
    socketHub.on('image_index_status', (payload: never) => {
      const event = payload as unknown as ImageIndexStatusEvent;
      // Through the store rather than a direct patch: it also folds the counts
      // into the throughput estimate the progress UI turns into a time remaining.
      recordImageIndexStatus({
        embedded: event.embedded,
        failed: event.failed ?? 0,
        pending: event.pending,
        total: event.total,
      });
      // Quiescence is the moment the point set may have changed: batch
      // completions, deletions, and the final sweep after failures all end
      // in a pending === 0 emit (permanently-failed images are excluded
      // from pending so it always drains). Refetching makes the backend
      // compare scope hashes; if the map is stale it enqueues the recompute
      // whose projection-ready event closes the loop above. Without this
      // poke neither side ever initiates: the backend only recomputes when
      // asked, and nothing else asks. Status events are admin-only (the
      // counts aggregate every user's images); non-admins get the
      // image_index_updated poke above for their own embeds, and manual
      // refresh covers their deletions (the backend cannot resolve an
      // owner for an already-deleted row).
      if (event.pending === 0) {
        refreshIfLoaded();
      }
    }),
  ];
  // `onConnectionChange` replays the current status synchronously on subscribe,
  // and this runtime is remounted by every Launchpad -> Editor navigation. That
  // replay only establishes the baseline: an already-connected socket has
  // missed nothing, and refetching on it costs a full point set on every entry
  // into the editor. Only a real disconnected -> connected transition can have
  // gaps to close.
  let previousStatus: string | null = null;
  const detachConnection = socketHub.onConnectionChange((status) => {
    const isReconnect = previousStatus !== null && previousStatus !== 'connected' && status === 'connected';

    previousStatus = status;

    if (isReconnect) {
      refreshIfLoaded();

      // Status events are not replayed, so a run that finished during the
      // outage never announces it: the counts would sit at their last
      // pre-outage value and the progress UI would claim a backfill is still
      // running until the page is reloaded. Re-reading them closes that gap —
      // behind the same guard, so a session that never opened the map still
      // pays nothing for a flapping connection.
      if (hasLoadedOnce()) {
        refreshImageIndexStatus();
      }
    }
  });

  return () => {
    for (const detach of detachers) {
      detach();
    }
    detachConnection();
  };
};

/** React is only the idempotent lifecycle adapter for the non-React runtime. */
export const ImageMapDataRuntime = () => {
  useMountEffect(attachImageMapDataRuntime);

  return null;
};
