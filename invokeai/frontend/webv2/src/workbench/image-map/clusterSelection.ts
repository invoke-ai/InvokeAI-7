import type { GalleryItemKey } from '@features/gallery/contracts';

import type { ImageMapPoint } from './api';

/**
 * Cluster-click selection: everything in the clicked point's cluster,
 * ordered by distance from the clicked point (PhotoMapAI's proximity
 * ordering) so gallery multi-selection walks outward from the click.
 *
 * Members are item keys: a cluster groups by what the encoder saw, so a video
 * sits in the same cluster as the images that look like it.
 */

/** Selection size guard; DBSCAN can put most of a huge gallery in one cluster. */
export const MAX_CLUSTER_SELECTION = 5000;

export const collectClusterSelection = (
  points: ImageMapPoint[],
  clickedKey: GalleryItemKey,
  cap: number = MAX_CLUSTER_SELECTION
): GalleryItemKey[] | null => {
  const clicked = points.find((point) => point.key === clickedKey);

  if (!clicked || clicked.cluster < 0) {
    return null;
  }

  return points
    .filter((point) => point.cluster === clicked.cluster)
    .map((point) => ({
      distance: (point.x - clicked.x) ** 2 + (point.y - clicked.y) ** 2,
      key: point.key,
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, cap)
    .map((entry) => entry.key);
};
