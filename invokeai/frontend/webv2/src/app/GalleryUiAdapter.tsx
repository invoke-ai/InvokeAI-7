import type { GalleryUiAdapter } from '@features/gallery/react';
import type { ReactNode } from 'react';

import { GalleryUiProvider } from '@features/gallery/react';
import { useActiveProgressTarget } from '@features/queue/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { useExportLibraryProject } from '@workbench/projects/useProjectFileActions';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { getProjectWidgetInstance } from '@workbench/widgetState';
import { useActiveProjectSelector, useWorkbenchCommands, useWorkbenchQueries } from '@workbench/WorkbenchContext';
import { lazy, useMemo } from 'react';

const EMPTY_WIDGET_VALUES: Record<string, unknown> = Object.freeze({});

const GalleryItemActionsAdapter = lazy(() =>
  import('./GalleryImageActionsBridge').then((module) => ({ default: module.GalleryItemActionsAdapter }))
);
const GalleryImageContextMenu = lazy(() =>
  import('./GalleryImageActionsBridge').then((module) => ({ default: module.GalleryImageContextMenu }))
);

/**
 * Production binding of Gallery's UI port: translates Gallery UI intents into
 * the Workbench aggregate. No second adapter is expected.
 */
export const GalleryUiAdapterProvider = ({ children }: { children: ReactNode }) => {
  const {
    projectId,
    projectName,
    galleryValues,
    generateValues,
    queueItems,
    antialiasProgressImages,
    liveFollowEnabled,
  } = useActiveProjectSelector((project) => ({
    projectId: project.id,
    projectName: project.name,
    galleryValues: getProjectWidgetInstance(project, 'gallery')?.state?.values ?? EMPTY_WIDGET_VALUES,
    generateValues: getProjectWidgetInstance(project, 'generate')?.state?.values ?? EMPTY_WIDGET_VALUES,
    queueItems: project.queue.items,
    antialiasProgressImages: project.settings.antialiasProgressImages,
    liveFollowEnabled: project.settings.showProgressImagesInViewer,
  }));
  const liveProgressTarget = useActiveProgressTarget();
  const { account, gallery, notifications, widgets } = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const accountScope = captureAccountScope();
  const exportProject = useExportLibraryProject();
  const openWorkbenchWidget = useOpenWorkbenchWidget();
  // These are `lazy()` children of an adapter that only ever mounts in the
  // editor, and the gallery widget needs them as soon as it renders a row.
  // Left to Suspense they were fetched at ~476ms — a full round trip after the
  // boot widget wave had already finished.
  useMountEffect(() => {
    void import('./GalleryImageActionsBridge');
  });
  const adapter = useMemo<GalleryUiAdapter>(
    () => ({
      account: {
        enableLiveFollow: () => account.updateProjectPreferences({ showProgressImagesInViewer: true }),
      },
      antialiasProgressImages,
      exportProject,
      gallery: {
        ...gallery,
        updateSettings: (settings) => {
          if (isAccountScopeCurrent(accountScope) && queries.isActiveProject(projectId)) {
            gallery.updateSettings(settings, projectId);
          }
        },
      },
      galleryValues,
      generateValues,
      ItemActionsProvider: GalleryItemActionsAdapter,
      ImageContextMenu: GalleryImageContextMenu,
      liveFollowEnabled,
      liveProgressTarget,
      notifications,
      projectId,
      projectName,
      queueItems,
      widgets: {
        openGallery: () => openWorkbenchWidget('gallery').ok,
        patchGalleryValues: (values) => widgets.patchValues('gallery', values),
      },
    }),
    [
      account,
      accountScope,
      antialiasProgressImages,
      exportProject,
      gallery,
      galleryValues,
      generateValues,
      liveFollowEnabled,
      liveProgressTarget,
      notifications,
      openWorkbenchWidget,
      projectId,
      projectName,
      queueItems,
      queries,
      widgets,
    ]
  );

  return <GalleryUiProvider adapter={adapter}>{children}</GalleryUiProvider>;
};
