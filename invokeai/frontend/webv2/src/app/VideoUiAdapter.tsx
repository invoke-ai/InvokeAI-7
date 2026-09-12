import type { VideoUiAdapter } from '@features/video';
import type { ReactNode } from 'react';

import { toGalleryItemKey } from '@features/gallery/contracts';
import { invalidateGallery } from '@features/gallery/queries';
import { VideoUiProvider } from '@features/video';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkbenchPreferenceSelector } from '@workbench/settings/store';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { requestVideoSpanPlayback } from '@workbench/widgets/preview/spanPlaybackRequest';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Production binding of Video's UI port: maps the video widget instance out of
 * the Workbench aggregate. No second adapter is expected. Video's prompt is one
 * of those widget values — it is not the project draft Generate and Upscale
 * share — so nothing but `rawValues` is joined here.
 */
export const VideoUiAdapterProvider = ({ children }: { children: ReactNode }) => {
  const project = useActiveProjectSelector(
    (activeProject) => {
      const instance = Object.values(activeProject.widgetInstances).find((candidate) => candidate.typeId === 'video');

      return {
        projectId: activeProject.id,
        rawValues: instance?.state.values ?? {},
      };
    },
    (left, right) => left.projectId === right.projectId && left.rawValues === right.rawValues
  );
  // Syntax highlighting is a per-user preference, not a property of the
  // project, so it is joined here rather than read off the document.
  const showPromptSyntaxHighlighting = useWorkbenchPreferenceSelector(
    (preferences) => preferences.showPromptSyntaxHighlighting
  );
  // Uploads from the video panel land on the gallery's currently selected board. This
  // deliberately reads the RAW selectedBoardId — the same value the queue snapshots as
  // galleryBoardId for generation results — so uploads and generations land on the same
  // board, rather than replicating the gallery view's display-side fallbacks.
  const uploadBoardId = useActiveProjectSelector((activeProject) => {
    const selectedBoardId = getProjectWidgetValues(activeProject, 'gallery').selectedBoardId;

    return typeof selectedBoardId === 'string' ? selectedBoardId : 'none';
  });
  // Ref-backed so the port's actions keep their stable-for-the-project identity: a
  // board click must not re-render every useVideoUiActions consumer in the panel.
  const uploadBoardIdRef = useRef(uploadBoardId);
  // The live project, for callbacks that outlive the render that built them: a play press
  // resolves its clip over the network and can land after a project switch.
  const activeProjectIdRef = useRef(project.projectId);
  useEffect(() => {
    uploadBoardIdRef.current = uploadBoardId;
    activeProjectIdRef.current = project.projectId;
  }, [project.projectId, uploadBoardId]);
  const commands = useWorkbenchCommands();
  const queryClient = useQueryClient();
  // The port's callbacks are keyed to the project, not to its contents: rebuilding
  // them whenever `rawValues` changes would hand every consumer new function
  // identities on each keystroke, re-rendering memoized fields that did not change.
  const { projectId } = project;
  const patchValues = useCallback<VideoUiAdapter['patchValues']>(
    (values, origin) => commands.widgets.patchValues('video', values, projectId, origin),
    [commands, projectId]
  );
  const reportError = useCallback<VideoUiAdapter['reportError']>(
    (message) => commands.notifications.reportError({ area: 'video', message, namespace: 'generation' }),
    [commands]
  );
  const touchGalleryImages = useCallback(() => void invalidateGallery(queryClient), [queryClient]);
  const openWorkbenchWidget = useOpenWorkbenchWidget();
  // Preview renders the gallery selection, so putting a reference clip in front of the user
  // is the gallery's own "open in Preview" gesture: select the item, raise the widget into
  // the center view. Deliberately WITHOUT that gesture's sibling reveal — auditioning a
  // trim should not also scroll the gallery grid out from under a browsing user, and
  // `openItemInPreview` does not reveal either.
  //
  // Raising Preview comes first so a refusal costs the user nothing: the selection is
  // theirs, and moving it for a press that cannot play would be a change they did not ask
  // for and cannot undo. The span request goes last, once the widget is on its way.
  const playVideoSpanInPreview = useCallback<VideoUiAdapter['playVideoSpanInPreview']>(
    ({ endSeconds, item, startSeconds }) => {
      // The press resolved its gallery item over the network, and the user can have
      // switched projects in that window. This callback still carries the project it was
      // built for, so writing a selection now would land it in the project they left.
      if (activeProjectIdRef.current !== projectId) {
        return;
      }

      if (!openWorkbenchWidget('preview', { preferredRegions: ['center'], requireCenterView: true }).ok) {
        return;
      }

      commands.gallery.selectItem(item, projectId);
      requestVideoSpanPlayback({ endSeconds, itemKey: toGalleryItemKey(item), startSeconds });
    },
    [commands, openWorkbenchWidget, projectId]
  );
  const getUploadBoardId = useCallback(() => uploadBoardIdRef.current, []);
  const adapter = useMemo<VideoUiAdapter>(
    () => ({
      ...project,
      getUploadBoardId,
      patchValues,
      playVideoSpanInPreview,
      reportError,
      showPromptSyntaxHighlighting,
      touchGalleryImages,
    }),
    [
      getUploadBoardId,
      patchValues,
      playVideoSpanInPreview,
      project,
      reportError,
      showPromptSyntaxHighlighting,
      touchGalleryImages,
    ]
  );

  return <VideoUiProvider adapter={adapter}>{children}</VideoUiProvider>;
};
