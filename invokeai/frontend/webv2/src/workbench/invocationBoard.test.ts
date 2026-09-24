import { describe, expect, it } from 'vitest';

import { resolveInvocationGalleryBoardId } from './invocationBoard';

describe('resolveInvocationGalleryBoardId', () => {
  const galleryValues = { projectBoardId: 'project-board', selectedBoardId: 'gallery-board' };

  it('uses the current Gallery selection in Auto mode', () => {
    expect(resolveInvocationGalleryBoardId(undefined, galleryValues)).toBe('gallery-board');
    expect(resolveInvocationGalleryBoardId('auto', galleryValues)).toBe('gallery-board');
    expect(resolveInvocationGalleryBoardId('auto', { ...galleryValues, selectedBoardId: 'later-board' })).toBe(
      'later-board'
    );
  });

  it('sends explicit None to Uncategorized even when a project board exists', () => {
    expect(resolveInvocationGalleryBoardId('none', galleryValues)).toBe('none');
  });

  it('keeps an explicitly selected board when Gallery changes', () => {
    expect(resolveInvocationGalleryBoardId('target-board', galleryValues)).toBe('target-board');
  });

  it('keeps existing date-board fallback and new-project fallback in Auto mode', () => {
    expect(resolveInvocationGalleryBoardId('auto', { ...galleryValues, selectedBoardId: 'by_date:2026-09-24' })).toBe(
      'project-board'
    );
    expect(resolveInvocationGalleryBoardId('auto', {})).toBeNull();
  });
});
