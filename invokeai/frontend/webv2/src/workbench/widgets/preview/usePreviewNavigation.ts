import type { GalleryImageItem, GalleryItem, GalleryItemKey, GalleryView } from '@features/gallery';
import type {
  GalleryQueuePlaceholder,
  GalleryItemsPage,
  GallerySemanticReference,
  getGallerySelectedImageQuery,
} from '@features/gallery/contracts';
import type { QueueItem } from '@features/queue/contracts';
import type { InfiniteData } from '@tanstack/react-query';
import type { KeyboardEvent } from 'react';

import { compareGalleryItems, gallerySemanticReferenceKey, toGalleryItemKey } from '@features/gallery/contracts';
import {
  flattenGalleryItemsData,
  GALLERY_MAX_ROWS,
  GALLERY_PAGE_SIZE,
  galleryItemsInfiniteOptions,
} from '@features/gallery/queries';
import { parseDateTokens } from '@platform/search/dateTokens';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { PreviewNavigationItem } from './previewNavigation';

import {
  getPreviewNavigationCursor,
  getPreviewNavigationSequence,
  getPreviewNavigationTarget,
} from './previewNavigation';

/**
 * Everything behind the preview's left/right stepping, in one place: the board
 * items query, the local/backend merge, the sequence + cursor, the navigate
 * action with its boundary-page fetch, and the neighbor prefetch. The view
 * consumes the result; `previewNavigation.ts` keeps the pure sequence math.
 *
 * Gallery selection and the live-follow preference remain the sources of
 * truth; nothing here stores a cursor.
 */

const EMPTY_PREVIEW_ITEMS: GalleryItem[] = [];

const flattenPreviewItems = (data: InfiniteData<GalleryItemsPage, number> | undefined): GalleryItem[] =>
  flattenGalleryItemsData(data);

const getOrderedPreviewItems = (
  items: GalleryItem[],
  imageOrderDir: 'ASC' | 'DESC',
  inputOrder: 'display' | 'newest-first'
): GalleryItem[] =>
  items
    .map((item, index) => ({ index, item }))
    .sort((a, b) => {
      // Starred-first is pinned in gallery/core/settings.ts.
      const canonicalOrder = compareGalleryItems(a.item, b.item, { orderDir: imageOrderDir, starredFirst: true });

      if (canonicalOrder !== 0) {
        return canonicalOrder;
      }

      return inputOrder === 'newest-first' && imageOrderDir === 'ASC' ? b.index - a.index : a.index - b.index;
    })
    .map(({ item }) => item);

/**
 * Which gallery tab an item belongs to. Mirrors the category split the
 * gallery filters on: `general` is a gallery image, everything else (canvas
 * pixels, control layers, uploads) is an asset.
 */
const getItemGalleryView = (item: GalleryItem): GalleryView => (item.category === 'general' ? 'images' : 'assets');

const getOrderedLocalItems = ({
  boardId,
  galleryView,
  items,
  imageOrderDir,
}: {
  boardId: string;
  galleryView: GalleryView;
  items: GalleryItem[];
  imageOrderDir: 'ASC' | 'DESC';
}): GalleryItem[] =>
  getOrderedPreviewItems(
    items.filter((item) => item.boardId === boardId && getItemGalleryView(item) === galleryView),
    imageOrderDir,
    'newest-first'
  );

export const mergePreviewBoardItems = (
  backendItems: GalleryItem[],
  localItems: GalleryItem[],
  imageOrderDir: 'ASC' | 'DESC',
  { isRanked = false }: { isRanked?: boolean } = {}
): GalleryItem[] => {
  const backendKeys = new Set(backendItems.map(toGalleryItemKey));

  // Relevance order IS the list: re-sorting it by date would reorder what the
  // user is looking at, and local generations are not members of a ranked
  // result set at all (the gallery grid overlays none of them either). The
  // caller still passes the SELECTED item, which is kept when the ranking does
  // not contain it — a selection made outside the result set (an upload, an
  // image-map click, stepping off the live tile) would otherwise leave the
  // cursor pointing at nothing, which reads as both arrows going dead.
  if (isRanked) {
    const anchors = localItems.filter((item) => !backendKeys.has(toGalleryItemKey(item)));

    return [...anchors, ...backendItems].slice(0, GALLERY_MAX_ROWS);
  }

  const missingLocalItems = localItems.filter((item) => !backendKeys.has(toGalleryItemKey(item)));

  if (missingLocalItems.length === 0) {
    return backendItems.slice(0, GALLERY_MAX_ROWS);
  }

  return getOrderedPreviewItems([...backendItems, ...missingLocalItems], imageOrderDir, 'display').slice(
    0,
    GALLERY_MAX_ROWS
  );
};

