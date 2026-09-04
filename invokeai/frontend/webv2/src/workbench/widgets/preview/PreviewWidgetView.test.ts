import type { GalleryItem } from '@features/gallery';

import { GALLERY_MAX_ROWS } from '@features/gallery/queries';
import { describe, expect, it } from 'vitest';

import { getMatchingProgressImage, getVideoFrameCopyNotice } from './PreviewWidgetView';
import { mergePreviewBoardItems } from './usePreviewNavigation';

describe('getMatchingProgressImage', () => {
  const placeholder = {
    backendItemId: null,
    boardId: 'none',
    height: 768,
    id: 'queue-1:1',
    itemIndex: 2,
    queueItemId: 'queue-1',
    width: 512,
  };
  const progressImage = {
    dataUrl: 'data:image/png;base64,abc',
    height: 768,
    target: { itemIndex: 2, queueItemId: 'queue-1' },
    width: 512,
  };

  it('returns progress only when it belongs to the current placeholder', () => {
    expect(getMatchingProgressImage(progressImage, placeholder)).toBe(progressImage);
    expect(
      getMatchingProgressImage({ ...progressImage, target: { itemIndex: 1, queueItemId: 'queue-1' } }, placeholder)
    ).toBeNull();
    expect(
      getMatchingProgressImage({ ...progressImage, target: { itemIndex: 2, queueItemId: 'queue-2' } }, placeholder)
    ).toBeNull();
  });
});

