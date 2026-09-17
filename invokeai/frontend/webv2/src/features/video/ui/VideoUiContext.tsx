import type { GalleryItemRef, GalleryVideoItem } from '@features/gallery';
import type { VideoWidgetValues } from '@features/video/core/types';
import type { ReactNode } from 'react';

import { createContext, use, useMemo } from 'react';

/**
 * Video's UI port. The context is a dependency-direction port (the feature
 * may not import workbench), not a test seam; no second adapter is expected.
 */
export interface VideoUiAdapter {
  /**
   * Locate one of the panel's conditioning media in the Gallery grid and put it
   * in front of the user: the Gallery and Preview widgets come on screen and
   * the grid lands on the item's board, page, and cell. The panel's thumbnails
   * are the only handle the user has on media picked long ago.
   */
  findInGallery(ref: GalleryItemRef): void;
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
   *
   * Returns the request's token, which `videoSpanPlayback` reports under once
   * the player has the loop running; `null` when Preview could not be raised
   * and nothing was asked of it.
   */
  playVideoSpanInPreview(span: { endSeconds: number; item: GalleryVideoItem; startSeconds: number }): number | null;
  projectId: string;
  rawValues: Record<string, unknown>;
  reportError(message: string): void;
  showPromptSyntaxHighlighting: boolean;
  touchGalleryImages(): void;
  /** What Preview is doing with the last span it was asked to play, for the button that asked. */
  videoSpanPlayback: VideoSpanPlaybackPort;
}

/**
 * The player's side of a span request: reported under the request's token, so a button
 * can tell its own loop from a sibling card's, and gone (`null`) once nothing is armed —
 * the user scrubbed out of the window, a newer request took over, or the player left the
 * screen. `isPlaying` tracks the element itself, so a native pause shows in the panel
 * too; `pause` stops the element and leaves the loop armed, so a native play resumes the
 * selection rather than the whole clip.
 */
export interface VideoSpanPlaybackState {
  isPlaying: boolean;
  pause(): void;
  token: number;
}

export interface VideoSpanPlaybackPort {
  getState(): VideoSpanPlaybackState | null;
  subscribe(listener: () => void): () => void;
}

/** The adapter's callbacks, which are stable for the lifetime of a project. */
export type VideoUiActions = Pick<
  VideoUiAdapter,
  | 'findInGallery'
  | 'getUploadBoardId'
  | 'patchValues'
  | 'playVideoSpanInPreview'
  | 'reportError'
  | 'touchGalleryImages'
  | 'videoSpanPlayback'
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
  const {
    findInGallery,
    getUploadBoardId,
    patchValues,
    playVideoSpanInPreview,
    reportError,
    touchGalleryImages,
    videoSpanPlayback,
  } = adapter;
  const actions = useMemo<VideoUiActions>(
    () => ({
      findInGallery,
      getUploadBoardId,
      patchValues,
      playVideoSpanInPreview,
      reportError,
      touchGalleryImages,
      videoSpanPlayback,
    }),
    [
      findInGallery,
      getUploadBoardId,
      patchValues,
      playVideoSpanInPreview,
      reportError,
      touchGalleryImages,
      videoSpanPlayback,
    ]
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
