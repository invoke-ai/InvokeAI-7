import type { ComponentProps } from 'react';

import { Popover, usePopoverContext } from '@chakra-ui/react';

import { useRegisterWidgetOverlay } from './widgetOverlays';

type PopoverContentProps = ComponentProps<typeof Popover.Content> & {
  /** Anchored panels keep the arrow; dropdown-shaped popovers (pickers) opt out. */
  showArrow?: boolean;
};

/**
 * Popover.Content with the anchor arrow baked in, closing with the tree that
 * opened it. Chrome (surface, stroke, shadow, arrow fill) comes from the
 * `popover` slot-recipe override in `theme/recipes.ts`, so consumers stay
 * consistent by construction.
 */
export const PopoverContent = ({ children, showArrow = true, ...props }: PopoverContentProps) => {
  const popover = usePopoverContext();
  const stale = useRegisterWidgetOverlay(popover.open, popover.setOpen);
  if (stale) {
    return null;
  }
  return (
    <Popover.Content {...props}>
      {showArrow ? (
        <Popover.Arrow>
          <Popover.ArrowTip />
        </Popover.Arrow>
      ) : null}
      {children}
    </Popover.Content>
  );
};
