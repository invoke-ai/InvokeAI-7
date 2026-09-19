import type {
  GraphBearingSurfaceContract,
  WidgetInstanceRuntimeMeta,
  WidgetHeaderMenu,
  WidgetManifest,
  WidgetRuntimeApi,
  WorkbenchRegion,
} from '@workbench/widgetContracts';

import { Icon, Menu, Portal, Text } from '@chakra-ui/react';
import { flushWorkbenchDrafts } from '@platform/react/draftRegistry';
import { IconButton } from '@platform/ui/Button';
import { MenuContent } from '@platform/ui/Menu';
import { toaster } from '@platform/ui/toaster';
import { createGraphBearingSurface } from '@workbench/graphSurfaces';
import { resolveWidgetLabel } from '@workbench/widgetLabels';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { GitBranchIcon, MoreHorizontalIcon, TargetIcon } from 'lucide-react';
import { Component, lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The widget frame's shared header actions menu. It hosts the universal
 * graph-bearing actions (`Set Source`, `View Graph`) and any extra entries the
 * widget's manifest contributes via `headerMenu` — one menu per widget, so
 * widgets extend the frame instead of stacking their own menus and toolbars.
 *
 * Floating is not among them: it is a mode toggle, so it renders as its own
 * header icon ({@link WidgetFloatButton}) opposite the floating window's dock
 * control rather than as a menu item.
 */

const GraphPreviewHost = lazy(() => import('./GraphPreviewHost'));

/**
 * The preview is a dialog over the widget, not part of it: a throw inside it
 * (a failed chunk load, a compile edge case that escaped the source) surfaces
 * as a toast and drops the dialog, instead of climbing to the widget's
 * failure boundary and replacing the whole widget with a failure card. An
 * error unmounts the host, so the next open starts a fresh boundary.
 */
class GraphPreviewBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { hasFailed: boolean }
> {
  state = { hasFailed: false };

  static getDerivedStateFromError(): { hasFailed: boolean } {
    return { hasFailed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasFailed ? null : this.props.children;
  }
}

const MENU_POSITIONING = { placement: 'bottom-end' } as const;
const DISABLED_PROPS = { opacity: 0.4 };

const GraphSurfaceMenuItems = ({
  surface,
  onPreview,
}: {
  surface: GraphBearingSurfaceContract;
  onPreview: () => void;
}) => {
  const { t } = useTranslation();
  const activeSourceId = useActiveProjectSelector((project) => project.invocation.sourceId);
  const { generation } = useWorkbenchCommands();
  const isActiveSource = activeSourceId === surface.sourceId;
  const handleSetSource = useCallback(() => generation.setSource(surface.sourceId), [generation, surface.sourceId]);

  return (
    <Menu.ItemGroup>
      <Menu.ItemGroupLabel color="fg.subtle" fontSize="2xs" textTransform="uppercase">
        {t('common.graph')}
      </Menu.ItemGroupLabel>
      <Menu.Item
        value="set-source"
        disabled={isActiveSource || !surface.canSetSource}
        _disabled={DISABLED_PROPS}
        onClick={handleSetSource}
      >
        <Icon as={TargetIcon} boxSize="3.5" />
        <Menu.ItemText>{t('widgets.graph.setSource')}</Menu.ItemText>
        {isActiveSource ? (
          <Text color="fg.subtle" fontSize="2xs" ms="auto">
            {t('common.active')}
          </Text>
        ) : null}
      </Menu.Item>
      <Menu.Item value="view-graph" disabled={!surface.canPreviewGraph} onClick={onPreview}>
        <Icon as={GitBranchIcon} boxSize="3.5" />
        <Menu.ItemText>{t('widgets.graph.viewGraph')}</Menu.ItemText>
      </Menu.Item>
    </Menu.ItemGroup>
  );
};

export const WidgetActionsMenu = ({
  HeaderMenu,
  instance,
  manifest,
  region,
  runtime,
}: {
  HeaderMenu?: WidgetHeaderMenu;
  instance: WidgetInstanceRuntimeMeta;
  manifest: WidgetManifest;
  region: WorkbenchRegion;
  runtime: WidgetRuntimeApi;
}) => {
  const { t } = useTranslation();
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  // Mount outlives `isPreviewOpen`: dropping the host the moment the dialog
  // closes cancels its exit transition, so the preview blinked out of
  // existence. The host reports when the transition is done instead.
  const [isPreviewMounted, setIsPreviewMounted] = useState(false);
  const label = resolveWidgetLabel(manifest, t);
  const surface = useMemo(
    () =>
      manifest.graphBearing?.surfaces.includes(region) ? createGraphBearingSurface(manifest, region, label) : null,
    [label, manifest, region]
  );
  const handlePreview = useCallback(() => {
    flushWorkbenchDrafts();
    setIsPreviewMounted(true);
    setIsPreviewOpen(true);
  }, []);
  // Guarded on `isPreviewOpen`: re-opening the preview while it is still
  // animating out must not have the late exit report drop its mount.
  const handlePreviewExitComplete = useCallback(() => {
    if (!isPreviewOpen) {
      setIsPreviewMounted(false);
    }
  }, [isPreviewOpen]);
  const handlePreviewError = useCallback(
    (error: Error) => {
      toaster.create({ description: error.message, title: t('widgets.graph.previewFailed'), type: 'error' });
      setIsPreviewOpen(false);
      setIsPreviewMounted(false);
    },
    [t]
  );

  if (!surface && !HeaderMenu) {
    return null;
  }

  return (
    <>
      <Menu.Root positioning={MENU_POSITIONING}>
        <Menu.Trigger asChild>
          <IconButton aria-label={t('widgets.actionsLabel', { label })} color="fg.muted" size="2xs" variant="ghost">
            <MoreHorizontalIcon />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <MenuContent minW="13rem">
              {surface ? <GraphSurfaceMenuItems surface={surface} onPreview={handlePreview} /> : null}
              {surface && HeaderMenu ? <Menu.Separator borderColor="border.subtle" /> : null}
              {HeaderMenu ? (
                <HeaderMenu instance={instance} manifest={manifest} region={region} runtime={runtime} />
              ) : null}
            </MenuContent>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      {surface && isPreviewMounted ? (
        <GraphPreviewBoundary onError={handlePreviewError}>
          <Suspense fallback={null}>
            <GraphPreviewHost
              isOpen={isPreviewOpen}
              surface={surface}
              onExitComplete={handlePreviewExitComplete}
              onOpenChange={setIsPreviewOpen}
            />
          </Suspense>
        </GraphPreviewBoundary>
      ) : null}
    </>
  );
};
