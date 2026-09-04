import { describe, expect, it } from 'vitest';

import type { GalleryImageItem, GalleryItem, GalleryVideoItem } from './items';
import type { GeneratedImageContract } from './types';

import * as selection from './selection';

const legacyImage: GeneratedImageContract = {
  height: 768,
  imageName: 'legacy.png',
  imageUrl: '/images/legacy.png',
  queuedAt: '2026-07-30T00:00:00.000Z',
  sourceQueueItemId: 'queue-item',
  thumbnailUrl: '/thumbnails/legacy.png',
  width: 512,
};

const imageItem: GalleryImageItem = {
  boardId: 'board-1',
  category: 'general',
  createdAt: '2026-07-30T01:00:00.000Z',
  fullUrl: '/images/shared',
  height: 768,
  isIntermediate: false,
  kind: 'image',
  name: 'shared',
  sourceQueueItemId: 'backend-gallery',
  starred: true,
  thumbnailUrl: '/thumbnails/shared',
  width: 512,
};

const videoItem: GalleryVideoItem = {
  boardId: 'board-1',
  category: 'general',
  createdAt: '2026-07-30T02:00:00.000Z',
  durationSeconds: 4,
  fullUrl: '/videos/shared',
  height: 768,
  isIntermediate: false,
  kind: 'video',
  name: 'shared',
  starred: false,
  thumbnailUrl: '/video-thumbnails/shared',
  width: 512,
};

type SelectionModule = typeof selection & {
  getPersistedSelectedGalleryItemKeys?: (values: Record<string, unknown>) => string[];
  getSelectedGalleryItemFromValues?: (values: Record<string, unknown>) => GalleryItem | null;
};

const getSelectedGalleryItemFromValues = (values: Record<string, unknown>): GalleryItem | null | undefined =>
  (selection as SelectionModule).getSelectedGalleryItemFromValues?.(values);
const getPersistedSelectedGalleryItemKeys = (values: Record<string, unknown>): string[] | undefined =>
  (selection as SelectionModule).getPersistedSelectedGalleryItemKeys?.(values);

describe('persisted Gallery selection readers', () => {
  it('returns a canonical selected image item unchanged', () => {
    expect(getSelectedGalleryItemFromValues({ selectedImage: imageItem })).toBe(imageItem);
  });

  it('returns a canonical selected video while the image-only reader rejects it', () => {
    const values = { selectedImage: videoItem, selectedImageName: 'video:shared' };

    expect(getSelectedGalleryItemFromValues(values)).toBe(videoItem);
    expect(selection.getSelectedGalleryImageFromValues(values)).toBeNull();
  });

  it('adapts a legacy generated-image object into a canonical image item', () => {
    expect(
      getSelectedGalleryItemFromValues({
        selectedBoardId: 'board-1',
        selectedImage: legacyImage,
      })
    ).toEqual({
      boardId: 'board-1',
      category: 'general',
      createdAt: legacyImage.queuedAt,
      fullUrl: legacyImage.imageUrl,
      height: legacyImage.height,
      isIntermediate: false,
      kind: 'image',
      name: legacyImage.imageName,
      sourceQueueItemId: legacyImage.sourceQueueItemId,
      starred: false,
      thumbnailUrl: legacyImage.thumbnailUrl,
      width: legacyImage.width,
    });
  });

  it.each(['legacy.png', 'image:legacy.png'])(
    'adapts the legacy recent-image fallback selected by %s',
    (selectedImageName) => {
      const values = {
        recentImages: [legacyImage],
        selectedBoardId: 'board-1',
        selectedImageName,
      };

      expect(getSelectedGalleryItemFromValues(values)).toMatchObject({
        boardId: 'board-1',
        kind: 'image',
        name: legacyImage.imageName,
      });
      expect(selection.getSelectedGalleryImageFromValues(values)).toMatchObject({
        boardId: 'board-1',
        imageName: legacyImage.imageName,
      });
    }
  );

  it('converts a canonical image item for legacy image-only consumers', () => {
    expect(selection.getSelectedGalleryImageFromValues({ selectedImage: imageItem })).toEqual({
      boardId: imageItem.boardId,
      createdAt: imageItem.createdAt,
      height: imageItem.height,
      imageCategory: imageItem.category,
      imageName: imageItem.name,
      imageUrl: imageItem.fullUrl,
      queuedAt: imageItem.createdAt,
      sourceQueueItemId: imageItem.sourceQueueItemId,
      starred: imageItem.starred,
      thumbnailUrl: imageItem.thumbnailUrl,
      width: imageItem.width,
    });
  });

  it('canonicalizes qualified and bare keys from a persisted multi-selection', () => {
    expect(
      getPersistedSelectedGalleryItemKeys({
        selectedImageNames: ['video:clip.mp4', 'legacy.png', 'image:a:b.png', 42],
        selectedImageName: 'ignored.png',
        selectedImage: videoItem,
      })
    ).toEqual(['video:clip.mp4', 'image:legacy.png', 'image:a:b.png']);
  });

  it('falls back to the legacy singular persisted selection key', () => {
    expect(getPersistedSelectedGalleryItemKeys({ selectedImageName: 'legacy.png' })).toEqual(['image:legacy.png']);
  });

  it('falls back to the canonical selected item object when persisted keys are absent', () => {
    expect(getPersistedSelectedGalleryItemKeys({ selectedImage: videoItem })).toEqual(['video:shared']);
  });
});

describe('getGalleryDeletionSuccessor', () => {
  const ref = (name: string): { kind: 'image'; name: string } => ({ kind: 'image', name });
  const keys = (...names: string[]): Set<`image:${string}`> => new Set(names.map((name) => `image:${name}` as const));

  it('picks the next item in display order — the one that slides into the deleted slot', () => {
    expect(selection.getGalleryDeletionSuccessor([ref('a'), ref('b'), ref('c')], 'image:b', keys('b'))).toEqual(
      ref('c')
    );
  });

  it('falls back to the nearest earlier item at the end of the list', () => {
    expect(selection.getGalleryDeletionSuccessor([ref('a'), ref('b'), ref('c')], 'image:c', keys('c'))).toEqual(
      ref('b')
    );
  });

  it('skips ineligible refs in both directions', () => {
    expect(
      selection.getGalleryDeletionSuccessor([ref('a'), ref('b'), ref('c'), ref('d')], 'image:b', keys('b', 'c', 'd'))
    ).toEqual(ref('a'));
  });

  it('stays in the regular block when starred-first names lead the list', () => {
    // Regression: the old earlier-first walk crossed the section boundary, so
    // deleting the first regular item selected the LAST STARRED item.
    const orderedRefs = [ref('starred-1'), ref('starred-2'), ref('regular-1'), ref('regular-2')];

    expect(selection.getGalleryDeletionSuccessor(orderedRefs, 'image:regular-1', keys('regular-1'))).toEqual(
      ref('regular-2')
    );
  });

  it('returns null when the primary is not in the list', () => {
    expect(selection.getGalleryDeletionSuccessor([ref('a')], 'image:missing', keys('a'))).toBeNull();
    expect(selection.getGalleryDeletionSuccessor([], 'image:a', keys('a'))).toBeNull();
  });

  it('returns null when nothing survives', () => {
    expect(selection.getGalleryDeletionSuccessor([ref('a')], 'image:a', keys('a'))).toBeNull();
  });
});
