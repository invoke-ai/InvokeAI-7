import type { GalleryItemKey, GalleryItemRef } from '@features/gallery/contracts';

import { toGalleryItemKey } from '@features/gallery/contracts';
import { apiFetchJson } from '@platform/transport/http';

import type { ImageIndexCounts } from './indexProgress';

/** Mirrors the backend's ImageMapState literal. */
export type ImageMapState = 'disabled' | 'model_missing' | 'empty' | 'computing' | 'ready';

export interface ImageMapPoint {
  x: number;
  y: number;
  /** The gallery item this point stands for; videos plot beside images. */
  item: GalleryItemRef;
  /**
   * `item`'s gallery key, derived once here. Every comparison the map makes —
   * hit-testing a click, masking the selection, keying a hover — is against a
   * key, and a 100k-point map re-scans on each wheel-zoom event, so deriving
   * it per comparison would allocate a string per point per frame.
   */
  key: GalleryItemKey;
  /** DBSCAN cluster label; -1 means unclustered noise. */
  cluster: number;
}

export interface ImageMapPoints {
  points: ImageMapPoint[];
  state: ImageMapState;
  /** The accessible image set changed since this projection was computed; a refresh is pending. */
  stale: boolean;
  pointCount: number;
  /** The configured embedding model's name; only set when state is 'model_missing'. */
  modelName: string | null;
  /** The effective DBSCAN eps these points were clustered with; pass it back to reproduce the clustering. */
  clusterEps: number | null;
  /** Fingerprint of the visible image set; label responses with a different hash were clustered over a drifted set. */
  visibleHash: string | null;
  updatedAt: string | null;
}

interface BackendImageMapPoint {
  x: number;
  y: number;
  /** The item's name, whatever its kind; `kind` says which namespace it is in. */
  image_name: string;
  /** Optional on the wire: a backend older than indexed videos omits it. */
  kind?: string;
  cluster: number;
}

interface BackendImageMapPointsResponse {
  points: BackendImageMapPoint[];
  state: ImageMapState;
  stale: boolean;
  point_count: number;
  model_name?: string | null;
  cluster_eps?: number | null;
  visible_hash?: string | null;
  updated_at: string | null;
}

/**
 * Opts this client into video items. The backend indexes videos either way and
 * serves them only to clients that resolve each item through the endpoint its
 * `kind` names — which this one does, so every map request asks for them.
 */
const INCLUDE_VIDEOS_PARAM = { include_videos: 'true' } as const;

const mapPoints = (body: BackendImageMapPointsResponse): ImageMapPoints => ({
  clusterEps: body.cluster_eps ?? null,
  modelName: body.model_name ?? null,
  pointCount: body.point_count,
  points: body.points.map((point) => {
    // Only `video` names the other namespace; anything else is an image, so an
    // unexpected value degrades to the kind that has always been on the map
    // rather than producing an item no endpoint can resolve.
    const item: GalleryItemRef = { kind: point.kind === 'video' ? 'video' : 'image', name: point.image_name };

    return { cluster: point.cluster, item, key: toGalleryItemKey(item), x: point.x, y: point.y };
  }),
  stale: body.stale,
  state: body.state,
  updatedAt: body.updated_at ?? null,
  visibleHash: body.visible_hash ?? null,
});

export const fetchImageMapPoints = async (options?: { eps?: number; minSamples?: number }): Promise<ImageMapPoints> => {
  const query = new URLSearchParams(INCLUDE_VIDEOS_PARAM);

  if (options?.eps !== undefined) {
    query.set('eps', String(options.eps));
  }

  if (options?.minSamples !== undefined) {
    query.set('min_samples', String(options.minSamples));
  }

  // Not URLSearchParams.size: it is newer than the build's browser baseline
  // (undefined on Safari 16, which would silently drop the params).
  const queryString = query.toString();
  const body = await apiFetchJson<BackendImageMapPointsResponse>(
    `/api/v1/image_map/points${queryString ? `?${queryString}` : ''}`
  );

  return mapPoints(body);
};

