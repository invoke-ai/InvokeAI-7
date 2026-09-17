import type { GalleryBoard, GalleryImage, GalleryOrderDir, GalleryView } from '@features/gallery/core/types';

import {
  legacyGeneratedImageToGalleryItem,
  toGalleryItemKey,
  type GalleryItem,
  type GalleryItemKey,
} from '@features/gallery/core/items';
import { getBoundedRecentImages } from '@features/gallery/core/recentImages';
import {
  getPersistedSelectedGalleryItemKeys,
  getSelectedGalleryImageFromValues,
  getSelectedGalleryItemFromValues,
} from '@features/gallery/core/selection';
import {
  parseGallerySemanticReference,
  type GallerySemanticReference,
} from '@features/gallery/core/semanticImageQuery';
import { getGallerySettings, type GallerySettings } from '@features/gallery/core/settings';

/**
 * Stand-in shown before any board has loaded. `name` is intentionally empty:
 * the UI labels uncategorized boards from `kind` through `getGalleryBoardLabel`,
 * so there is no English string to invent here.
 */
const UNCATEGORIZED_BOARD: GalleryBoard = {
  archived: false,
  assetCount: 0,
  assetVideoCount: 0,
  id: 'none',
  imageCount: 0,
  kind: 'uncategorized',
  name: '',
  projectId: null,
  videoCount: 0,
};

export interface GalleryStateView {
  /**
   * Page the infinite window starts at, when a reveal has anchored it
   * mid-board; 0 whenever the window covers the top of the listing (always so
   * in paginated mode). Non-zero means the grid cannot scroll above its first
   * row, so the surface owes the user both an explanation and a way back.
   */
  anchoredWindowPage: number;
  boards: GalleryBoard[];
  compareImageKey: GalleryItemKey | null;
  galleryView: GalleryView;
  /** A compare image is set and differs from the visible image selection. */
  isComparisonActive: boolean;
  items: GalleryItem[];
  isLoading: boolean;
  /** The grid's current page in paginated mode; the window anchor otherwise. */
  page: number;
  projectBoardId: string | null;
  /**
   * The selection's stamped paginated page, when the stamp names the listing
   * the grid is showing; null otherwise. Reveals follow it across pages.
   */
  revealTargetPage: number | null;
  searchTerm: string;
  selectedBoardId: string;
  selectedItemKey: GalleryItemKey | null;
  selectedItemKeys: GalleryItemKey[];
  /** Active image-similarity query, rendered as a chip in place of the search text. */
  semanticImageQuery: GallerySemanticReference | null;
  settings: GallerySettings;
  /** The listing is restricted to starred items. */
  starredOnly: boolean;
}

export const getGalleryView = (values: Record<string, unknown>): GalleryView =>
  values.galleryView === 'assets' ? 'assets' : 'images';

export const getGallerySearchTerm = (values: Record<string, unknown>): string =>
  typeof values.searchTerm === 'string' ? values.searchTerm : '';

/** The starred-only listing filter; a session value kept beside `searchTerm`. */
export const getGalleryStarredOnly = (values: Record<string, unknown>): boolean => values.starredOnly === true;

export const getGallerySemanticImageQuery = (values: Record<string, unknown>): GallerySemanticReference | null =>
  parseGallerySemanticReference(values.semanticImageQuery);

/** The saved board choice as persisted, before any resolution against loaded boards. */
export const getGalleryRawSelectedBoardId = (values: Record<string, unknown>): string | null =>
  typeof values.selectedBoardId === 'string' ? values.selectedBoardId : null;

/**
 * Where new results land, resolved against the boards this install actually has.
 *
 * A saved selection survives whenever it still resolves, since it is a deliberate choice. When it
 * does not — a project from another install, or one whose pre-migration board was ambiguous — the
 * project's own board beats Uncategorized, which would quietly scatter that project's output. No
 * saved selection at all is the same case rather than a choice of Uncategorized.
 *
 * An empty board list means "still loading", not "no such board", so nothing resolves yet.
 */
