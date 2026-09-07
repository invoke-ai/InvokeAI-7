import type { GalleryItem } from '@features/gallery/core/items';
import type { GalleryOrderDir } from '@features/gallery/core/types';

import { toGalleryItemKey } from '@features/gallery/core/items';

import type { GalleryQueuePlaceholder } from './galleryStateView';

import { getGalleryPlaceholderInsertionIndex } from './galleryStateView';

export const GALLERY_GRID_GAP_PX = 4;
export const GALLERY_STARRED_HEADER_HEIGHT_PX = 24;
/** The gap row grows to hold a hairline rule while the starred section is open. */
export const GALLERY_STARRED_SEPARATOR_HEIGHT_PX = 13;

const GALLERY_MIN_COLUMN_COUNT = 2;
const GALLERY_MAX_COLUMN_COUNT = 12;

/** Cell size the density slider interpolates between: 0% is largest, 100% smallest. */
const GALLERY_MAX_CELL_PX = 192;
const GALLERY_MIN_CELL_PX = 48;

/**
 * Density picks a target thumbnail size, and the available width decides how
 * many of those fit.
 *
 * Keying off width rather than placement is what lets the two layouts share
 * one grid: at equal pixel width the same density produces the same columns
 * whether the gallery sits in a side panel or the center. The old
 * layout-keyed maximum meant 50% density meant ~90px cells stacked and ~200px
 * cells wide.
 */
export const getGalleryTargetCellPx = (imageDensityPercent: number): number => {
  const percent = Math.min(100, Math.max(0, imageDensityPercent));

  return GALLERY_MAX_CELL_PX - ((GALLERY_MAX_CELL_PX - GALLERY_MIN_CELL_PX) * percent) / 100;
};

/** How many `targetCellPx` cells fit in `widthPx`, clamped; an unmeasured width yields `min`. */
export const getGalleryColumnCountForCell = ({
  max,
  min,
  targetCellPx,
  widthPx,
}: {
  max: number;
  min: number;
  targetCellPx: number;
  widthPx: number;
}): number => (widthPx <= 0 ? min : Math.min(max, Math.max(min, Math.round(widthPx / targetCellPx))));

export const getGalleryColumnCount = ({
  imageDensityPercent,
  widthPx,
}: {
  imageDensityPercent: number;
  widthPx: number;
}): number =>
  getGalleryColumnCountForCell({
    max: GALLERY_MAX_COLUMN_COUNT,
    min: GALLERY_MIN_COLUMN_COUNT,
    targetCellPx: getGalleryTargetCellPx(imageDensityPercent),
    widthPx,
  });

/** Falls back to a plausible square before the viewport has been measured. */
export const getGalleryCellSizePx = ({ columnCount, widthPx }: { columnCount: number; widthPx: number }): number =>
  widthPx > 0 ? Math.max(1, (widthPx - GALLERY_GRID_GAP_PX * (columnCount - 1)) / columnCount) : 96;

export type GalleryGridCell =
  | { kind: 'item'; item: GalleryItem; itemIndex: number }
  | { kind: 'placeholder'; placeholder: GalleryQueuePlaceholder };

export type GalleryGridSection = 'regular' | 'starred';

export type GalleryGridRow =
  | { cells: GalleryGridCell[]; key: string; kind: 'cells'; section: GalleryGridSection }
  | { key: string; kind: 'starred-gap'; withSeparator: boolean }
  | { key: string; kind: 'starred-header'; shownCount: number; total: number };

/** The starred strip shows at most this many rows at the current column count. */
const GALLERY_STARRED_STRIP_MAX_ROWS = 3;

const getGalleryStarredStripItems = (starredItems: readonly GalleryItem[], columnCount: number): GalleryItem[] =>
  starredItems.slice(0, GALLERY_STARRED_STRIP_MAX_ROWS * columnCount);

/**
 * The keyboard and scroll index space: the shown strip cells first, then the
 * listing. The grid is unstarred-only, so no item occurs twice.
 */
export interface GalleryGridNavigation {
  items: GalleryItem[];
  regularStart: number;
}

export const buildGalleryGridNavigation = ({
  columnCount,
  isStarredOpen,
  items,
  starredItems,
}: {
  columnCount: number;
  isStarredOpen: boolean;
  items: readonly GalleryItem[];
  starredItems: readonly GalleryItem[];
}): GalleryGridNavigation => {
  const stripItems = isStarredOpen ? getGalleryStarredStripItems(starredItems, columnCount) : [];

  return { items: [...stripItems, ...items], regularStart: stripItems.length };
};

/**
 * Every item the grid has on hand — strip first, then the listing. The two
 * refetch independently, so an item can sit on both sides for a moment.
 */
export const mergeGalleryLoadedItems = (
  starredItems: readonly GalleryItem[],
  items: readonly GalleryItem[]
): GalleryItem[] => {
  if (starredItems.length === 0) {
    return items as GalleryItem[];
  }

  const seen = new Set(starredItems.map(toGalleryItemKey));

  return [...starredItems, ...items.filter((item) => !seen.has(toGalleryItemKey(item)))];
};

export type GalleryGridNavDirection = 'down' | 'left' | 'right' | 'up';

/**
 * The next navigation index for an arrow key. Left/right walk the flat
 * sequence; up/down move by visual row, and each section chunks its own rows,
 * so a step across the seam keeps its column instead of drifting by the
 * strip's partial last row. Clamped within each section's rows and to the
 * ends of the sequence; a move that has nowhere to go returns `fromIndex`.
 */
