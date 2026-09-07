import type { GalleryItemKind } from '@features/gallery/core/items';

import { useCallback, useRef, type ChangeEvent } from 'react';

const UPLOAD_ACCEPT_BY_KIND: Record<GalleryItemKind, string> = {
  image: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp',
  video: 'video/mp4,.mp4',
};

/** The file input `accept` list for the given kinds. */
export const getGalleryUploadAccept = (kinds: readonly GalleryItemKind[]): string =>
  kinds.map((kind) => UPLOAD_ACCEPT_BY_KIND[kind]).join(',');

export const ACCEPTED_UPLOAD_EXTENSIONS = getGalleryUploadAccept(['image', 'video']);
export const UPLOAD_INPUT_STYLE = { display: 'none' } as const;

/** The hidden-input picker every gallery upload trigger shares: change extracts files, resets the input (so re-picking the same file fires), and forwards. */
export const useGalleryUploadInput = (
  onUploadFiles: (files: File[]) => Promise<unknown> | void,
  { accept = ACCEPTED_UPLOAD_EXTENSIONS, multiple = true }: { accept?: string; multiple?: boolean } = {}
) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.currentTarget.files ?? []);

      event.currentTarget.value = '';

      if (files.length > 0) {
        void onUploadFiles(files);
      }
    },
    [onUploadFiles]
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  return {
    inputProps: {
      accept,
      multiple,
      onChange,
      ref: inputRef,
      style: UPLOAD_INPUT_STYLE,
      type: 'file' as const,
    },
    openPicker,
  };
};