export interface PreviewNavigationState {
  boardItems: GalleryItem[];
  handleNavigationKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  isLoadingBoard: boolean;
  navigate: (offset: -1 | 1) => void;
  navigationCursor: number;
  /** Identity of the backing query — the action context's filter identity. */
  navigationQueryKey: string;
  navigationSequence: PreviewNavigationItem<GalleryItem>[];
  selectPreviewItem: (item: GalleryItem) => void;
}

export const usePreviewNavigation = ({
  activePlaceholder,
  enableLiveFollow,
  imageOrderDir,
  isComparing,
  localItems,
  queueItems,
  galleryPage,
  galleryPaginationMode,
  selectGalleryItem,
  selectedImageQuery,
  selectedItem,
  selectedItemKey,
  semanticQuery,
  shouldFollowLive,
}: {
  /** The live slot from getGalleryGenerationSequence, or null. */
  activePlaceholder: GalleryQueuePlaceholder | null;
  /** Turns the live-follow preference back on (stepping onto the placeholder). */
  enableLiveFollow: () => void;
  /** The page the gallery grid is on; a ranked list mirrors it (see below). */
  galleryPage: number;
  /** The gallery's own pagination mode, likewise mirrored by a ranked list. */
  galleryPaginationMode: 'infinite' | 'paginated';
  /** The gallery's own sort settings, used while following live. */
  imageOrderDir: 'ASC' | 'DESC';
  isComparing: boolean;
  /** Recent local generations, already normalized to gallery items. */
  localItems: GalleryImageItem[];
  queueItems: QueueItem[];
  selectGalleryItem: (item: GalleryItem, selectionPage: number) => void;
  selectedImageQuery: ReturnType<typeof getGallerySelectedImageQuery>;
  selectedItem: GalleryItem | null;
  selectedItemKey: GalleryItemKey | null;
  /** The gallery's active similarity search, or null for the board listing. */
  semanticQuery: GallerySemanticReference | null;
  shouldFollowLive: boolean;
}): PreviewNavigationState => {
  const hasSelectedItem = selectedItem !== null;
  const selectedImageSearch = useMemo(
    () => parseDateTokens(selectedImageQuery.searchTerm),
    [selectedImageQuery.searchTerm]
  );
  const navigationBoardId =
    shouldFollowLive && activePlaceholder ? activePlaceholder.boardId : selectedImageQuery.boardId;
  const navigationGalleryView = shouldFollowLive ? 'images' : selectedImageQuery.galleryView;
  const navigationOrderDir = shouldFollowLive ? imageOrderDir : selectedImageQuery.imageOrderDir;
  // Read from the gallery's CURRENT search, not from a copy stamped onto the
  // selection: the chip is a view mode, and Preview has to follow it the
  // moment it is set or cleared or it walks a list that is no longer on
  // screen. Following live means watching the board a generation is landing
  // in, which no ranked result set describes, so the search is dropped for
  // that mode exactly as the board's own search term is.
  const navigationSemanticQuery = shouldFollowLive ? null : semanticQuery;
  const navigationSemanticKey = gallerySemanticReferenceKey(navigationSemanticQuery);
  const hasNavigationContext = shouldFollowLive || hasSelectedItem;
  const navigationContextKey = `${shouldFollowLive}:${selectedItemKey ?? ''}:${navigationBoardId}:${navigationGalleryView}:${navigationOrderDir}:${selectedImageQuery.paginationMode}:${selectedImageQuery.page}:${selectedImageQuery.searchTerm}:${navigationSemanticKey}`;
  const navigationQueryKey = `${shouldFollowLive}:${navigationBoardId}:${navigationGalleryView}:${navigationOrderDir}:${selectedImageQuery.paginationMode}:${selectedImageQuery.searchTerm}:${navigationSemanticKey}`;

  // Lets a boundary fetch that resolves after the user has moved on compare the
  // context it started in against the one now on screen, and drop its stale
  // result. Written from a LAYOUT effect: layout effects run synchronously
  // inside the commit, so no promise continuation can observe the new UI with
  // the old key — a passive effect leaves a post-paint gap where exactly that
  // interleaving happens. (Render-phase ref writes are rejected by the
  // compiler, and an effect event cannot be called from a promise
  // continuation.)
  const navigationContextKeyRef = useRef(navigationContextKey);

  useLayoutEffect(() => {
    navigationContextKeyRef.current = navigationContextKey;
  }, [navigationContextKey]);

  // A paginated navigation stays anchored to the page the preview opened on,
  // and re-anchors only when the underlying query identity changes. Derived
  // state rather than a ref so the compiler can see the dependency.
  const [navigationAnchor, setNavigationAnchor] = useState({
    page: selectedImageQuery.page,
    queryKey: navigationQueryKey,
  });
  const hasStaleNavigationAnchor = navigationAnchor.queryKey !== navigationQueryKey;

  if (hasStaleNavigationAnchor) {
    setNavigationAnchor({ page: selectedImageQuery.page, queryKey: navigationQueryKey });
  }

  const navigationAnchorPage = hasStaleNavigationAnchor ? selectedImageQuery.page : navigationAnchor.page;

  // A ranked list mirrors the GRID's paging instead of the stamped context.
  // The stamped page indexes the board listing, and a board page applied to a
  // ranking lands on an unrelated slice — or, past the end of a ranking that is
  // shorter than the board, on an empty one whose only member is the anchored
  // selection, leaving both arrows with nowhere to step. Setting a search also
  // resets the grid's page, which the stamped record never sees.
  const navigationWindow = shouldFollowLive
    ? ({ kind: 'infinite' } as const)
    : navigationSemanticQuery !== null
      ? galleryPaginationMode === 'paginated'
        ? ({ kind: 'anchor', offset: galleryPage * GALLERY_PAGE_SIZE } as const)
        : // In infinite mode the grid's page IS its window offset, so mirroring
          // it covers the deep-reveal case below without a separate test.
          ({ kind: 'infinite', offset: galleryPage * GALLERY_PAGE_SIZE } as const)
      : selectedImageQuery.paginationMode === 'paginated'
        ? ({ kind: 'anchor', offset: navigationAnchorPage * GALLERY_PAGE_SIZE } as const)
        : ({
            kind: 'infinite',
            // A selection deeper than the base window's reach (a deep reveal
            // from the image map) anchors navigation at its own page —
            // walking from offset 0 could never arrive at the cursor.
            offset:
              navigationAnchorPage * GALLERY_PAGE_SIZE >= GALLERY_MAX_ROWS
                ? navigationAnchorPage * GALLERY_PAGE_SIZE
                : 0,
          } as const);

  const {
    data: boardItemsData,
    fetchNextPage: fetchNextBoardItemsPage,
    fetchPreviousPage: fetchPreviousBoardItemsPage,
    hasNextPage: hasNextBoardItemsPage,
    hasPreviousPage: hasPreviousBoardItemsPage,
    isFetching: isFetchingBoardItems,
    isFetchingNextPage: isFetchingNextBoardItemsPage,
    isFetchingPreviousPage: isFetchingPreviousBoardItemsPage,
  } = useInfiniteQuery({
    ...galleryItemsInfiniteOptions(
      {
        boardId: navigationBoardId,
        createdFrom: shouldFollowLive ? undefined : selectedImageSearch.range?.from,
        createdTo: shouldFollowLive ? undefined : selectedImageSearch.range?.to,
        galleryView: navigationGalleryView,
        orderDir: navigationOrderDir,
        searchTerm: shouldFollowLive ? '' : selectedImageSearch.text,
        ...(navigationSemanticQuery ? { semanticQuery: navigationSemanticQuery } : {}),
        // Starred-first is pinned in gallery/core/settings.ts.
        starredFirst: true,
      },
      navigationWindow
    ),
    enabled: hasNavigationContext,
  });

  const selectPreviewItem = useCallback(
    (item: GalleryItem) => {
      const itemKey = toGalleryItemKey(item);
      const pageIndex = boardItemsData?.pages.findIndex((page) =>
        page.items.some((candidate) => toGalleryItemKey(candidate) === itemKey)
      );
      const pageParam = pageIndex === undefined || pageIndex < 0 ? undefined : boardItemsData?.pageParams[pageIndex];
      // `page` is stamped as a BOARD page and read as one everywhere else, so
      // a ranked window's page params — offsets into the ranking — must not be
      // written into it. Neither may the grid's own page: in paginated mode
      // the footer paginates the RANKING, so that number is a rank page too.
      // Carrying the page the preview opened on is no better — the item
      // picked out of a ranking is nowhere near the board slice it names, and
      // a deep one strands navigation there once the chip is cleared. What
      // holds in both modes is the top of the listing: setting a search and
      // clearing it both reset the grid to page 0, so that is the board
      // context a ranked session hands back.
      const selectionPage =
        navigationSemanticQuery !== null
          ? 0
          : typeof pageParam === 'number'
            ? Math.floor(pageParam / GALLERY_PAGE_SIZE)
            : selectedImageQuery.page;

      selectGalleryItem(item, selectionPage);
    },
    [boardItemsData, navigationSemanticQuery, selectGalleryItem, selectedImageQuery.page]
  );

  const optimisticQueueItemIds = useMemo(
    () =>
      new Set(
        queueItems.filter((item) => item.status === 'pending' || item.status === 'running').map((item) => item.id)
      ),
    [queueItems]
  );
  const navigationLocalItems = useMemo(() => {
    // recentImages bridges "generation finished" to "the backend list has the
    // row"; dropping a completed batch during that window made arrow keys skip
    // the images just generated. So local items stay unconditionally, except
    // where the backend window is a *subset* of the board and dedupe cannot
    // help: an active search (backend-filtered, local items are not) and
    // paginated mode (the window anchors mid-board, so settled recents would
    // splice in permanently). There, only in-flight work and the selection
    // merge.
    const hasActiveSearch =
      !shouldFollowLive && (selectedImageSearch.text.trim() !== '' || selectedImageSearch.range !== undefined);
    const isPaginatedWindow = !shouldFollowLive && selectedImageQuery.paginationMode === 'paginated';

    if (!hasActiveSearch && !isPaginatedWindow) {
      return localItems;
    }

    const refreshingSelectedSourceId =
      !shouldFollowLive && isFetchingBoardItems && selectedItem?.kind === 'image'
        ? selectedItem.sourceQueueItemId
        : null;

    return localItems.filter(
      (item) =>
        (item.sourceQueueItemId !== undefined && optimisticQueueItemIds.has(item.sourceQueueItemId)) ||
        item.sourceQueueItemId === refreshingSelectedSourceId
    );
  }, [
    isFetchingBoardItems,
    localItems,
    optimisticQueueItemIds,
    selectedImageQuery.paginationMode,
    selectedImageSearch,
    selectedItem,
    shouldFollowLive,
  ]);
  const localBoardItems = useMemo(
    () =>
      getOrderedLocalItems({
        boardId: navigationBoardId,
        galleryView: navigationGalleryView,
        items: navigationLocalItems,
        imageOrderDir: navigationOrderDir,
      }),
    [navigationBoardId, navigationGalleryView, navigationLocalItems, navigationOrderDir]
  );
  const previewLocalBoardItems = useMemo(() => {
    if (
      shouldFollowLive ||
      !selectedItem ||
      localBoardItems.some((item) => toGalleryItemKey(item) === selectedItemKey)
    ) {
      return localBoardItems;
    }

    return [selectedItem, ...localBoardItems];
  }, [localBoardItems, selectedItem, selectedItemKey, shouldFollowLive]);
  const backendBoardItems = useMemo(() => flattenPreviewItems(boardItemsData), [boardItemsData]);
  // Recents belong to a board listing; a ranked list gets only the selection,
  // and only as the cursor anchor described in mergePreviewBoardItems.
  const previewMergeItems = useMemo(
    () =>
      navigationSemanticQuery === null ? previewLocalBoardItems : selectedItem ? [selectedItem] : EMPTY_PREVIEW_ITEMS,
    [navigationSemanticQuery, previewLocalBoardItems, selectedItem]
  );
  const boardItems = useMemo(
    () =>
      !hasNavigationContext
        ? EMPTY_PREVIEW_ITEMS
        : mergePreviewBoardItems(backendBoardItems, previewMergeItems, navigationOrderDir, {
            isRanked: navigationSemanticQuery !== null,
          }),
    [backendBoardItems, hasNavigationContext, navigationOrderDir, navigationSemanticQuery, previewMergeItems]
  );
  const isLoadingBoard = hasNavigationContext && isFetchingBoardItems;
  const navigationSequence = useMemo(
    () =>
      getPreviewNavigationSequence({
        // A ranked result set has no chronological insertion point, so the
        // generating placeholder is left out — matching the gallery grid,
        // which hides pending items while a similarity search is active.
        activePlaceholder: navigationSemanticQuery ? null : activePlaceholder,
        boardId: navigationBoardId,
        boardImages: boardItems,
        galleryView: navigationGalleryView,
        imageOrderDir: navigationOrderDir,
      }),
    [
      activePlaceholder,
      boardItems,
      navigationBoardId,
      navigationGalleryView,
      navigationOrderDir,
      navigationSemanticQuery,
    ]
  );
  const navigationCursor = getPreviewNavigationCursor(navigationSequence, {
    isFollowingLive: shouldFollowLive,
    selectedItemKey,
  });

  // One navigation action shared by the arrow keys and the footer buttons.
  // Compare mode stays inert and never exposes the placeholder.
  const navigate = useCallback(
    (offset: -1 | 1) => {
      if (isComparing) {
        return;
      }

      const target = getPreviewNavigationTarget(navigationSequence, navigationCursor, offset);
      const isAtLoadedBackendBoundary =
        selectedItemKey !== null &&
        (offset === 1
          ? backendBoardItems.at(-1) !== undefined &&
            toGalleryItemKey(backendBoardItems.at(-1)!) === selectedItemKey &&
            hasNextBoardItemsPage
          : backendBoardItems[0] !== undefined &&
            toGalleryItemKey(backendBoardItems[0]) === selectedItemKey &&
            hasPreviousBoardItemsPage);

      if (!isAtLoadedBackendBoundary) {
        if (!target) {
          return;
        }

        if (target.kind === 'item') {
          selectPreviewItem(target.item);
        } else {
          enableLiveFollow();
        }
        return;
      }

      if (offset === 1 ? isFetchingNextBoardItemsPage : isFetchingPreviousBoardItemsPage) {
        return;
      }

      const fetchBoundaryPage = offset === 1 ? fetchNextBoardItemsPage : fetchPreviousBoardItemsPage;

      void fetchBoundaryPage().then((result) => {
        if (result.isError || navigationContextKeyRef.current !== navigationContextKey) {
          return;
        }

        const nextBackendBoardItems = flattenPreviewItems(result.data);
        const nextBoardItems = mergePreviewBoardItems(nextBackendBoardItems, previewMergeItems, navigationOrderDir, {
          isRanked: navigationSemanticQuery !== null,
        });
        const nextNavigationSequence = getPreviewNavigationSequence({
          // Same exclusion as the render path: a ranked list has no
          // chronological slot for the generating placeholder, and inserting
          // one here would step onto a tile the sequence never showed.
          activePlaceholder: navigationSemanticQuery ? null : activePlaceholder,
          boardId: navigationBoardId,
          boardImages: nextBoardItems,
          galleryView: navigationGalleryView,
          imageOrderDir: navigationOrderDir,
        });
        const nextNavigationCursor = getPreviewNavigationCursor(nextNavigationSequence, {
          isFollowingLive: shouldFollowLive,
          selectedItemKey,
        });
        const nextTarget = getPreviewNavigationTarget(nextNavigationSequence, nextNavigationCursor, offset);

        if (nextTarget?.kind === 'item') {
          selectPreviewItem(nextTarget.item);
        } else if (nextTarget?.kind === 'placeholder') {
          enableLiveFollow();
        }
      });
    },
    [
      activePlaceholder,
      backendBoardItems,
      enableLiveFollow,
      fetchNextBoardItemsPage,
      fetchPreviousBoardItemsPage,
      hasNextBoardItemsPage,
      hasPreviousBoardItemsPage,
      isComparing,
      isFetchingNextBoardItemsPage,
      isFetchingPreviousBoardItemsPage,
      navigationBoardId,
      navigationContextKey,
      navigationCursor,
      navigationGalleryView,
      navigationOrderDir,
      navigationSemanticQuery,
      navigationSequence,
      previewMergeItems,
      selectedItemKey,
      selectPreviewItem,
      shouldFollowLive,
    ]
  );

  const handleNavigationKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest('video')) {
        return;
      }

      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      if (isComparing) {
        return;
      }

      // stopPropagation keeps the widget hotkey runtime from handling the same
      // arrow press a second time.
      event.preventDefault();
      event.stopPropagation();
      navigate(event.key === 'ArrowLeft' ? -1 : 1);
    },
    [isComparing, navigate]
  );

  // Warm the browser cache for the sequence neighbors so arrow-key navigation
  // swaps without a decode flash.
  const previousNeighbor = navigationSequence[navigationCursor - 1];
  const nextNeighbor = navigationSequence[navigationCursor + 1];
  const previousNeighborUrl =
    previousNeighbor?.kind === 'item' && previousNeighbor.item.kind === 'image' ? previousNeighbor.item.fullUrl : null;
  const nextNeighborUrl =
    nextNeighbor?.kind === 'item' && nextNeighbor.item.kind === 'image' ? nextNeighbor.item.fullUrl : null;

  useEffect(() => {
    [previousNeighborUrl, nextNeighborUrl].forEach((url) => {
      if (url) {
        new Image().src = url;
      }
    });
  }, [nextNeighborUrl, previousNeighborUrl]);

  return {
    boardItems,
    handleNavigationKeyDown,
    isLoadingBoard,
    navigate,
    navigationCursor,
    navigationQueryKey,
    navigationSequence,
    selectPreviewItem,
  };
};
