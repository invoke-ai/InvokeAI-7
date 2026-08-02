import type { WidgetViewProps } from '@workbench/widgetContracts';

import { Icon } from '@chakra-ui/react';
import { IconButton, Tooltip } from '@platform/ui';
import { useWidgetValuesSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { GroupIcon, TagsIcon } from 'lucide-react';
import { useCallback } from 'react';

/**
 * Header toggles, persisted in the widget's values like the gallery's own
 * view settings: cluster-selection mode (clicking a point selects its whole
 * cluster) and cluster-label visibility (on by default).
 */
export const ImageMapHeaderActions = (_props: WidgetViewProps) => {
  const { widgets } = useWorkbenchCommands();
  const clickSelectsCluster = useWidgetValuesSelector('image-map', (values) => Boolean(values.clickSelectsCluster));
  const showClusterLabels = useWidgetValuesSelector('image-map', (values) => values.showClusterLabels !== false);
  const handleToggleClusterMode = useCallback(
    () => widgets.patchValues('image-map', { clickSelectsCluster: !clickSelectsCluster }),
    [clickSelectsCluster, widgets]
  );
  const handleToggleLabels = useCallback(
    () => widgets.patchValues('image-map', { showClusterLabels: !showClusterLabels }),
    [showClusterLabels, widgets]
  );

  return (
    <>
      <Tooltip content={showClusterLabels ? 'Cluster labels shown' : 'Cluster labels hidden'}>
        <IconButton
          aria-label="Toggle cluster labels"
          aria-pressed={showClusterLabels}
          color={showClusterLabels ? 'accent.fg' : 'fg.muted'}
          size="2xs"
          variant={showClusterLabels ? 'subtle' : 'ghost'}
          onClick={handleToggleLabels}
        >
          <Icon as={TagsIcon} boxSize="3.5" />
        </IconButton>
      </Tooltip>
      <Tooltip content={clickSelectsCluster ? 'Click selects the whole cluster' : 'Click selects one image'}>
        <IconButton
          aria-label="Toggle cluster selection mode"
          aria-pressed={clickSelectsCluster}
          color={clickSelectsCluster ? 'accent.fg' : 'fg.muted'}
          size="2xs"
          variant={clickSelectsCluster ? 'subtle' : 'ghost'}
          onClick={handleToggleClusterMode}
        >
          <Icon as={GroupIcon} boxSize="3.5" />
        </IconButton>
      </Tooltip>
    </>
  );
};
