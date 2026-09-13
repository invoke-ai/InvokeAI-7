import type { GalleryImageItem } from '@features/gallery/core/items';

import { describe, expect, it } from 'vitest';

import type { GalleryQueuePlaceholder } from './galleryStateView';

import {
  buildGalleryGridNavigation,
  buildGalleryGridRows,
  getGalleryGridNavigationStep,
  GALLERY_GRID_GAP_PX,
  GALLERY_STARRED_HEADER_HEIGHT_PX,
  GALLERY_STARRED_SEPARATOR_HEIGHT_PX,
  getGalleryCellSizePx,
  getGalleryColumnCount,
  getGalleryColumnCountForCell,
  getGalleryGridRowHeightPx,
  getGalleryGridRowIndexForItem,
} from './galleryGridLayout';

const createImageItem = (name: string, starred = false): GalleryImageItem => ({
  boardId: 'none',
  category: 'general',
  createdAt: '2026-06-09T00:00:00.000Z',
  fullUrl: `/api/v1/images/i/${name}/full`,
  height: 768,
  isIntermediate: false,
  kind: 'image',
  name,
  starred,
  thumbnailUrl: `/api/v1/images/i/${name}/thumbnail`,
  width: 512,
});

const createPlaceholder = (id: string): GalleryQueuePlaceholder => ({
  backendItemId: null,
  boardId: 'none',
  height: 1024,
  id,
  itemIndex: 0,
  queueItemId: `queue-${id}`,
  width: 1024,
});

const buildRows = (overrides: Partial<Parameters<typeof buildGalleryGridRows>[0]> = {}) =>
  buildGalleryGridRows({
    columnCount: 2,
    imageOrderDir: 'DESC',
    isStarredOpen: true,
    items: [],
    pendingPlaceholders: [],
    starredItems: [],
    starredTotal: 0,
    ...overrides,
  });

const cellNames = (rows: ReturnType<typeof buildRows>): string[][] =>
  rows.flatMap((row) =>
    row.kind === 'cells'
      ? [row.cells.map((cell) => (cell.kind === 'item' ? cell.item.name : `placeholder:${cell.placeholder.id}`))]
      : []
  );

describe('getGalleryColumnCountForCell', () => {
  it('rounds to the nearest whole cell and clamps to the caller bounds', () => {
    const bounds = { max: 8, min: 3, targetCellPx: 72 };

    expect(getGalleryColumnCountForCell({ ...bounds, widthPx: 320 })).toBe(4);
    expect(getGalleryColumnCountForCell({ ...bounds, widthPx: 120 })).toBe(3);
    expect(getGalleryColumnCountForCell({ ...bounds, widthPx: 2000 })).toBe(8);
  });

  it('falls back to the minimum before the width is measured', () => {
    expect(getGalleryColumnCountForCell({ max: 8, min: 3, targetCellPx: 72, widthPx: 0 })).toBe(3);
  });
});

describe('getGalleryColumnCount', () => {
  it('gives the same answer at the same width regardless of placement', () => {
    // The whole point of measuring rather than branching on layout: a 600px
    // gallery is a 600px gallery whether it sits in a panel or the center.
    const stacked = getGalleryColumnCount({ imageDensityPercent: 50, widthPx: 600 });
    const wide = getGalleryColumnCount({ imageDensityPercent: 50, widthPx: 600 });

    expect(stacked).toBe(wide);
  });

  it('fits more columns as the viewport grows', () => {
    const narrow = getGalleryColumnCount({ imageDensityPercent: 50, widthPx: 360 });
    const roomy = getGalleryColumnCount({ imageDensityPercent: 50, widthPx: 1200 });

    expect(roomy).toBeGreaterThan(narrow);
  });

  it('fits more columns as density rises', () => {
    const sparse = getGalleryColumnCount({ imageDensityPercent: 0, widthPx: 800 });
    const dense = getGalleryColumnCount({ imageDensityPercent: 100, widthPx: 800 });

    expect(dense).toBeGreaterThan(sparse);
  });

  it('clamps to a usable range at both extremes', () => {
    expect(getGalleryColumnCount({ imageDensityPercent: 100, widthPx: 40 })).toBe(2);
    expect(getGalleryColumnCount({ imageDensityPercent: 100, widthPx: 8000 })).toBe(12);
    expect(getGalleryColumnCount({ imageDensityPercent: 0, widthPx: 8000 })).toBe(12);
  });

  it('ignores out-of-range density instead of producing a nonsense count', () => {
    expect(getGalleryColumnCount({ imageDensityPercent: -50, widthPx: 800 })).toBe(
      getGalleryColumnCount({ imageDensityPercent: 0, widthPx: 800 })
    );
    expect(getGalleryColumnCount({ imageDensityPercent: 500, widthPx: 800 })).toBe(
      getGalleryColumnCount({ imageDensityPercent: 100, widthPx: 800 })
    );
  });

  it('falls back to the minimum before the viewport has been measured', () => {
    expect(getGalleryColumnCount({ imageDensityPercent: 50, widthPx: 0 })).toBe(2);
  });
});

