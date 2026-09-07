import type { SystemStyleObject } from '@chakra-ui/react';

import { QueueProgressRail } from '@workbench/queue-integration/QueueProgressRail';

/**
 * The primary generation indicator: a hairline lighting up along the top bar's
 * bottom edge while work is in flight.
 *
 * Every other progress surface is small and most only exists if that widget is
 * on screen. A rail spanning the viewport is detectable without being looked
 * at, and it is present in every layout.
 *
 * It sits *over* the 1px divider rather than below it, so appearing costs no
 * reflow and reads as the existing line lighting up. The rail itself is
 * shared with the floating preview window (`QueueProgressRail`); only this
 * placement is the top bar's.
 */

const RAIL_SX: SystemStyleObject = {
  bottom: '-1px',
  display: 'flex',
  gap: '1px',
  height: '2px',
  insetInline: 0,
  pointerEvents: 'none',
  position: 'absolute',
  zIndex: 3,
};

export const TopbarProgressRail = () => <QueueProgressRail css={RAIL_SX} />;