export const getGalleryGridNavigationStep = (
  { items, regularStart }: GalleryGridNavigation,
  columnCount: number,
  fromIndex: number,
  direction: GalleryGridNavDirection
): number => {
  const lastIndex = items.length - 1;

  if (direction === 'left' || direction === 'right') {
    return Math.min(lastIndex, Math.max(0, fromIndex + (direction === 'right' ? 1 : -1)));
  }

  const stripRowCount = Math.ceil(regularStart / columnCount);
  const listingCount = items.length - regularStart;
  const listingRowCount = Math.ceil(listingCount / columnCount);
  const sectionIndex = fromIndex < regularStart ? fromIndex : fromIndex - regularStart;
  const row = (fromIndex < regularStart ? 0 : stripRowCount) + Math.floor(sectionIndex / columnCount);
  const column = sectionIndex % columnCount;
  const targetRow = row + (direction === 'down' ? 1 : -1);

  if (targetRow < 0 || targetRow >= stripRowCount + listingRowCount) {
    return fromIndex;
  }

  if (targetRow < stripRowCount) {
    return Math.min(regularStart - 1, targetRow * columnCount + column);
  }

  return Math.min(lastIndex, regularStart + (targetRow - stripRowCount) * columnCount + column);
};

const getGalleryGridCellKey = (cell: GalleryGridCell): string =>
  cell.kind === 'placeholder' ? `placeholder:${cell.placeholder.id}` : toGalleryItemKey(cell.item);

/**
 * Rows are keyed by their leading cell rather than their index so that
 * structural changes above a row (collapsing the starred section, a
 * placeholder resolving) move the row without recreating it: the virtualizer
 * and React both track the row by key, so its thumbnails keep their DOM.
 */
const chunkGalleryCellsIntoRows = (
  cells: GalleryGridCell[],
  columnCount: number,
  section: GalleryGridSection
): GalleryGridRow[] => {
  const rows: GalleryGridRow[] = [];

  for (let index = 0; index < cells.length; index += columnCount) {
    const rowCells = cells.slice(index, index + columnCount);

    rows.push({
      cells: rowCells,
      key: `${section}:${getGalleryGridCellKey(rowCells[0]!)}`,
      kind: 'cells',
      section,
    });
  }

  return rows;
};

/**
 * The grid's row model in one pure pass: the bounded starred strip gets a
 * disclosure section above the listing, the listing chunks in order, and
 * placeholders slot in where their images will land. Cell indices follow
 * `buildGalleryGridNavigation`.
 */
export const buildGalleryGridRows = ({
  columnCount,
  imageOrderDir,
  isStarredOpen,
  items,
  pendingPlaceholders,
  starredItems,
  starredTotal,
}: {
  columnCount: number;
  imageOrderDir: GalleryOrderDir;
  isStarredOpen: boolean;
  items: readonly GalleryItem[];
  pendingPlaceholders: readonly GalleryQueuePlaceholder[];
  starredItems: readonly GalleryItem[];
  starredTotal: number;
}): GalleryGridRow[] => {
  const stripItems = getGalleryStarredStripItems(starredItems, columnCount);
  const shownCount = isStarredOpen ? stripItems.length : 0;
  const starredCells: GalleryGridCell[] = stripItems.map((item, itemIndex) => ({ item, itemIndex, kind: 'item' }));
  const regularItemCells: GalleryGridCell[] = items.map((item, index) => ({
    item,
    itemIndex: shownCount + index,
    kind: 'item',
  }));
  const placeholderCells: GalleryGridCell[] = pendingPlaceholders.map((placeholder) => ({
    kind: 'placeholder',
    placeholder,
  }));
  const placeholderInsertionIndex = getGalleryPlaceholderInsertionIndex(items.length, imageOrderDir);
  const regularCells = [
    ...regularItemCells.slice(0, placeholderInsertionIndex),
    ...placeholderCells,
    ...regularItemCells.slice(placeholderInsertionIndex),
  ];
  const rows: GalleryGridRow[] = [];

  if (stripItems.length > 0) {
    rows.push({ key: 'starred-header', kind: 'starred-header', shownCount, total: starredTotal });

    if (isStarredOpen) {
      rows.push(...chunkGalleryCellsIntoRows(starredCells, columnCount, 'starred'));
    }

    if (regularCells.length > 0) {
      // A visible rule only while the starred cells are showing; collapsed, the
      // header already separates the sections.
      rows.push({ key: 'starred-gap', kind: 'starred-gap', withSeparator: isStarredOpen });
    }
  }

  rows.push(...chunkGalleryCellsIntoRows(regularCells, columnCount, 'regular'));

  return rows;
};

/** `cellRowHeightPx` is the thumbnail row height including its trailing gap. */
export const getGalleryGridRowHeightPx = (row: GalleryGridRow, cellRowHeightPx: number): number => {
  if (row.kind === 'starred-header') {
    return GALLERY_STARRED_HEADER_HEIGHT_PX;
  }

  if (row.kind === 'starred-gap') {
    return row.withSeparator ? GALLERY_STARRED_SEPARATOR_HEIGHT_PX : GALLERY_GRID_GAP_PX;
  }

  return cellRowHeightPx;
};

export const getGalleryGridRowIndexForItem = (rows: GalleryGridRow[], itemIndex: number): number =>
  rows.findIndex(
    (row) => row.kind === 'cells' && row.cells.some((cell) => cell.kind === 'item' && cell.itemIndex === itemIndex)
  );