export interface ImageMapStatus {
  /** Embedding-index counts, or null: the backend omits them for non-admins. */
  index: ImageIndexCounts | null;
}

interface BackendImageMapStatusResponse {
  enabled: boolean;
  index?: { total: number; embedded: number; failed?: number } | null;
}

/**
 * Current index/projection status. Only the index counts are read here: the
 * projection half of the response duplicates what /points already carries, and
 * the counts are the one thing no other call returns.
 */
export const fetchImageMapStatus = async (): Promise<ImageMapStatus> => {
  // Sent for consistency with the map's other calls: this reader keeps only
  // `index` (which counts both kinds), but the response's projection half is
  // kind-filtered by this flag, and a future reader of it should not have to
  // discover that the call it inherited asked for a different map.
  const body = await apiFetchJson<BackendImageMapStatusResponse>(
    `/api/v1/image_map/status?${new URLSearchParams(INCLUDE_VIDEOS_PARAM).toString()}`
  );

  if (!body.index) {
    return { index: null };
  }

  const { embedded, total } = body.index;
  const failed = body.index.failed ?? 0;

  return {
    // `pending` is a computed property on the backend model and so is absent
    // from the serialized response; it is derived the same way here (failures
    // are excluded so it can still drain to zero).
    index: { embedded, failed, pending: Math.max(0, total - embedded - failed), total },
  };
};

export const requestImageMapRefresh = async (): Promise<boolean> => {
  const body = await apiFetchJson<{ enqueued: boolean }>('/api/v1/image_map/refresh', { method: 'POST' });

  return body.enqueued;
};

export interface ImageMapClusterLabelInfo {
  /** Best-matching vocabulary phrase. */
  label: string;
  /** Runner-up phrases, best first. */
  alternates: string[];
}

export interface ImageMapClusterLabels {
  labels: Record<string, ImageMapClusterLabelInfo>;
  /** Fingerprint of the visible image set the labels were clustered over. */
  visibleHash: string | null;
  /** The projection these labels were computed against. */
  updatedAt: string | null;
}

export const fetchImageMapClusterLabels = async (options?: {
  eps?: number;
  minSamples?: number;
}): Promise<ImageMapClusterLabels> => {
  // Must match /points exactly: the two responses' visible hashes are compared
  // before the labels are used, and a set difference discards every label.
  const query = new URLSearchParams(INCLUDE_VIDEOS_PARAM);

  if (options?.eps !== undefined) {
    query.set('eps', String(options.eps));
  }

  if (options?.minSamples !== undefined) {
    query.set('min_samples', String(options.minSamples));
  }

  const queryString = query.toString();
  const body = await apiFetchJson<{
    labels: Record<string, { label: string; alternates?: string[] }>;
    visible_hash?: string | null;
    updated_at?: string | null;
  }>(`/api/v1/image_map/cluster_labels${queryString ? `?${queryString}` : ''}`);

  return {
    labels: Object.fromEntries(
      Object.entries(body.labels).map(([clusterId, info]) => [
        clusterId,
        { alternates: info.alternates ?? [], label: info.label },
      ])
    ),
    updatedAt: body.updated_at ?? null,
    visibleHash: body.visible_hash ?? null,
  };
};

export interface ImageMapImageLabels {
  /** Best-matching vocabulary phrase. */
  label: string;
  /** Runner-up phrases, best first. */
  alternates: string[];
}

export const fetchImageMapImageLabels = async (item: GalleryItemRef): Promise<ImageMapImageLabels> => {
  const query = new URLSearchParams({ image_name: item.name, kind: item.kind });
  const body = await apiFetchJson<{ label: string; alternates?: string[] }>(
    `/api/v1/image_map/image_labels?${query.toString()}`
  );

  return { alternates: body.alternates ?? [], label: body.label };
};
