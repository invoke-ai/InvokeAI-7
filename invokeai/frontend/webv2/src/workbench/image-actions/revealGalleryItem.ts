import type { GalleryView } from '@features/gallery';
import type { GalleryItemRef } from '@features/gallery/contracts';
import type { GalleryItemsFilter } from '@features/gallery/queries';
import type { QueryClient } from '@tanstack/react-query';
import type { WorkbenchCommands, WorkbenchQueries } from '@workbench/workbenchStore';

import { galleryItems, toGalleryItemKey } from '@features/gallery';
import { getGallerySettings, isGalleryNavigationCurrent, requestGalleryItemReveal } from '@features/gallery/contracts';
import {
  GALLERY_MAX_ROWS,
  GALLERY_PAGE_SIZE,
  galleryBoardsOptions,
  galleryItemNamesOptions,
  galleryItemsInfiniteOptions,
} from '@features/gallery/queries';
import { getProjectWidgetValues } from '@workbench/widgetState';

/**
 * What a reveal needs from the workbench. Passed in rather than read from hooks
 * so this module can be loaded on the press that needs it — the panels' find
 * badges are on the editor's initial route, and eagerly importing the gallery
 * item/transfer barrel from there cost two more initial script requests.
 */
export interface GalleryRevealContext {
  commands: WorkbenchCommands;
  queries: WorkbenchQueries;
  queryClient: QueryClient;
}

/**
 * What the gesture was, at the moment it was made. Both fields are claimed by
 * the CALLER and neither may be re-read here: a caller that loads this module
 * on demand would otherwise take its ordering, and its project, from whenever
 * the chunk happened to land.
 */
export interface GalleryRevealTicket {
  /** The project the press belongs to; its writes may not land in another. */
  projectId: string;
  /** This navigation's place in the global ordering; see `claimGalleryNavigationSequence`. */
  sequence: number;
}

/**
 * Extends the infinite window until it covers `pagesNeeded` pages. This must
 * NOT be a plain prefetch: the mounted gallery keeps the query fresh, and
 * `fetchQuery` returns fresh cache without honoring the `pages` option — the
 * reveal has to force the fetch (staleTime 0) or the window never grows. Two
 * passes because a concurrent fetch already in flight (a second rapid click)
 * absorbs the call without extending; the retry runs after it settles.
 */