describe('mergePreviewBoardItems', () => {
  const item = (kind: GalleryItem['kind'], name: string, createdAt: string, starred = false): GalleryItem => {
    const base = {
      boardId: 'none',
      category: 'general' as const,
      createdAt,
      fullUrl: `/${kind}/${name}`,
      height: 64,
      isIntermediate: false,
      name,
      starred,
      thumbnailUrl: `/${kind}/${name}/thumbnail`,
      width: 64,
    };

    return kind === 'video' ? { ...base, durationSeconds: 1, kind } : { ...base, kind };
  };

  it('deduplicates and chronologically merges optimistic items in either direction', () => {
    const oldest = item('image', 'oldest', '2026-07-21T00:00:01.000Z');
    const middle = item('image', 'middle', '2026-07-21T00:00:02.000Z');
    const newest = item('image', 'newest', '2026-07-21T00:00:03.000Z');

    expect(mergePreviewBoardItems([newest, oldest], [middle, newest], 'DESC', { starredFirst: true })).toEqual([
      newest,
      middle,
      oldest,
    ]);
    expect(mergePreviewBoardItems([oldest, newest], [middle, oldest], 'ASC', { starredFirst: true })).toEqual([
      oldest,
      middle,
      newest,
    ]);
  });

  it('preserves relevance order for a ranked list', () => {
    // A similarity result set is ordered by relevance, not by date. Re-sorting
    // it here would make the arrows walk a different order from the one on
    // screen. (Local generations never reach this call in ranked mode — the
    // caller passes only the selection; see the anchor test below.)
    const first = item('image', 'first', '2026-07-21T00:00:01.000Z');
    const second = item('image', 'second', '2026-07-21T00:00:03.000Z', true);
    const third = item('image', 'third', '2026-07-21T00:00:02.000Z');
    const optimistic = item('image', 'optimistic', '2026-07-21T00:00:09.000Z');

    expect(mergePreviewBoardItems([first, second, third], [], 'DESC', { isRanked: true, starredFirst: true })).toEqual([
      first,
      second,
      third,
    ]);
    // Without the flag the same input is re-sorted (starred first, then
    // newest) and the optimistic item is spliced in, so the ranked path really
    // is what preserves the list.
    expect(mergePreviewBoardItems([first, second, third], [optimistic], 'DESC', { starredFirst: true })).toEqual([
      second,
      optimistic,
      third,
      first,
    ]);
  });

  it('anchors a selection that the ranking does not contain, rather than losing the cursor', () => {
    // A selection can be made outside the result set — an upload, an image-map
    // click, or stepping off the live tile. Dropping it would leave the cursor
    // pointing at nothing, which reads as both arrows going dead; keeping it
    // at the head lets one press move into the ranked list.
    const ranked = item('image', 'ranked', '2026-07-21T00:00:01.000Z');
    const outsider = item('image', 'outsider', '2026-07-21T00:00:09.000Z');

    expect(mergePreviewBoardItems([ranked], [outsider], 'DESC', { isRanked: true, starredFirst: true })).toEqual([
      outsider,
      ranked,
    ]);
    // Already a member: kept once, in its ranked position.
    expect(mergePreviewBoardItems([ranked], [ranked], 'DESC', { isRanked: true, starredFirst: true })).toEqual([
      ranked,
    ]);
  });

  it('keeps starred backend items ahead of optimistic unstarred items', () => {
    const starred = item('video', 'starred', '2026-07-21T00:00:01.000Z', true);
    const optimistic = item('image', 'optimistic', '2026-07-21T00:00:03.000Z');
    const existing = item('video', 'existing', '2026-07-21T00:00:02.000Z');

    expect(mergePreviewBoardItems([starred, existing], [optimistic], 'DESC', { starredFirst: true })).toEqual([
      starred,
      optimistic,
      existing,
    ]);
  });

  it('merges chronologically past starred items in a flat listing', () => {
    // Paginated pages are flat: navigation must walk the same order the grid
    // shows, not lift starred items to the front.
    const starred = item('video', 'starred', '2026-07-21T00:00:01.000Z', true);
    const optimistic = item('image', 'optimistic', '2026-07-21T00:00:03.000Z');
    const existing = item('video', 'existing', '2026-07-21T00:00:02.000Z');

    expect(mergePreviewBoardItems([starred, existing], [optimistic], 'DESC', { starredFirst: false })).toEqual([
      optimistic,
      existing,
      starred,
    ]);
  });

  it('uses the server kind/name tie-breakers for equal timestamps in both directions', () => {
    const createdAt = '2026-07-21T00:00:01.000Z';
    const imageA = item('image', 'a', createdAt);
    const imageZ = item('image', 'z', createdAt);
    const videoA = item('video', 'a', createdAt);
    const videoZ = item('video', 'z', createdAt);

    expect(mergePreviewBoardItems([videoA, imageZ], [videoZ, imageA], 'ASC', { starredFirst: true })).toEqual([
      imageA,
      imageZ,
      videoA,
      videoZ,
    ]);
    expect(mergePreviewBoardItems([imageA, videoZ], [imageZ, videoA], 'DESC', { starredFirst: true })).toEqual([
      videoZ,
      videoA,
      imageZ,
      imageA,
    ]);
  });

  it('keeps same-name media independent and bounds the merged Gallery window', () => {
    const backend = Array.from({ length: GALLERY_MAX_ROWS }, (_, index) =>
      item('image', `backend-${index}`, new Date(index * 1_000).toISOString())
    );
    const optimistic = Array.from({ length: 60 }, (_, index) =>
      item('video', `optimistic-${index}`, new Date((GALLERY_MAX_ROWS + index) * 1_000).toISOString())
    );
    backend[GALLERY_MAX_ROWS - 1] = item('image', 'shared', new Date((GALLERY_MAX_ROWS - 1) * 1_000).toISOString());
    optimistic[0] = item('video', 'shared', new Date((GALLERY_MAX_ROWS + 1) * 1_000).toISOString());

    const merged = mergePreviewBoardItems(backend, optimistic, 'DESC', { starredFirst: true });

    expect(merged).toHaveLength(GALLERY_MAX_ROWS);
    expect(merged[0]?.name).toBe('optimistic-59');
    expect(merged).toContainEqual(expect.objectContaining({ kind: 'image', name: 'shared' }));
    expect(merged).toContainEqual(expect.objectContaining({ kind: 'video', name: 'shared' }));
  });
});

describe('getVideoFrameCopyNotice', () => {
  it.each([
    [{ ok: true } as const, 'success', 'widgets.preview.copyCurrentFrameSuccess'],
    [{ ok: false, reason: 'unsupported' } as const, 'error', 'widgets.preview.copyCurrentFrameUnsupported'],
    [{ ok: false, reason: 'not-ready' } as const, 'error', 'widgets.preview.copyCurrentFrameNotReady'],
    [{ ok: false, reason: 'draw-failed' } as const, 'error', 'widgets.preview.copyCurrentFrameDrawFailed'],
    [{ ok: false, reason: 'encode-failed' } as const, 'error', 'widgets.preview.copyCurrentFrameEncodeFailed'],
    [{ ok: false, reason: 'clipboard-failed' } as const, 'error', 'widgets.preview.copyCurrentFrameWriteFailed'],
    [{ ok: false, reason: 'stale' } as const, 'error', 'widgets.preview.copyCurrentFrameStale'],
  ])('maps %o to one localized notification', (result, kind, key) => {
    expect(getVideoFrameCopyNotice(result, (translationKey) => translationKey)).toEqual({ kind, title: key });
  });
});
