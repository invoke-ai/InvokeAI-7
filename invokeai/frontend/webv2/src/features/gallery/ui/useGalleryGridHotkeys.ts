import type { GalleryItem, GalleryItemRef } from '@features/gallery/core/items';

import { shouldStarSelection, toGalleryItemKey, toGalleryItemRef } from '@features/gallery/core/items';
import { useEffect, useEffectEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { GalleryGridNavDirection, GalleryGridNavigation } from './galleryGridLayout';

import { getGalleryGridNavigationStep } from './galleryGridLayout';
import { useGalleryUi } from './GalleryUiContext';
import { useGalleryWidget } from './GalleryWidgetContext';

const GALLERY_HOTKEYS = [
  ['gallery.selectAllOnPage', 'widgets.gallery.commands.selectAllOnPage', null, ['mod+a']],
  ['gallery.clearSelection', 'widgets.gallery.commands.clearSelection', null, ['esc']],
  ['gallery.galleryNavUp', 'widgets.gallery.commands.navigationUp', 'up', ['arrowup']],
  ['gallery.galleryNavRight', 'widgets.gallery.commands.navigationRight', 'right', ['arrowright']],
  ['gallery.galleryNavDown', 'widgets.gallery.commands.navigationDown', 'down', ['arrowdown']],
  ['gallery.galleryNavLeft', 'widgets.gallery.commands.navigationLeft', 'left', ['arrowleft']],
  ['gallery.galleryNavUpAlt', 'widgets.gallery.commands.navigationUp', 'up', ['alt+arrowup']],
  ['gallery.galleryNavRightAlt', 'widgets.gallery.commands.navigationRight', 'right', ['alt+arrowright']],
  ['gallery.galleryNavDownAlt', 'widgets.gallery.commands.navigationDown', 'down', ['alt+arrowdown']],
  ['gallery.galleryNavLeftAlt', 'widgets.gallery.commands.navigationLeft', 'left', ['alt+arrowleft']],
  ['gallery.deleteSelection', 'widgets.gallery.commands.deleteSelection', null, ['delete', 'backspace']],
  ['gallery.starImage', 'widgets.gallery.commands.toggleStarImage', null, ['.']],
  ['gallery.toggleStarredOnly', 'widgets.gallery.commands.toggleStarredOnly', null, []],
] as const satisfies readonly (readonly [string, string, GalleryGridNavDirection | null, readonly string[]])[];

/**
 * Registers the grid's commands and their default keys.
 *
 * Handlers run through `useEffectEvent` so registration depends only on the
 * runtime and the translator: re-registering every command on each selection
 * change would churn the palette and the hotkey map on every click.
 */
export const useGalleryGridHotkeys = ({
  actionSelectionRefs,
  columnCount,
  loadedItems,
  navigation,
  scrollToItemIndex,
}: {
  actionSelectionRefs: GalleryItemRef[];
  columnCount: number;
  /** Everything on hand for star-state lookups, strip included. */
  loadedItems: readonly GalleryItem[];
  /** The arrow-key index space: shown strip cells, then the listing. */
  navigation: GalleryGridNavigation;
  scrollToItemIndex: (itemIndex: number) => void;
}) => {
  const { t } = useTranslation();
  const { actions, gallery, itemActions, runtime } = useGalleryWidget();
  const { gallery: galleryCommands } = useGalleryUi();

  const navigate = useEffectEvent((direction: GalleryGridNavDirection) => {
    if (navigation.items.length === 0) {
      return;
    }

    const selectedIndex = navigation.items.findIndex((item) => toGalleryItemKey(item) === gallery.selectedItemKey);
    const nextIndex =
      selectedIndex === -1 ? 0 : getGalleryGridNavigationStep(navigation, columnCount, selectedIndex, direction);
    const nextItem = navigation.items[nextIndex];

    if (nextItem && (nextIndex !== selectedIndex || selectedIndex === -1)) {
      actions.selectItem(nextItem);
      scrollToItemIndex(nextIndex);
    }
  });

  const executeGalleryHotkey = useEffectEvent((commandId: string) => {
    if (commandId === 'gallery.selectAllOnPage') {
      const primaryItem = gallery.items[0];

      if (primaryItem) {
        actions.selectItemRange(gallery.items.map(toGalleryItemRef), primaryItem);
      }
      return;
    }

    if (commandId === 'gallery.clearSelection') {
      galleryCommands.clearSelection();
      return;
    }

    if (commandId === 'gallery.deleteSelection' && actionSelectionRefs.length > 0) {
      void itemActions.deleteItems(actionSelectionRefs);
      return;
    }

    if (commandId === 'gallery.starImage' && actionSelectionRefs.length > 0) {
      void itemActions.setItemsStarred(actionSelectionRefs, shouldStarSelection(loadedItems, actionSelectionRefs));
      return;
    }

    if (commandId === 'gallery.toggleStarredOnly' && gallery.semanticImageQuery === null) {
      actions.setStarredOnly(!gallery.starredOnly);
    }
  });

  useEffect(() => {
    const disposers = GALLERY_HOTKEYS.flatMap(([id, titleKey, direction, defaultKeys]) => [
      runtime.commands.register({
        handler: () => (direction ? navigate(direction) : executeGalleryHotkey(id)),
        id,
        title: t(titleKey),
      }),
      runtime.hotkeys.register({
        commandId: id,
        defaultKeys: [...defaultKeys],
        id,
        title: t(titleKey),
      }),
    ]);

    return () => {
      disposers.forEach((dispose) => dispose());
    };
  }, [runtime.commands, runtime.hotkeys, t]);
};