const ensureGalleryPagesLoaded = async (
  queryClient: QueryClient,
  listingFilter: GalleryItemsFilter,
  pagesNeeded: number
): Promise<void> => {
  const options = galleryItemsInfiniteOptions(listingFilter, { kind: 'infinite' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const data = queryClient.getQueryData<{ pages: unknown[] }>(options.queryKey);

    if ((data?.pages.length ?? 0) >= pagesNeeded) {
      return;
    }

    await queryClient.fetchInfiniteQuery({ ...options, pages: pagesNeeded, staleTime: 0 });
  }
};

/**
 * Lands the gallery on one item: its board and view, any search or similarity
 * filter cleared (the item may not match it), and its position in the board's
 * ordering looked up so the grid can reach it — the page is selected in
 * paginated mode, and in infinite mode the pages down to it are loaded. The
 * grid scrolls to the newly selected item on its own once it is in the loaded
 * window. Preview follows the gallery selection by itself.
 *
 * The caller knows an item's kind and name; the selection contract wants a full
 * gallery item, so each is hydrated through the by-ref resolver — always fresh,
 * since a cached DTO's star/board state can drift, and kind-aware, since the
 * item can be a video. A slow fetch can never overwrite a newer selection.
 *
 * This is navigation only: no widget is raised, because the caller that sits
 * beside the grid (the image map) must not rearrange the workspace to scroll it.
 * `useFindGalleryItem` is the panels' gesture, which does both.
 *
 * The `ticket` is minted by the CALLER, at the moment of the gesture, so a
 * caller that loads this module on demand is still ordered — and fenced to its
 * project — by when it was pressed rather than by when its chunk landed. The
 * returned promise rejects if the item cannot be hydrated — a click on a
 * just-deleted item, or a blip mid-backend-restart — leaving the selection
 * unchanged; what to say about that is the caller's, since only it knows whether
 * it has already rearranged the workspace on the user's behalf.
 */
export const revealGalleryItem = (
  { commands, queries, queryClient }: GalleryRevealContext,
  ref: GalleryItemRef,
  { projectId, sequence }: GalleryRevealTicket
): Promise<void> => {
  // The press belongs to the project it was made in. This resolves over the
  // network, and a switch in that window would otherwise clear the INCOMING
  // project's search and move its selection — the same fence the video panel's
  // play button carries.
  const isCurrent = () => isGalleryNavigationCurrent(sequence) && queries.isActiveProject(projectId);

  return galleryItems.resolve(ref).then(async (image) => {
    if (!isCurrent()) {
      return;
    }

    const getGalleryValues = () => getProjectWidgetValues(queries.getSnapshot().activeProject, 'gallery');
    const settings = getGallerySettings(getGalleryValues());
    const targetView: GalleryView = image.category === 'general' ? 'images' : 'assets';
    // The board listing the gallery will show once the reveal below has
    // cleared any search: identical filter shape, so the name list (and
    // the prefetched pages) land in the cache the gallery reads.
    // The grid partitions on the flag: a starred image is revealed in
    // the starred-only listing, an unstarred one in the plain listing.
    const wantsStarredOnly = image.starred === true;
    const listingFilter = {
      boardId: image.boardId,
      galleryView: targetView,
      orderDir: settings.imageOrderDir,
      searchTerm: '',
      starred: wantsStarredOnly,
    };
    // The image's position within its board's ordering, which is what
    // lets the gallery land on the right page rather than page 0. A
    // failure here only costs the scroll, not the selection. The boards
    // list rides along because the gallery falls back to Uncategorized
    // when the target board is not listable (archived with "show
    // archived" off) — landing on the hidden board's page number there
    // would jump to an unrelated page of the wrong board.
    let boardIndex: number | null = null;

    try {
      const boardsPromise = queryClient
        .fetchQuery(
          galleryBoardsOptions({
            includeArchived: settings.showArchivedBoards,
            includeDateBoards: settings.showDateBoards,
            orderBy: settings.boardOrderBy,
            orderDir: settings.boardOrderDir,
          })
        )
        // Unknown beats blocked: without the boards list the reveal
        // proceeds as if the board were listable.
        .catch(() => null);
      const names = await queryClient.fetchQuery(galleryItemNamesOptions(listingFilter));
      const boards = await boardsPromise;
      const index = names.items.findIndex((item) => item.kind === ref.kind && item.name === ref.name);
      const isBoardListable =
        image.boardId === 'none' ||
        boards === null ||
        boards.length === 0 ||
        boards.some((board) => board.id === image.boardId);

      boardIndex = index >= 0 && isBoardListable ? index : null;
    } catch {
      boardIndex = null;
    }

    if (!isCurrent()) {
      return;
    }

    const values = getGalleryValues();
    const settingsNow = getGallerySettings(values);

    // The listing's ordering may have changed while the name list was
    // in flight (sort direction); the computed index describes the old
    // ordering, so the page landing is dropped.
    if (settingsNow.imageOrderDir !== settings.imageOrderDir) {
      boardIndex = null;
    }

    const currentView: GalleryView = values.galleryView === 'assets' ? 'assets' : 'images';
    const hasSearch = typeof values.searchTerm === 'string' && values.searchTerm !== '';

    // Filters would hide the listing the index was computed against
    // (the image may not match them), so the reveal clears them and sets
    // the starred filter to the image's own side of the partition.
    if (
      hasSearch ||
      (values.starredOnly === true) !== wantsStarredOnly ||
      (values.semanticImageQuery !== null && values.semanticImageQuery !== undefined)
    ) {
      commands.widgets.patchValues('gallery', {
        searchTerm: '',
        semanticImageQuery: null,
        starredOnly: wantsStarredOnly,
      });
    }

    if (currentView !== targetView) {
      commands.gallery.setView(targetView);
    }

    // Select the image's board before the image. A reveal spans every
    // accessible board, but `selectGalleryItem` stamps the navigation
    // query from whatever list the gallery is CURRENTLY showing — a
    // cross-board reveal without this left Preview's next/prev with no
    // cursor. Mirrors the command palette's reveal-in-gallery.
    commands.gallery.selectBoard(image.boardId);

    const page = boardIndex !== null ? Math.floor(boardIndex / GALLERY_PAGE_SIZE) : null;

    if (page !== null && settingsNow.paginationMode === 'paginated') {
      commands.gallery.setPage(page);
    }

    if (boardIndex !== null && page !== null && settingsNow.paginationMode === 'infinite') {
      if (boardIndex < GALLERY_MAX_ROWS) {
        // Within the base window's reach: load every page down to the
        // image so the grid can scroll to it. Fire and forget — the
        // selection must not wait on page hydration, and the grid's
        // pending reveal settles whenever the item appears.
        void ensureGalleryPagesLoaded(queryClient, listingFilter, page + 1).catch(() => {});
      } else {
        // Deeper than the base window can ever load: anchor the
        // infinite window at the image's page instead (the mounted
        // gallery query fetches it on its own). Any board, search, or
        // view change resets the anchor back to the top.
        commands.gallery.setPage(page);
      }
    }

    commands.gallery.selectItem(image, projectId, page ?? undefined);
    requestGalleryItemReveal(toGalleryItemKey(ref));
  });
};