export const resolveGallerySelectedBoardId = (
  { projectBoardId, selectedBoardId }: { projectBoardId: string | null; selectedBoardId: string | null },
  backendBoards: GalleryBoard[]
): string => {
  if (backendBoards.length === 0) {
    return selectedBoardId ?? 'none';
  }

  if (selectedBoardId !== null && backendBoards.some((board) => board.id === selectedBoardId)) {
    return selectedBoardId;
  }

  if (projectBoardId !== null && backendBoards.some((board) => board.id === projectBoardId)) {
    return projectBoardId;
  }

  return 'none';
};

export const getGallerySelectedBoardId = (values: Record<string, unknown>, backendBoards: GalleryBoard[]): string =>
  resolveGallerySelectedBoardId(
    { projectBoardId: getGalleryProjectBoardId(values), selectedBoardId: getGalleryRawSelectedBoardId(values) },
    backendBoards
  );

export const getGalleryPage = (values: Record<string, unknown>): number =>
  typeof values.galleryPage === 'number' && Number.isFinite(values.galleryPage)
    ? Math.max(0, Math.floor(values.galleryPage))
    : 0;

export const getGallerySelectedImagePage = (values: Record<string, unknown>): number =>
  typeof values.selectedImagePage === 'number' && Number.isFinite(values.selectedImagePage)
    ? Math.max(0, Math.floor(values.selectedImagePage))
    : getGalleryPage(values);

export interface GallerySelectedImageQuery {
  boardId: string;
  galleryView: GalleryView;
  imageOrderDir: GalleryOrderDir;
  page: number;
  paginationMode: 'infinite' | 'paginated';
  searchTerm: string;
  starredOnly: boolean;
}

export const getGallerySelectedImageQuery = (values: Record<string, unknown>): GallerySelectedImageQuery => {
  const query =
    values.selectedImageQuery && typeof values.selectedImageQuery === 'object'
      ? (values.selectedImageQuery as Partial<GallerySelectedImageQuery>)
      : null;
  const settings = getGallerySettings(values);

  return {
    boardId:
      query && typeof query.boardId === 'string'
        ? query.boardId
        : typeof values.selectedBoardId === 'string'
          ? values.selectedBoardId
          : 'none',
    galleryView:
      query?.galleryView === 'assets' || query?.galleryView === 'images'
        ? query.galleryView
        : values.galleryView === 'assets'
          ? 'assets'
          : 'images',
    imageOrderDir:
      query?.imageOrderDir === 'ASC' || query?.imageOrderDir === 'DESC' ? query.imageOrderDir : settings.imageOrderDir,
    page:
      query && typeof query.page === 'number' && Number.isFinite(query.page)
        ? Math.max(0, Math.floor(query.page))
        : getGallerySelectedImagePage(values),
    paginationMode:
      query?.paginationMode === 'infinite' || query?.paginationMode === 'paginated'
        ? query.paginationMode
        : settings.paginationMode,
    searchTerm: query && typeof query.searchTerm === 'string' ? query.searchTerm : String(values.searchTerm ?? ''),
    starredOnly: query && typeof query.starredOnly === 'boolean' ? query.starredOnly : getGalleryStarredOnly(values),
  };
};

export const getGalleryTotalImages = (values: Record<string, unknown>): number | null =>
  typeof values.galleryTotalImages === 'number' && Number.isFinite(values.galleryTotalImages)
    ? Math.max(0, values.galleryTotalImages)
    : null;

export const getGalleryProjectBoardId = (values: Record<string, unknown>): string | null =>
  typeof values.projectBoardId === 'string' ? values.projectBoardId : null;

export const getGalleryCompareImage = (values: Record<string, unknown>): GalleryImage | null =>
  getSelectedGalleryImageFromValues({
    selectedBoardId: values.selectedBoardId,
    selectedImage: values.compareImage,
    selectedImageName: null,
  });

