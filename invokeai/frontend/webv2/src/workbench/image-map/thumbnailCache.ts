import type { GalleryItemRef } from '@features/gallery/contracts';

import { galleryItems } from '@features/gallery';
import { toGalleryItemKey } from '@features/gallery/contracts';
import {
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';
import { ApiError } from '@platform/transport/http';

/**
 * What a hover card shows for one item: the thumbnail, plus the duration that
 * makes a clip's card read like its gallery tile. Both derive from the
 * immutable item name, so unlike full DTOs they never go stale.
 */
export interface HoverThumbnail {
  url: string;
  /** Seconds, for videos only; images have no duration to show. */
  durationSeconds: number | null;
}

// A video's thumbnail is the frame the index embedded it by, so the hover
// preview shows exactly what the map placed.
const urls = new Map<string, HoverThumbnail | null>();
const inflight = new Map<string, Promise<HoverThumbnail | null>>();

// Thumbnail URLs are account-owned gallery data: drop them on login/logout so
// one account's map hovers can never serve another account's thumbnails.
registerAccountOwnedResource({
  clear: () => {
    urls.clear();
    inflight.clear();
  },
  name: 'image-map-thumbnails',
});

export const getThumbnailUrl = (item: GalleryItemRef): Promise<HoverThumbnail | null> => {
  const key = toGalleryItemKey(item);
  const cached = urls.get(key);

  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const pending = inflight.get(key);

  if (pending) {
    return pending;
  }

  const owner = captureAccountScope();
  const request = galleryItems
    .resolve(item)
    .then((resolved): HoverThumbnail => {
      const thumbnail: HoverThumbnail = {
        durationSeconds: resolved.kind === 'video' ? resolved.durationSeconds : null,
        url: resolved.thumbnailUrl,
      };

      // A resolution that raced an account switch must not seed the next
      // account's cache.
      if (isAccountScopeCurrent(owner)) {
        urls.set(key, thumbnail);
      }

      return thumbnail;
    })
    .catch((error: unknown): null => {
      // A deleted or no-longer-visible item answers definitively, and hovering
      // is driven by pointer movement — so remember the miss, or every dwell
      // over that point re-fetches the same 404 for the rest of the session.
      // (The by-names resolver this replaced returned an empty array for a
      // miss, which the `then` above cached; the by-ref one throws.)
      if (error instanceof ApiError && (error.status === 403 || error.status === 404) && isAccountScopeCurrent(owner)) {
        urls.set(key, null);
      }

      return null;
    })
    .finally(() => {
      // Release only this request's claim; an account switch already cleared
      // the in-flight map.
      if (inflight.get(key) === request) {
        inflight.delete(key);
      }
    });
  inflight.set(key, request);

  return request;
};
