import type { GalleryBoard, GalleryView } from '@features/gallery/core/types';

import { getBoardCounts } from './galleryStateView';

/**
 * How many items the active tab would show for a board, so a count always
 * answers "how many of what I'm looking at".
 */
export const getGalleryCountForView = (board: GalleryBoard, galleryView: GalleryView): number => {
  const counts = getBoardCounts(board);

  // Videos split across the views the same way images do: uploaded ('user') videos are
  // assets, generated ('general') videos are media. Clamped: the uncategorized
  // pseudo-board's counts come from parallel requests, so a delete landing between
  // them can transiently report more asset videos than videos.
  return galleryView === 'assets'
    ? counts.assetCount + counts.assetVideoCount
    : Math.max(0, counts.imageCount + counts.videoCount - counts.assetVideoCount);
};
