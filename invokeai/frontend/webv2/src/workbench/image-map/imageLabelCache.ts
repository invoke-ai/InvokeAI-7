import type { GalleryItemRef } from '@features/gallery/contracts';

import { toGalleryItemKey } from '@features/gallery/contracts';
import {
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';
import { ApiError } from '@platform/transport/http';

import type { ImageMapImageLabels } from './api';

import { fetchImageMapImageLabels } from './api';

/**
 * Caches per-item vocabulary labels, including empty results, until vocabulary rebuild. Embeddings are stable;
 * editable vocabulary determines invalidation.
 */
const labels = new Map<string, ImageMapImageLabels | null>();
const inflight = new Map<string, Promise<ImageMapImageLabels | null>>();

/**
 * Server-wide cooldown prevents one failing request per hovered point while allowing recovery after lazy
 * vocabulary build or outage.
 */
const UNAVAILABLE_COOLDOWN_MS = 60_000;

let unavailableUntil = 0;

// Clear labels and cooldown on login/logout to prevent cross-account results or backend failure state.
registerAccountOwnedResource({
  clear: () => {
    labels.clear();
    inflight.clear();
    unavailableUntil = 0;
  },
  name: 'image-map-image-labels',
});

/**
 * Vocabulary rebuild clears hover labels and cooldown so item tags agree with refreshed cluster labels and
 * pending-build retries resume.
 */
export const clearImageLabels = (): void => {
  labels.clear();
  unavailableUntil = 0;
};

export const getImageLabels = (item: GalleryItemRef): Promise<ImageMapImageLabels | null> => {
  const key = toGalleryItemKey(item);
  // Checked before the cooldown: labels already fetched for this item stay
  // available even while a server-wide 409 is being backed off.
  const cached = labels.get(key);

  if (cached !== undefined) {
    return Promise.resolve(cached);
  }

  const pending = inflight.get(key);

  if (pending) {
    return pending;
  }

  if (Date.now() < unavailableUntil) {
    return Promise.resolve(null);
  }

  const owner = captureAccountScope();
  const request = fetchImageMapImageLabels(item)
    .then((result): ImageMapImageLabels | null => {
      // A resolution that raced an account switch must not seed the next
      // account's cache.
      if (isAccountScopeCurrent(owner)) {
        labels.set(key, result);
      }

      return result;
    })
    .catch((error: unknown): null => {
      if (!isAccountScopeCurrent(owner)) {
        return null;
      }

      if (error instanceof ApiError && (error.status === 409 || error.status >= 500)) {
        // Treat 409/build and 5xx outages as temporary server-wide failures: back off without caching per-item
        // results.
        unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      } else if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        // Cache definitive item misses: not indexed or not visible to this account.
        labels.set(key, null);
      }

      // Other transient failures remain uncached so later hover retries.
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
