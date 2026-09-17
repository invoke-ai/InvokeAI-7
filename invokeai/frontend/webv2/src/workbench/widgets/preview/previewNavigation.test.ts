import { describe, expect, it } from 'vitest';

import {
  getPreviewNavigationCursor,
  getPreviewNavigationSequence,
  getPreviewNavigationTarget,
} from './previewNavigation';

const images = [
  { kind: 'image' as const, name: 'same-name' },
  { kind: 'video' as const, name: 'same-name' },
  { kind: 'image' as const, name: 'older' },
];

describe('saved-image preview navigation', () => {
  it('preserves the board order and distinguishes same-name media', () => {
    const sequence = getPreviewNavigationSequence({ boardImages: images });
    const cursor = getPreviewNavigationCursor(sequence, { isFollowingLive: false, selectedItemKey: 'video:same-name' });
    expect(getPreviewNavigationTarget(sequence, cursor, -1)?.item).toEqual(images[0]);
    expect(getPreviewNavigationTarget(sequence, cursor, 1)?.item).toEqual(images[2]);
    expect(getPreviewNavigationTarget(sequence, 0, -1)).toBeNull();
    expect(getPreviewNavigationTarget(sequence, 2, 1)).toBeNull();
  });
  it('has no board cursor while following a live session or without a saved selection', () => {
    const sequence = getPreviewNavigationSequence({ boardImages: images });
    expect(getPreviewNavigationCursor(sequence, { isFollowingLive: true, selectedItemKey: 'video:same-name' })).toBe(
      -1
    );
    expect(getPreviewNavigationCursor(sequence, { isFollowingLive: false, selectedItemKey: null })).toBe(-1);
  });
});
