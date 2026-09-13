import type { GalleryVideoItem } from '@features/gallery';
import type { VideoWidgetValues } from '@features/video/core/types';
import type { ReactNode } from 'react';

import { createContext, use, useMemo } from 'react';

/**
 * Video's UI port. The context is a dependency-direction port (the feature
 * may not import workbench), not a test seam; no second adapter is expected.
 */
export interface VideoUiAdapter {
  /**
   * The board a file upload from the video panel should land on — the gallery's
   * currently selected board. A callback rather than a value so upload handlers
   * read it at upload time without subscribing to board-selection changes.
   */
  getUploadBoardId(): string;
  patchValues(values: Partial<VideoWidgetValues>, origin?: 'user' | 'system'): void;
  /**
   * Show `item` in the Preview widget and loop the given window of it — how the
   * panel's play buttons let a trim be judged before it is generated against.
   * Selecting the item is part of the gesture: Preview shows the gallery
   * selection, and the panel has no other way to put a clip in front of it.
   */
  playVideoSpanInPreview(span: { endSeconds: number; item: GalleryVideoItem; startSeconds: number }): void;
  projectId: string;
  rawValues: Record<string, unknown>;
  reportError(message: string): void;
  showPromptSyntaxHighlighting: boolean;
  touchGalleryImages(): void;
}

/** The adapter's callbacks, which are stable for the lifetime of a project. */
export type VideoUiActions = Pick<
  VideoUiAdapter,
  'getUploadBoardId' | 'patchValues' | 'playVideoSpanInPreview' | 'reportError' | 'touchGalleryImages'
>;

const VideoUiContext = createContext<VideoUiAdapter | null>(null);
/**
 * Actions are published separately from the adapter because the adapter's
 * identity changes on every value patch (it carries `rawValues`). Components
 * that only need to *do* something — not read state — subscribe here and so are
 * not re-rendered by a keystroke elsewhere in the form.
 */
const VideoUiActionsContext = createContext<VideoUiActions | null>(null);

export const VideoUiProvider = ({ adapter, children }: { adapter: VideoUiAdapter; children: ReactNode }) => {
  const { getUploadBoardId, patchValues, playVideoSpanInPreview, reportError, touchGalleryImages } = adapter;
  const actions = useMemo<VideoUiActions>(
    () => ({ getUploadBoardId, patchValues, playVideoSpanInPreview, reportError, touchGalleryImages }),
    [getUploadBoardId, patchValues, playVideoSpanInPreview, reportError, touchGalleryImages]
  );

  return (
    <VideoUiActionsContext value={actions}>
      <VideoUiContext value={adapter}>{children}</VideoUiContext>
    </VideoUiActionsContext>
  );
};

export const useVideoUi = (): VideoUiAdapter => {
  const adapter = use(VideoUiContext);

  if (!adapter) {
    throw new Error('Video UI requires an App-composed VideoUiProvider.');
  }

  return adapter;
};

export const useVideoUiActions = (): VideoUiActions => {
  const actions = use(VideoUiActionsContext);

  if (!actions) {
    throw new Error('Video UI requires an App-composed VideoUiProvider.');
  }

  return actions;
};
