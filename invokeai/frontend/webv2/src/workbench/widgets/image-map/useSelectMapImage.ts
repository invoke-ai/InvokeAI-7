import type { GalleryItemKey, GalleryItemRef } from '@features/gallery/contracts';

import { galleryItems, toGalleryItemKey } from '@features/gallery';
import {
  claimGalleryNavigationSequence,
  isGalleryNavigationCurrent,
  registerImageCluster,
  requestGalleryItemReveal,
} from '@features/gallery/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { revealGalleryItem } from '@workbench/image-actions/revealGalleryItem';
import { useWorkbenchCommands, useWorkbenchQueries } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';

export interface MapSelectionActions {
  /** Reveal one item: land the gallery on its board, page, and grid cell. */
  selectItem: (item: GalleryItemRef) => void;
  /** Show the whole cluster in the gallery, the clicked item selected. */
  selectCluster: (primaryItem: GalleryItemRef, itemKeys: GalleryItemKey[], label: string) => void;
}

/**
 * Turns map clicks into gallery navigation. A single click is a full reveal,
 * which `revealGalleryItem` owns; the map raises no widget of its own, since it
 * sits beside the grid it is scrolling. The sequence guard those reveals claim
 * spans BOTH selection kinds, so rapid clicks always resolve to the latest
 * click regardless of which mode each went through.
 *
 * A cluster click instead behaves like a search: the cluster's members (in
 * proximity order from the clicked point) become the gallery's list via a
 * `cluster` semantic reference, with the clicked item — the list's first
 * entry — as the selection.
 */
export const useMapSelection = (): MapSelectionActions => {
  const commands = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const queryClient = useQueryClient();
  const selectItem = useCallback(
    (ref: GalleryItemRef) => {
      const ticket = { projectId: queries.getSnapshot().activeProject.id, sequence: claimGalleryNavigationSequence() };

      void revealGalleryItem({ commands, queries, queryClient }, ref, ticket).catch(() => {
        // A click on a just-deleted point, or a blip mid-backend-restart, simply
        // leaves the selection unchanged. The map sits beside the grid and has
        // moved nothing, so there is nothing to explain.
      });
    },
    [commands, queries, queryClient]
  );

  const selectCluster = useCallback(
    (primaryItem: GalleryItemRef, itemKeys: GalleryItemKey[], label: string) => {
      const sequence = claimGalleryNavigationSequence();

      galleryItems
        .resolve(primaryItem)
        .then((image) => {
          if (!isGalleryNavigationCurrent(sequence)) {
            return;
          }

          // Same reason as a single-item reveal: the selection stamps the
          // navigation query from the board the gallery is showing, so land
          // on the primary item's board first to keep that query coherent.
          commands.gallery.selectBoard(image.boardId);
          // The member list lives in an in-memory registry (it can run to
          // thousands of items); the persisted value keeps only the key. The
          // page reset and search-term clear mirror setSemanticImageQuery in
          // the gallery's own actions.
          const clusterId = registerImageCluster(itemKeys, label);

          commands.widgets.patchValues('gallery', {
            galleryPage: 0,
            searchTerm: '',
            semanticImageQuery: { clusterId, kind: 'cluster', label },
            semanticSearchText: null,
          });
          // The clicked item is the proximity ordering's first entry, so it
          // is selected at the top of the cluster view; Preview follows. The
          // reveal brings the grid back to it even when this exact selection
          // is already current (re-clicking the cluster after scrolling away).
          commands.gallery.selectItem(image);
          requestGalleryItemReveal(toGalleryItemKey(primaryItem));
        })
        .catch(() => {
          // Selection is simply left unchanged on hydrate failure.
        });
    },
    [commands]
  );

  return useMemo(() => ({ selectCluster, selectItem }), [selectCluster, selectItem]);
};
