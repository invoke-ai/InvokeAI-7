import type { WidgetRegion } from '@workbench/layoutContracts';
import type { WidgetInstanceId } from '@workbench/widgetContracts';

import { MissingWidgetFrame, WidgetRendererById } from '@workbench/widget-frame';
import { areWidgetRenderInstancesEqual } from '@workbench/widget-frame/widgetRenderInstance';
import { resolveWidgetLabel } from '@workbench/widgetLabels';
import { getWidgetById } from '@workbench/widgetRegistry';
import { useActiveProjectId, useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { Activity } from 'react';
import { useTranslation } from 'react-i18next';

import {
  areInstanceIdListsEqual,
  getActiveInstanceIdsOutside,
  useMountedInstanceIds,
  withoutInstancesShownElsewhere,
} from './useMountedInstanceIds';

type PanelRegion = Exclude<WidgetRegion, 'center'>;

/** Left panel — hosts the active registered widget panel view. */
export const LeftPanel = ({ instanceId }: { instanceId: WidgetInstanceId }) => (
  <WidgetPanelSlot instanceId={instanceId} region="left" />
);

/** Right panel — hosts the active registered widget panel view. */
export const RightPanel = ({ instanceId }: { instanceId: WidgetInstanceId }) => (
  <WidgetPanelSlot instanceId={instanceId} region="right" />
);

/**
 * Keeps the panel widgets this session has already shown mounted behind the
 * active one, so switching a layout preset hides them rather than destroying
 * their scroll position, selection and virtualizer state. The remembered set is
 * independent of the region's `instanceIds`, which a preset replaces wholesale.
 */
export const WidgetPanelSlot = ({ instanceId, region }: { instanceId: WidgetInstanceId; region: PanelRegion }) => {
  const projectId = useActiveProjectId();
  const activeIdsElsewhere = useActiveProjectSelector(
    (project) => getActiveInstanceIdsOutside(project.widgetRegions, region, project.floatingWidgets),
    areInstanceIdListsEqual
  );
  const mountedIds = withoutInstancesShownElsewhere(
    useMountedInstanceIds(instanceId, projectId),
    instanceId,
    activeIdsElsewhere
  );

  return (
    <>
      {mountedIds.map((id) => (
        <Activity key={id} mode={id === instanceId ? 'visible' : 'hidden'}>
          <WidgetPanelInstance instanceId={id} region={region} />
        </Activity>
      ))}
    </>
  );
};

const WidgetPanelInstance = ({ instanceId, region }: { instanceId: WidgetInstanceId; region: PanelRegion }) => {
  const { t } = useTranslation();
  const instance = useActiveProjectSelector(
    (project) => project.widgetInstances[instanceId],
    areWidgetRenderInstancesEqual
  );
  const widget = instance ? getWidgetById(instance.typeId) : undefined;

  if (!instance || !widget || widget.status !== 'enabled') {
    return <MissingWidgetFrame label={widget ? resolveWidgetLabel(widget.manifest, t) : instanceId} region={region} />;
  }

  return <WidgetRendererById instanceId={instance.id} widget={widget} region={region} />;
};
