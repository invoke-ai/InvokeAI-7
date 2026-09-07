import type { BoxProps } from '@chakra-ui/react';
import type { Ref } from 'react';

import { Box } from '@chakra-ui/react';
import { useMemo } from 'react';

const DROP_ZONE_TRANSITION =
  'background var(--wb-motion-duration-fast) ease, border-color var(--wb-motion-duration-fast) ease, opacity var(--wb-motion-duration-fast) ease, box-shadow var(--wb-motion-duration-fast) ease';

export interface DropZoneProps extends BoxProps {
  /** Native `disabled`, for zones rendered `as="button"`. */
  disabled?: boolean;
  /** The zone cannot accept input right now; the hover preview stands down. */
  isDisabled?: boolean;
  /** A compatible drag is hovering the zone. */
  isOver?: boolean;
  /** Forwarded to the underlying element (e.g. dnd-kit's `setNodeRef`). */
  ref?: Ref<HTMLDivElement>;
  /**
   * `inline` — a persistent, usually clickable upload box inside a form.
   * `overlay` — a drag-time overlay floated above existing content; heavier
   * border and a surface tint so it reads against arbitrary backdrops.
   */
  variant?: 'inline' | 'overlay';
}

/**
 * The workbench drop-target look: dashed `border.emphasized` at rest, an
 * accent border on pointer hover previewing the drop treatment, and an
 * `accent.solid` border over an `accent.muted` tint while a compatible drag
 * hovers. Every drop zone and upload area composes this so drag affordances
 * stay identical across the app; callers add their own icon/hint content,
 * interaction handlers, and layout props.
 */
export const DropZone = ({ children, isDisabled, isOver, variant = 'inline', _hover, ...boxProps }: DropZoneProps) => {
  // Merged here rather than spread: `:hover` stays live during a drag, so a
  // consumer hover fill would otherwise paint over the drag-over treatment.
  // The accent preview is for persistent inline zones only — overlays exist
  // mid-drag, where dnd-kit's own `isOver` is the signal.
  const hoverProps = useMemo(
    () => ({
      ...(variant === 'inline' && !isDisabled ? { borderColor: 'accent.solid' } : null),
      ..._hover,
      ...(isOver ? { bg: 'accent.solid/15', borderColor: 'accent.solid' } : null),
    }),
    [_hover, isDisabled, isOver, variant]
  );

  return (
    <Box
      bg={isOver ? 'accent.solid/15' : variant === 'overlay' ? 'bg.muted/60' : undefined}
      borderColor={isOver ? 'accent.solid' : 'border.emphasized'}
      borderStyle="dashed"
      borderWidth={variant === 'overlay' ? '2px' : '1px'}
      boxShadow={isOver && variant === 'overlay' ? '0 0 0 1px {colors.accent.solid}' : undefined}
      color={isOver ? 'fg' : 'fg.muted'}
      rounded="md"
      transition={DROP_ZONE_TRANSITION}
      _hover={hoverProps}
      {...boxProps}
    >
      {children}
    </Box>
  );
};