describe('getGalleryCellSizePx', () => {
  it('divides the width evenly after removing the inter-column gaps', () => {
    expect(getGalleryCellSizePx({ columnCount: 4, widthPx: 400 + GALLERY_GRID_GAP_PX * 3 })).toBe(100);
  });

  it('uses a plausible square before measurement so the first paint is not zero-height', () => {
    expect(getGalleryCellSizePx({ columnCount: 4, widthPx: 0 })).toBe(96);
  });

  it('never returns a non-positive size when the width is smaller than the gaps', () => {
    expect(getGalleryCellSizePx({ columnCount: 12, widthPx: 4 })).toBeGreaterThan(0);
  });
});

describe('buildGalleryGridRows', () => {
  it('chunks plain items into rows of the column count with no section chrome', () => {
    const rows = buildRows({ items: ['a', 'b', 'c'].map((name) => createImageItem(name)) });

    expect(rows.map((row) => row.kind)).toEqual(['cells', 'cells']);
    expect(rows[0]?.kind === 'cells' && rows[0].cells.length).toBe(2);
    expect(rows[1]?.kind === 'cells' && rows[1].cells.length).toBe(1);
  });

  it('puts the starred strip in a header-led section above the unstarred listing', () => {
    const starred = createImageItem('starred-1', true);
    const rows = buildRows({
      items: [createImageItem('regular-1'), createImageItem('regular-2')],
      starredItems: [starred],
      starredTotal: 1,
    });

    expect(rows.map((row) => row.kind)).toEqual(['starred-header', 'cells', 'starred-gap', 'cells']);
    expect(rows[0]?.kind === 'starred-header' && rows[0]).toMatchObject({ shownCount: 1, total: 1 });
    expect(rows[1]?.kind === 'cells' && rows[1].section).toBe('starred');
    expect(rows[2]?.kind === 'starred-gap' && rows[2].withSeparator).toBe(true);
    expect(rows[3]?.kind === 'cells' && rows[3].section).toBe('regular');
    expect(cellNames(rows)).toEqual([['starred-1'], ['regular-1', 'regular-2']]);
  });

  it('caps the strip at three rows of the current column count and reports the backend total', () => {
    const starredItems = Array.from({ length: 7 }, (_, index) => createImageItem(`starred-${index}`, true));
    const rows = buildRows({ starredItems, starredTotal: 9 });

    expect(rows[0]?.kind === 'starred-header' && rows[0]).toMatchObject({ shownCount: 6, total: 9 });
    expect(rows.filter((row) => row.kind === 'cells' && row.section === 'starred')).toHaveLength(3);
    expect(cellNames(rows).flat()).not.toContain('starred-6');
  });

  it('renders no chrome when the strip is empty', () => {
    const rows = buildRows({ items: [createImageItem('starred-1', true)], starredItems: [], starredTotal: 0 });

    expect(rows.map((row) => row.kind)).toEqual(['cells']);
  });

  it('keeps the header but drops the starred rows and the separator while collapsed', () => {
    const starred = createImageItem('starred-1', true);
    const rows = buildRows({
      isStarredOpen: false,
      items: [createImageItem('regular-1')],
      starredItems: [starred],
      starredTotal: 1,
    });

    expect(rows.map((row) => row.kind)).toEqual(['starred-header', 'starred-gap', 'cells']);
    expect(rows[0]?.kind === 'starred-header' && rows[0]).toMatchObject({ shownCount: 0, total: 1 });
    expect(rows[1]?.kind === 'starred-gap' && rows[1].withSeparator).toBe(false);
  });

  it('keeps regular row keys stable across a starred collapse so their cells are not recreated', () => {
    const starred = createImageItem('starred-1', true);
    const input = {
      items: [createImageItem('regular-1'), createImageItem('regular-2')],
      starredItems: [starred],
      starredTotal: 1,
    };
    const regularKeys = (rows: ReturnType<typeof buildRows>) =>
      rows.filter((row) => row.kind === 'cells' && row.section === 'regular').map((row) => row.key);

    expect(regularKeys(buildRows({ ...input, isStarredOpen: false }))).toEqual(regularKeys(buildRows(input)));
  });

  it('gives every row a unique key across the header, strip, gap, placeholder, and listing rows', () => {
    const starred = createImageItem('starred-1', true);
    const rows = buildRows({
      items: [createImageItem('regular-1'), createImageItem('regular-2')],
      pendingPlaceholders: [createPlaceholder('slot-1')],
      starredItems: [starred],
      starredTotal: 1,
    });
    const keys = rows.map((row) => row.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('slots placeholders ahead of regular items for newest-first ordering and after them otherwise', () => {
    const items = [createImageItem('regular-1')];
    const pendingPlaceholders = [createPlaceholder('slot-1')];

    const newestFirst = buildRows({ items, pendingPlaceholders });
    expect(newestFirst[0]?.kind === 'cells' && newestFirst[0].cells[0]?.kind).toBe('placeholder');

    const oldestFirst = buildRows({ imageOrderDir: 'ASC', items, pendingPlaceholders });
    expect(oldestFirst[0]?.kind === 'cells' && oldestFirst[0].cells[0]?.kind).toBe('item');
  });

  it('numbers cells continuously from the strip into the listing, matching the navigation list', () => {
    const starred = createImageItem('starred-1', true);
    const input = {
      columnCount: 2,
      items: [createImageItem('regular-1'), createImageItem('regular-2')],
      starredItems: [starred, createImageItem('starred-2', true)],
    };
    const openRows = buildRows({ ...input, starredTotal: 2 });
    const openNavigation = buildGalleryGridNavigation({ ...input, isStarredOpen: true });
    const indices = (rows: ReturnType<typeof buildRows>) =>
      rows.flatMap((row) =>
        row.kind === 'cells' ? row.cells.map((cell) => (cell.kind === 'item' ? cell.itemIndex : -1)) : []
      );

    expect(indices(openRows)).toEqual([0, 1, 2, 3]);
    expect(openNavigation.items.map((item) => item.name)).toEqual(['starred-1', 'starred-2', 'regular-1', 'regular-2']);
    expect(openNavigation.regularStart).toBe(2);

    const collapsedNavigation = buildGalleryGridNavigation({ ...input, isStarredOpen: false });
    expect(indices(buildRows({ ...input, isStarredOpen: false, starredTotal: 2 }))).toEqual([0, 1]);
    expect(collapsedNavigation).toEqual({ items: input.items, regularStart: 0 });
  });
});

describe('getGalleryGridNavigationStep', () => {
  // Five starred items at three columns: a full strip row plus a partial one
  // above four listing items.
  const navigation = buildGalleryGridNavigation({
    columnCount: 3,
    isStarredOpen: true,
    items: ['r0', 'r1', 'r2', 'r3'].map((name) => createImageItem(name)),
    starredItems: ['s0', 's1', 's2', 's3', 's4'].map((name) => createImageItem(name, true)),
  });
  const step = (from: number, direction: 'down' | 'left' | 'right' | 'up') =>
    getGalleryGridNavigationStep(navigation, 3, from, direction);

  it('keeps the column when stepping down across the seam past a partial strip row', () => {
    // s4 sits alone on the strip's second row (column 1); the cell below it is r1.
    expect(step(4, 'down')).toBe(5 + 1);
    // s1 (row 0, column 1) steps onto s4 (row 1, column 1).
    expect(step(1, 'down')).toBe(4);
    // s2 (row 0, column 2) has no cell below in the partial row; it lands on the row's last cell.
    expect(step(2, 'down')).toBe(4);
  });

  it('keeps the column when stepping up into the strip', () => {
    // r2 (listing row 0, column 2) goes to the strip's last row, clamped to its last cell s4.
    expect(step(5 + 2, 'up')).toBe(4);
    // r0 (column 0) goes to s3.
    expect(step(5, 'up')).toBe(3);
  });

  it('walks the flat sequence left and right and stays put at the edges', () => {
    expect(step(4, 'right')).toBe(5);
    expect(step(5, 'left')).toBe(4);
    expect(step(0, 'left')).toBe(0);
    expect(step(0, 'up')).toBe(0);
    expect(step(8, 'right')).toBe(8);
    expect(step(8, 'down')).toBe(8);
    expect(step(5, 'down')).toBe(8);
  });
});

describe('getGalleryGridRowHeightPx', () => {
  it('sizes chrome rows by their own constants and cell rows by the shared row height', () => {
    const starred = createImageItem('starred-1', true);
    const items = { items: [createImageItem('regular-1')], starredItems: [starred], starredTotal: 1 };

    expect(buildRows(items).map((row) => getGalleryGridRowHeightPx(row, 100))).toEqual([
      GALLERY_STARRED_HEADER_HEIGHT_PX,
      100,
      GALLERY_STARRED_SEPARATOR_HEIGHT_PX,
      100,
    ]);
    expect(buildRows({ ...items, isStarredOpen: false }).map((row) => getGalleryGridRowHeightPx(row, 100))).toEqual([
      GALLERY_STARRED_HEADER_HEIGHT_PX,
      GALLERY_GRID_GAP_PX,
      100,
    ]);
  });
});

describe('getGalleryGridRowIndexForItem', () => {
  it('finds the row holding a navigation index, across sections', () => {
    const starred = createImageItem('starred-1', true);
    const rows = buildRows({
      items: [createImageItem('regular-1'), createImageItem('regular-2'), createImageItem('regular-3')],
      starredItems: [starred],
      starredTotal: 1,
    });

    expect(getGalleryGridRowIndexForItem(rows, 0)).toBe(1);
    expect(getGalleryGridRowIndexForItem(rows, 1)).toBe(3);
    expect(getGalleryGridRowIndexForItem(rows, 3)).toBe(4);
    expect(getGalleryGridRowIndexForItem(rows, 99)).toBe(-1);
  });
});
