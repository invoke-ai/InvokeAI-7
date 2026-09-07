import type { VideoUiAdapter } from '@features/video';
import type { ReactNode } from 'react';

import { invalidateGallery } from '@features/gallery/queries';
import { VideoUiProvider } from '@features/video';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkbenchPreferenceSelector } from '@workbench/settings/store';
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
  useEffect(() => {
    uploadBoardIdRef.current = uploadBoardId;
  }, [uploadBoardId]);
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
  const getUploadBoardId = useCallback(() => uploadBoardIdRef.current, []);
  const adapter = useMemo<VideoUiAdapter>(
    () => ({
      ...project,
      getUploadBoardId,
      patchValues,
      reportError,
      showPromptSyntaxHighlighting,
      touchGalleryImages,
    }),
    [getUploadBoardId, patchValues, project, reportError, showPromptSyntaxHighlighting, touchGalleryImages]
  );

  return <VideoUiProvider adapter={adapter}>{children}</VideoUiProvider>;
};
