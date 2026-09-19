import type { IconButtonProps } from '@platform/ui/Button';

import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { CrosshairIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * "Find in gallery", for the panels that condition on media they did not pick
 * from the grid they are looking at. The mark is the same crosshair the
 * workflow form's pinned fields use to locate their node: "take me to it".
 *
 * Presentation is the caller's: this owns the icon, the accessible name, and
 * the tooltip, which are what must not drift between the four thumbnails that
 * offer the gesture.
 */
export type FindInGalleryButtonProps = Omit<
  IconButtonProps,
  'aria-label' | 'aria-labelledby' | 'children' | 'onClick'
> & {
  /**
   * The media's file name. A field can show several of these at once (a clip's
   * two trim bounds, a stack of references), which as bare "Find in Gallery"
   * buttons are indistinguishable to a screen reader.
   */
  name?: string;
  onFind: () => void;
};

export const FindInGalleryButton = ({ name, onFind, ...buttonProps }: FindInGalleryButtonProps) => {
  const { t } = useTranslation();
  // One string for both: a tooltip that is not part of the accessible name
  // leaves speech input with nothing to match when the user says what they see.
  const label =
    name === undefined ? t('widgets.gallery.findInGallery') : t('widgets.gallery.findNamedInGallery', { name });

  return (
    <Tooltip content={label}>
      <IconButton aria-label={label} size="2xs" {...buttonProps} onClick={onFind}>
        <CrosshairIcon />
      </IconButton>
    </Tooltip>
  );
};

// Keyboard users never see a hover, so focus has to reveal it too — and the
// control is only a tab stop worth having once it is visible, hence the
// pointer-events pair rather than `display`, which would drop it from the tab
// order entirely.
const REVEALED = { opacity: 1, pointerEvents: 'auto' } as const;

/**
 * The same gesture pinned to the bottom-right corner of a thumbnail and
 * revealed with it. The host thumbnail supplies `className="group"` and a
 * positioning context; the solid neutral chip is the workbench's treatment for
 * a control that has to stay legible over arbitrary imagery.
 *
 * The inset is the focus ring's own reach (2px outline, 2px offset): thumbnails
 * clip their overflow, so anything tighter crops the ring rather than the chip,
 * and takes the focus indicator with it.
 */
export const FindInGalleryThumbnailButton = (buttonProps: FindInGalleryButtonProps) => (
  <FindInGalleryButton
    bottom="1"
    colorPalette="gray"
    insetInlineEnd="1"
    opacity={0}
    pointerEvents="none"
    position="absolute"
    transition="opacity var(--wb-motion-duration-medium) ease"
    variant="solid"
    zIndex="1"
    _groupFocusWithin={REVEALED}
    _groupHover={REVEALED}
    {...buttonProps}
  />
);
