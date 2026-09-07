import type { BoxProps, SystemStyleObject } from '@chakra-ui/react';
import type { GalleryItem } from '@features/gallery/core/items';
import type { ReactNode, Ref } from 'react';

import { Badge, Box } from '@chakra-ui/react';
import { formatGalleryVideoDuration } from '@features/gallery/core/items';
import { PlayIcon } from 'lucide-react';
import { useMemo } from 'react';

const TILE_CSS: SystemStyleObject = {
  '&:focus-within': { outline: '2px solid {colors.accent.solid}', outlineOffset: '-2px' },
  '&:hover .gallery-thumb-overlay, &:focus-within .gallery-thumb-overlay': { opacity: 1 },
};

const BADGE_TRANSITION = 'opacity var(--wb-motion-duration-medium) ease';

export interface GalleryTileFrameProps extends Omit<BoxProps, 'children'> {
  alwaysShowDimensions?: boolean;
  /** The interactive layer (image button, drag listeners, extra badges). */
  children?: ReactNode;
  isSelected?: boolean;
  item: GalleryItem;
  ref?: Ref<HTMLDivElement>;
}

/**
 * The thumbnail shell shared by every gallery surface: square, accent border
 * when selected, hover-revealed dimensions badge, video duration badge.
 * Caller `css` composes on top; the shell's own props are invariants.
 */
export const GalleryTileFrame = ({
  alwaysShowDimensions = false,
  children,
  css,
  isSelected = false,
  item,
  ...boxProps
}: GalleryTileFrameProps) => {
  const duration = item.kind === 'video' ? formatGalleryVideoDuration(item.durationSeconds) : null;
  const tileCss = useMemo(() => (css ? [TILE_CSS, css] : TILE_CSS), [css]);

  return (
    <Box
      {...boxProps}
      aspectRatio={1}
      bg="bg"
      borderColor={isSelected ? 'accent.solid' : 'border.subtle'}
      borderWidth="2px"
      css={tileCss}
      minW="0"
      overflow="hidden"
      position="relative"
      rounded="md"
      w="full"
    >
      {children}
      {item.kind === 'image' && item.width > 0 && item.height > 0 ? (
        <Badge
          bottom="1"
          className="gallery-thumb-overlay"
          insetInlineStart="1"
          opacity={alwaysShowDimensions ? 1 : 0}
          pointerEvents="none"
          position="absolute"
          size="xs"
          transition={BADGE_TRANSITION}
          variant="solid"
          zIndex="1"
        >
          {item.width}x{item.height}
        </Badge>
      ) : null}
      {duration !== null ? (
        <Badge
          bottom="1"
          display="flex"
          fontVariantNumeric="tabular-nums"
          gap="1"
          insetInlineStart="1"
          pointerEvents="none"
          position="absolute"
          size="xs"
          variant="solid"
          zIndex="1"
        >
          <PlayIcon aria-hidden="true" fill="currentColor" />
          {duration}
        </Badge>
      ) : null}
    </Box>
  );
};