export const getGalleryStateView = (
  values: Record<string, unknown>,
  backendBoards: GalleryBoard[],
  backendItems: GalleryItem[] | null,
  isLoading: boolean
): GalleryStateView => {
  const localItems = getBoundedRecentImages(values.recentImages).map(legacyGeneratedImageToGalleryItem);
  const items = backendItems ?? (isLoading ? [] : localItems);
  const selectedItem = getSelectedGalleryItemFromValues(values);
  const persistedSelectedItemKey =
    typeof values.selectedImageName === 'string'
      ? (getPersistedSelectedGalleryItemKeys({ selectedImageName: values.selectedImageName })[0] ?? null)
      : selectedItem
        ? toGalleryItemKey(selectedItem)
        : null;
  const visibleSelectedItemKey =
    persistedSelectedItemKey && items.some((item) => toGalleryItemKey(item) === persistedSelectedItemKey)
      ? persistedSelectedItemKey
      : null;
  const selectedItemKeys = getPersistedSelectedGalleryItemKeys(values);
  const galleryView = getGalleryView(values);
  const settings = getGallerySettings(values);
  const searchTerm = getGallerySearchTerm(values);
  const starredOnly = getGalleryStarredOnly(values);
  const boards = backendBoards.length
    ? backendBoards
    : [
        {
          ...UNCATEGORIZED_BOARD,
          assetVideoCount: items.filter((item) => item.kind === 'video' && item.category !== 'general').length,
          imageCount: items.filter((item) => item.kind === 'image' && item.category === 'general').length,
          projectId: null,
          videoCount: items.filter((item) => item.kind === 'video').length,
        },
      ];
  const selectedBoardId = getGallerySelectedBoardId(values, backendBoards);
  const compareImage = getGalleryCompareImage(values);
  const compareImageKey = compareImage ? toGalleryItemKey({ kind: 'image', name: compareImage.imageName }) : null;
  const isComparisonActive =
    visibleSelectedItemKey?.startsWith('image:') === true &&
    compareImageKey !== null &&
    compareImageKey !== visibleSelectedItemKey;
  const semanticImageQuery = getGallerySemanticImageQuery(values);
  const page = getGalleryPage(values);
  const isAnchoredInfiniteWindow = settings.paginationMode === 'infinite' && page > 0;
  const selectedImageQuery = getGallerySelectedImageQuery(values);
  const revealTargetPage =
    settings.paginationMode === 'paginated' &&
    selectedImageQuery.paginationMode === 'paginated' &&
    semanticImageQuery === null &&
    selectedImageQuery.boardId === selectedBoardId &&
    selectedImageQuery.galleryView === galleryView &&
    selectedImageQuery.imageOrderDir === settings.imageOrderDir &&
    selectedImageQuery.searchTerm === searchTerm &&
    selectedImageQuery.starredOnly === starredOnly &&
    // A starred item lives in the strip, never on a page of the unstarred
    // listing; Preview stamps its starred-list page, which the grid must not follow.
    (starredOnly || selectedItem?.starred !== true)
      ? selectedImageQuery.page
      : null;

  return {
    anchoredWindowPage: isAnchoredInfiniteWindow ? page : 0,
    boards,
    compareImageKey,
    galleryView,
    isComparisonActive,
    items,
    isLoading,
    page,
    projectBoardId: getGalleryProjectBoardId(values),
    revealTargetPage,
    searchTerm,
    selectedBoardId,
    selectedItemKey: visibleSelectedItemKey,
    selectedItemKeys:
      visibleSelectedItemKey && !selectedItemKeys.includes(visibleSelectedItemKey)
        ? [visibleSelectedItemKey, ...selectedItemKeys]
        : selectedItemKeys,
    semanticImageQuery,
    settings,
    starredOnly,
  };
};

export const getBoardCounts = (
  board: GalleryBoard
): { assetCount: number; assetVideoCount: number; imageCount: number; videoCount: number } => ({
  assetCount: board.assetCount,
  assetVideoCount: board.assetVideoCount,
  imageCount: board.imageCount,
  videoCount: board.videoCount,
});
