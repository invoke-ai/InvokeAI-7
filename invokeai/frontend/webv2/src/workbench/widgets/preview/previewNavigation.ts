import type { GalleryItemKey } from '@features/gallery/contracts';

import { toGalleryItemKey } from '@features/gallery/contracts';

interface NavigableItem {
  kind: 'image' | 'video';
  name: string;
}
export type PreviewNavigationItem<TItem extends NavigableItem> = { kind: 'item'; item: TItem };

/** Saved-image navigation never assigns a live session to a board. */
export const getPreviewNavigationSequence = <TItem extends NavigableItem>({
  boardImages,
}: {
  boardImages: TItem[];
}): PreviewNavigationItem<TItem>[] => boardImages.map((item) => ({ kind: 'item', item }));

export const getPreviewNavigationCursor = <TItem extends NavigableItem>(
  sequence: PreviewNavigationItem<TItem>[],
  { isFollowingLive, selectedItemKey }: { isFollowingLive: boolean; selectedItemKey: GalleryItemKey | null }
): number => {
  if (isFollowingLive) {
    return -1;
  }

  if (selectedItemKey === null) {
    return -1;
  }

  return sequence.findIndex((entry) => entry.kind === 'item' && toGalleryItemKey(entry.item) === selectedItemKey);
};

export const getPreviewNavigationTarget = <TItem extends NavigableItem>(
  sequence: PreviewNavigationItem<TItem>[],
  cursorIndex: number,
  offset: -1 | 1
): PreviewNavigationItem<TItem> | null => (cursorIndex === -1 ? null : (sequence[cursorIndex + offset] ?? null));
