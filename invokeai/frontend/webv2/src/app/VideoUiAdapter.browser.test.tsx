import type { GalleryVideoItem } from '@features/gallery';
import type { VideoUiAdapter } from '@features/video';
import type { OpenWorkbenchWidgetResult } from '@workbench/useOpenWorkbenchWidget';
import type { ReactNode } from 'react';

import { getGalleryRevealRequest } from '@features/gallery/core/selection';
import {
  consumeVideoSpanPlaybackRequest,
  getVideoSpanPlaybackRequest,
} from '@workbench/widgets/preview/spanPlaybackRequest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoUiAdapterProvider } from './VideoUiAdapter';

/**
 * The panel's play button is one gesture spread over three subsystems — the Preview
 * widget's placement, gallery selection, and the span request the player reads — and this
 * adapter is the only place they are put in order. What it has to protect is the user's
 * gallery selection: it is theirs, it persists, and moving it is not undoable.
 *
 * A browser test because the provider has to render, and the unit config carries no DOM —
 * the same reason `GalleryUiAdapter.browser.test.tsx` lives there.
 */

let adapter: VideoUiAdapter;
let openResult: OpenWorkbenchWidgetResult;
let activeProjectId: string;

const openWorkbenchWidget = vi.fn(() => openResult);
const selectItem = vi.fn();

vi.mock('@features/video', () => ({
  VideoUiProvider: ({ adapter: next, children }: { adapter: VideoUiAdapter; children: ReactNode }) => {
    adapter = next;
    return children;
  },
}));
vi.mock('@features/gallery/queries', () => ({ invalidateGallery: vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@workbench/settings/store', () => ({ useWorkbenchPreferenceSelector: () => false }));
vi.mock('@workbench/useOpenWorkbenchWidget', () => ({ useOpenWorkbenchWidget: () => openWorkbenchWidget }));
vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: unknown) => unknown) =>
    selector({ id: activeProjectId, widgetInstances: {} }),
  useWorkbenchCommands: () => ({
    gallery: { selectItem },
    notifications: { reportError: vi.fn() },
    widgets: { patchValues: vi.fn() },
  }),
}));

const videoItem = { kind: 'video', name: 'clip.mp4' } as unknown as GalleryVideoItem;
const span = { endSeconds: 3, item: videoItem, startSeconds: 2 };

let host: HTMLDivElement;
let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderAdapter = async (): Promise<void> => {
  await act(() => root.render(<VideoUiAdapterProvider>{null}</VideoUiAdapterProvider>));
};

beforeEach(async () => {
  openResult = { ok: true, region: 'center' };
  activeProjectId = 'project-1';
  openWorkbenchWidget.mockClear();
  selectItem.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await renderAdapter();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();

  const outstanding = getVideoSpanPlaybackRequest();

  if (outstanding) {
    consumeVideoSpanPlaybackRequest(outstanding.token);
  }
});

describe('playVideoSpanInPreview', () => {
  it('puts the clip in front of the user without disturbing their place in the gallery', () => {
    const revealBefore = getGalleryRevealRequest()?.token;

    act(() => adapter.playVideoSpanInPreview(span));

    expect(selectItem).toHaveBeenCalledWith(videoItem, 'project-1');
    expect(getVideoSpanPlaybackRequest()).toMatchObject({
      endSeconds: 3,
      itemKey: 'video:clip.mp4',
      startSeconds: 2,
    });
    // Deliberately no reveal: auditioning a trim must not scroll the gallery grid out
    // from under a user who is browsing it, and the gallery's own "open in Preview"
    // does not reveal either.
    expect(getGalleryRevealRequest()?.token).toBe(revealBefore);
  });

  it('changes nothing at all when Preview refuses to open', () => {
    openResult = { ok: false, reason: 'unavailable' };

    act(() => adapter.playVideoSpanInPreview(span));

    // A press that cannot play must not cost the user their selection — that is a change
    // they did not ask for and cannot undo. And a span nothing is there to read would sit
    // until the next player showed this clip, starting audio out of nowhere.
    expect(selectItem).not.toHaveBeenCalled();
    expect(getVideoSpanPlaybackRequest()).toBeNull();
  });

  it('drops a press whose lookup landed after the user switched projects', async () => {
    // The button resolves its gallery item over the network and calls back with the
    // callback it captured. Writing that selection now would land it in the project the
    // user just left, where it persists.
    const stalePress = adapter.playVideoSpanInPreview;

    activeProjectId = 'project-2';
    await renderAdapter();

    act(() => stalePress(span));

    expect(selectItem).not.toHaveBeenCalled();
    expect(getVideoSpanPlaybackRequest()).toBeNull();
  });
});
