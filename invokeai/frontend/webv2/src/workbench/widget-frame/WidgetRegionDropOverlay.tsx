import type { WidgetRegionDropState } from '@workbench/widgetDnd';

import { DropZone, type DropZoneProps } from '@platform/ui/DropZone';

const DISALLOWED_STYLES: DropZoneProps = { bg: 'bg.muted', borderColor: 'border.subtle' };

/**
 * The one drag-time chrome for widget drop targets: rails render it across
 * their whole strip, the status bar renders one per cluster with inset
 * overrides. Styling lives in `DropZone`; keep consumers prop-thin so the
 * look cannot fork.
 */
export const WidgetRegionDropOverlay = ({
  dropState,
  isOver,
  ...boxProps
}: {
  dropState: WidgetRegionDropState;
  isOver: boolean;
} & DropZoneProps) => (
  <DropZone
    bottom="0"
    isOver={dropState.isAllowed && isOver}
    left="0"
    opacity={dropState.isAllowed ? 0.96 : 0.5}
    pointerEvents="none"
    position="absolute"
    right="0"
    top="0"
    variant="overlay"
    zIndex="2"
    {...(dropState.isAllowed ? undefined : DISALLOWED_STYLES)}
    {...boxProps}
  />
);
