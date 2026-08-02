import { galleryImages, legacyGeneratedImageToGalleryItem, toGalleryItemKey } from '@features/gallery';
import { useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useMemo, useRef } from 'react';

export interface MapSelectionActions {
  /** Select one image (hydrates the item, then gallery.selectItem). */
  selectImage: (imageName: string) => void;
  /** Multi-select a cluster with the clicked image as primary. */
  selectCluster: (primaryImageName: string, imageNames: string[]) => void;
}

/**
 * Turns map clicks into gallery selections. The map only knows names; the
 * selection contract wants a full gallery item, so names are hydrated through
 * the bulk by-names resolver — always fresh, since a cached DTO's star/board
 * state can drift. ONE monotonic sequence spans both selection kinds, so
 * rapid clicks always resolve to the latest click regardless of which mode
 * each went through; a slow fetch can never overwrite a newer selection.
 * Preview follows the gallery selection on its own.
 */
export const useMapSelection = (): MapSelectionActions => {
  const commands = useWorkbenchCommands();
  const sequenceRef = useRef(0);

  const selectImage = useCallback(
    (imageName: string) => {
      const sequence = ++sequenceRef.current;

      galleryImages
        .resolveMany([imageName])
        .then((images) => {
          const image = images.at(0);

          if (!image || sequence !== sequenceRef.current) {
            return;
          }

          commands.gallery.selectItem(legacyGeneratedImageToGalleryItem(image));
        })
        .catch(() => {
          // A click on a just-deleted image, or a blip mid-backend-restart,
          // simply leaves the selection unchanged.
        });
    },
    [commands]
  );

  const selectCluster = useCallback(
    (primaryImageName: string, imageNames: string[]) => {
      const sequence = ++sequenceRef.current;

      galleryImages
        .resolveMany([primaryImageName])
        .then((images) => {
          const image = images.at(0);

          if (!image || sequence !== sequenceRef.current) {
            return;
          }

          // Map points are always images, so every key is kind-tagged 'image'.
          const itemKeys = imageNames.map((name) => toGalleryItemKey({ kind: 'image', name }));
          commands.gallery.setItemMultiSelection(itemKeys, legacyGeneratedImageToGalleryItem(image));
        })
        .catch(() => {
          // Selection is simply left unchanged on hydrate failure.
        });
    },
    [commands]
  );

  return useMemo(() => ({ selectCluster, selectImage }), [selectCluster, selectImage]);
};
