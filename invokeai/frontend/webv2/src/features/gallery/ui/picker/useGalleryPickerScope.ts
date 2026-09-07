import type { GallerySettings } from '@features/gallery/core/settings';
import type { GalleryView } from '@features/gallery/core/types';

import { getSelectedGalleryItemFromValues } from '@features/gallery/core/selection';
import { getGallerySettings } from '@features/gallery/core/settings';
import {
  getGalleryProjectBoardId,
  getGalleryRawSelectedBoardId,
  getGalleryView,
} from '@features/gallery/ui/galleryStateView';
import { useGalleryUi } from '@features/gallery/ui/GalleryUiContext';
import { useGalleryData } from '@features/gallery/ui/useGalleryData';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';

export type GalleryPickerPane = 'boards' | 'items';

const NO_RECENT_IMAGES: never[] = [];

export interface GalleryPickerScope {
  boardId: string | null;
  galleryView: GalleryView;
  pane: GalleryPickerPane;
  searchTerm: string;
}

/**
 * The picker's local view of the gallery: seeded from the Gallery widget's
 * values when the picker mounts (the popover unmounts on close, so mounting is
 * opening) and never written back. The search field serves whichever pane is
 * showing, so a pane switch clears it.
 */
export const useGalleryPickerScope = () => {
  const { galleryValues } = useGalleryUi();
  const [scope, setScope] = useState<GalleryPickerScope>(() => ({
    boardId: getGalleryRawSelectedBoardId(galleryValues),
    galleryView: getGalleryView(galleryValues),
    pane: 'items',
    searchTerm: '',
  }));
  const deferredSearchTerm = useDeferredValue(scope.searchTerm);
  const settings = useMemo<GallerySettings>(
    () => ({ ...getGallerySettings(galleryValues), paginationMode: 'infinite' }),
    [galleryValues]
  );
  const data = useGalleryData({
    galleryView: scope.galleryView,
    page: 0,
    projectBoardId: getGalleryProjectBoardId(galleryValues),
    // No recents overlay: `items` must stay null until the first page lands,
    // so the loading, seeding and stale states have one unambiguous signal.
    recentImages: NO_RECENT_IMAGES,
    searchTerm: scope.pane === 'items' ? deferredSearchTerm : '',
    selectedBoardId: scope.boardId,
    semanticQuery: null,
    settings,
  });
  const gallerySelectedItem = useMemo(() => getSelectedGalleryItemFromValues(galleryValues), [galleryValues]);

  const setSearchTerm = useCallback((searchTerm: string) => setScope((current) => ({ ...current, searchTerm })), []);
  const setView = useCallback((galleryView: GalleryView) => setScope((current) => ({ ...current, galleryView })), []);
  const selectBoard = useCallback(
    (boardId: string) => setScope((current) => ({ ...current, boardId, pane: 'items', searchTerm: '' })),
    []
  );
  const togglePane = useCallback(
    () => setScope((current) => ({ ...current, pane: current.pane === 'items' ? 'boards' : 'items', searchTerm: '' })),
    []
  );

  return { data, gallerySelectedItem, scope, selectBoard, setSearchTerm, setView, settings, togglePane };
};
