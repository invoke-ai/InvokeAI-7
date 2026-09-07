import type { GalleryBoard, GalleryView } from '@features/gallery/core/types';

import { Text } from '@chakra-ui/react';
import { SegmentTabs } from '@platform/ui';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getGalleryCountForView } from './galleryBoardLabels';
import { useGalleryWidget } from './GalleryWidgetContext';

const GALLERY_VIEW_TABS = [
  { labelKey: 'common.media', value: 'images' },
  { labelKey: 'common.assets', value: 'assets' },
] satisfies { labelKey: string; value: GalleryView }[];

/**
 * Media / Assets, each carrying `board`'s count for that view so the split is
 * legible before you switch. The same `SegmentTabs` strip the layer panes use;
 * the caller wires the tabpanel by putting `segmentTabsPanelId(idBase)` on its
 * grid container.
 */
export const GalleryViewSegmentTabs = ({
  activeView,
  board,
  idBase,
  onSelect,
}: {
  activeView: GalleryView;
  board: GalleryBoard | undefined;
  idBase: string;
  onSelect: (view: GalleryView) => void;
}) => {
  const { t } = useTranslation();

  // SegmentTabs re-fires selecting the active tab (its collapsible-toggle
  // affordance); a same-view write would only dirty the widget values.
  const handleViewChange = useCallback(
    (value: GalleryView) => {
      if (value !== activeView) {
        onSelect(value);
      }
    },
    [activeView, onSelect]
  );

  const tabs = useMemo(
    () =>
      GALLERY_VIEW_TABS.map(({ labelKey, value }) => {
        const count = board ? getGalleryCountForView(board, value) : null;

        return {
          id: value,
          label: (
            <Text as="span" display="flex" gap="1.5">
              {t(labelKey)}
              {count === null ? null : (
                // Dimmed from the tab's own text colour, so it tracks the
                // shown/idle swap; 0.8 stays comfortably legible on both.
                <Text as="span" color="currentColor" fontVariantNumeric="tabular-nums" opacity="0.8">
                  {count}
                </Text>
              )}
            </Text>
          ),
        };
      }),
    [board, t]
  );

  return (
    <SegmentTabs
      activeId={activeView}
      ariaLabel={t('common.view')}
      idBase={idBase}
      isCompact
      tabs={tabs}
      onSelect={handleViewChange}
    />
  );
};

export const GalleryViewTabs = ({ idBase }: { idBase: string }) => {
  const { actions, gallery } = useGalleryWidget();
  const selectedBoard = gallery.boards.find((board) => board.id === gallery.selectedBoardId);

  return (
    <GalleryViewSegmentTabs
      activeView={gallery.galleryView}
      board={selectedBoard}
      idBase={idBase}
      onSelect={actions.setView}
    />
  );
};
