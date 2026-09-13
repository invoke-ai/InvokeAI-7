/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { GalleryItemKey } from '@features/gallery';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext, PointerSensor, useDndMonitor, useSensor, useSensors, type DragStartEvent } from '@dnd-kit/core';
import { system } from '@theme/system';
import { createInstance } from 'i18next';
import { act, Activity, createRef, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PreviewFrame,
  type PreviewMediaSource,
  type PreviewVideoFrameController,
  type PreviewVideoFrameCopyResult,
} from './PreviewFrame';
import {
  consumeVideoSpanPlaybackRequest,
  getVideoSpanPlaybackRequest,
  requestVideoSpanPlayback,
} from './spanPlaybackRequest';

const identityMocks = vi.hoisted(() => ({
  accountEpoch: 7,
  refreshProtectedMediaCookie: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('@features/identity', () => ({
  getAuthSession: () => ({ accountEpoch: identityMocks.accountEpoch }),
  refreshProtectedMediaCookie: identityMocks.refreshProtectedMediaCookie,
}));

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  initAsync: false,
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          preview: {
            dropToCompare: 'Drop to compare',
            resetZoom: 'Reset zoom',
            videoFailed: 'Video could not be loaded',
            videoRetry: 'Retry',
          },
        },
      },
    },
  },
});

type VideoSource = Extract<PreviewMediaSource, { kind: 'video' }>;

const videoSource: VideoSource = {
  itemKey: 'video:clip.mp4' as const,
  kind: 'video' as const,
  label: 'Video clip.mp4',
  poster: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>',
  src: 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA',
};
const invalidVideoSource: VideoSource = { ...videoSource, src: 'data:video/mp4;base64,AAAA' };

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let onDragStart = vi.fn();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const interact = (action: () => void, delay = 0): Promise<void> =>
  act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, delay);
    });
  });

const pointer = (type: string, target: EventTarget, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, isPrimary: true, pointerId: 1 })
  );
};

const DragMonitor = () => {
  useDndMonitor({
    onDragStart: (event: DragStartEvent) => onDragStart(event.active.data.current),
  });
  return null;
};

const VideoHarness = ({
  isItemCurrent = () => true,
  onCopyAvailabilityChange,
  source = videoSource,
  videoControllerRef,
}: {
  isItemCurrent?: (itemKey: GalleryItemKey) => boolean;
  onCopyAvailabilityChange?: (itemKey: GalleryItemKey, isAvailable: boolean) => void;
  source?: VideoSource;
  videoControllerRef?: Ref<PreviewVideoFrameController>;
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  return (
    <DndContext sensors={sensors}>
      <DragMonitor />
      <div style={{ display: 'flex', height: 260, width: 420 }}>
        <PreviewFrame
          frameHeight={1080}
          frameWidth={1920}
          isLive={false}
          shouldAntialiasLiveImage
          source={source}
          variant="framed"
          isItemCurrent={isItemCurrent}
          onVideoCopyAvailabilityChange={onCopyAvailabilityChange}
          videoControllerRef={videoControllerRef}
        />
      </div>
    </DndContext>
  );
};

beforeEach(() => {
  identityMocks.accountEpoch = 7;
  identityMocks.refreshProtectedMediaCookie.mockReset().mockResolvedValue(true);
  onDragStart = vi.fn();
  host = document.createElement('div');
  host.style.cssText = 'height:320px;left:20px;position:fixed;top:20px;width:480px;';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await interact(() => root?.unmount());
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSpanRequest();
  host?.remove();
  host = null;
  root = null;
});

describe('PreviewFrame native video arm', () => {
  it('renders the native player with the protected media contract attributes', async () => {
    await interact(() => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <ChakraProvider value={system}>
            <VideoHarness />
          </ChakraProvider>
        </I18nextProvider>
      );
    });

    const video = host?.querySelector<HTMLVideoElement>('video');

    expect(video).not.toBeNull();
    expect(host?.querySelectorAll('video')).toHaveLength(1);
    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.getAttribute('poster')).toBe(videoSource.poster);
    expect(video?.getAttribute('src')).toBe(videoSource.src);
    expect(video?.getAttribute('aria-label')).toBe(videoSource.label);
    expect(host?.querySelector('img[alt="Video clip.mp4"]')).toBeNull();
  });

  it("seeks past the poster to the video's own first frame once metadata lands", async () => {
    await renderVideo();
    const video = getVideo();
    const position = stubPlaybackPosition(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    // `preload="metadata"` alone leaves the 256px poster on screen, upscaled to the whole
    // stage. The nudge makes the decoder paint frame 0 at the video's native resolution.
    expect(position.get()).toBeGreaterThan(0);
    expect(position.get()).toBeLessThan(0.001);
    // The poster is still the placeholder for the moment before that frame lands, and the
    // still behind the failure state — the seek supersedes it, it is not removed.
    expect(video.getAttribute('poster')).toBe(videoSource.poster);
  });

  it('leaves the playhead alone when the user started playback before metadata arrived', async () => {
    await renderVideo();
    const video = getVideo();
    // The one interleaving where `loadedmetadata` observes a non-paused element: `load()`
    // resets position and pause state before it fires, so a viewer mid-playback is already
    // back at zero by then and there is no playhead left for the guard to protect.
    const position = stubPlaybackPosition(video, { paused: false });

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    expect(position.get()).toBe(0);
  });

  it('plays and loops the span a request published before the player mounted asked for', async () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    // Published before the mount, because the Video panel selects the clip and raises
    // Preview first: the player has to read the standing request on its first pass.
    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    expect(playback.getTime()).toBe(2);
    expect(playback.play).toHaveBeenCalledTimes(1);
    // Retired on arrival, so the next player to show this clip does not replay it.
    expect(getVideoSpanPlaybackRequest()).toBeNull();

    await interact(() => {
      playback.setTime(4.02);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(2);
  });

  it('applies a span published while the clip is already on screen', async () => {
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => requestVideoSpanPlayback({ endSeconds: 7, itemKey: videoSource.itemKey, startSeconds: 5 }));

    expect(playback.getTime()).toBe(5);
    expect(playback.play).toHaveBeenCalledTimes(1);
  });

  it('clamps the span to the clip and ignores a request aimed at another item', async () => {
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video, { duration: 6 });

    await interact(() => requestVideoSpanPlayback({ endSeconds: 9, itemKey: 'video:other.mp4', startSeconds: 8 }));

    expect(playback.play).not.toHaveBeenCalled();
    // Left standing: it belongs to whichever player shows that clip, not to this one.
    expect(getVideoSpanPlaybackRequest()?.itemKey).toBe('video:other.mp4');
    clearSpanRequest();

    // A panel frame count is an estimate (duration x fps), so a window can run past the
    // clip's real end; the loop has to wrap there rather than at the requested end.
    await interact(() => requestVideoSpanPlayback({ endSeconds: 9, itemKey: videoSource.itemKey, startSeconds: 5 }));
    expect(playback.getTime()).toBe(5);

    await interact(() => {
      playback.setTime(6);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(5);
  });

  it('drops a request the user has long since moved on from', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    vi.setSystemTime(Date.now() + 60_000);

    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    // Preview may have been closed the whole time. Starting audio now would come out of
    // nowhere — but the request still has to be retired, not left to fire later.
    expect(playback.play).not.toHaveBeenCalled();
    expect(getVideoSpanPlaybackRequest()).toBeNull();
    expect(playback.getTime()).toBeLessThan(0.001);
  });

  it('holds a span that arrives before metadata and prefers it to the first-frame nudge', async () => {
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video, { readyState: HTMLMediaElement.HAVE_NOTHING });

    await interact(() => requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 }));

    // Nothing to clamp against and the element drops the seek outright before metadata.
    expect(playback.getTime()).toBe(0);
    expect(playback.play).not.toHaveBeenCalled();

    playback.setReadyState(HTMLMediaElement.HAVE_METADATA);
    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    expect(playback.getTime()).toBe(2);
    expect(playback.play).toHaveBeenCalledTimes(1);
  });

  it('wraps on its own animation frame, without waiting for a timeupdate', async () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(playback.getTime()).toBe(2);

    // `timeupdate` fires about four times a second and would overrun this window by an
    // eighth of it; the frame loop is what keeps the wrap tight, and nothing else here
    // exercises it.
    await interact(() => playback.setTime(4.01));
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });

    expect(playback.getTime()).toBe(2);
  });

  it('keeps looping across a pause and a resume', async () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    await interact(() => playback.pause());
    // Pausing to look at a frame is not handing the playhead back — only scrubbing is.
    await interact(() => void video.play());
    await interact(() => {
      playback.setTime(4.02);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(2);
  });

  it('wraps a window that ends on the clip itself', async () => {
    requestVideoSpanPlayback({ endSeconds: 10, itemKey: videoSource.itemKey, startSeconds: 8 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video, { duration: 10 });

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(playback.getTime()).toBe(8);

    // The playhead reaches this window's end only as the media ends, where `pause` has
    // already stopped the watch — without an `ended` handler whether it wrapped was down
    // to which event the browser delivered first.
    await interact(() => playback.playToEnd());

    expect(playback.getTime()).toBe(8);
    expect(playback.play).toHaveBeenCalledTimes(2);
  });

  it('keeps the window scoped across a protected-media reload', async () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);
    vi.spyOn(video, 'load').mockImplementation(() => {
      playback.reload();
      video.dispatchEvent(new Event('loadedmetadata'));
    });

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(playback.getTime()).toBe(2);

    // A cookie refresh mid-loop rewinds the clip and refires `loadedmetadata`. The
    // first-frame poster nudge used to run there, and its unmarked seek read as the user
    // taking the playhead back — the loop was abandoned and the clip sat on frame 0.
    await interact(() => video.dispatchEvent(new Event('error')));
    await interact(() => undefined);

    // Back inside the window, and still paused, exactly as `load()` left it.
    expect(playback.getTime()).toBe(2);

    await interact(() => void video.play());
    await interact(() => {
      playback.setTime(4.02);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(2);
  });

  it('does not replay a span parked behind a failed load once the gesture is stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video, { readyState: HTMLMediaElement.HAVE_NOTHING });

    await interact(() => requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 }));
    expect(playback.play).not.toHaveBeenCalled();

    // The request itself was consumed on arrival, so only the parked span is left to keep
    // the gesture honest — a Retry pressed ten minutes later must not start audio.
    vi.setSystemTime(Date.now() + 600_000);
    playback.setReadyState(HTMLMediaElement.HAVE_METADATA);
    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));

    expect(playback.play).not.toHaveBeenCalled();
    expect(playback.getTime()).toBeLessThan(0.001);
  });

  it('still honours the user when a span seek fires no seeking event', async () => {
    // The Initial Video's trim starts at frame 0, so the very first press seeks the
    // playhead to where it already sits. A marker left standing there would swallow the
    // user's next real scrub and haul them back into the window.
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 0 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    playback.setSilentSeek(true);
    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    playback.setSilentSeek(false);

    await interact(() => playback.scrubTo(8));
    await interact(() => {
      playback.setTime(9);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(9);
  });

  it('loops a window as tight as the panel can make one', async () => {
    // The panel's floor is two frames (`MIN_VIDEO_TRIM_FRAMES`), which at 60fps is 33ms —
    // narrower than any width threshold worth writing down, and precisely the selection
    // the two still bounds convey least. A width floor here silently played the whole
    // remainder of the clip instead, with audio.
    requestVideoSpanPlayback({ endSeconds: 2 + 2 / 60, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    await interact(() => {
      playback.setTime(2.1);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(2);
  });

  it("does not extend a parked span's deadline by re-showing the view", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video, { readyState: HTMLMediaElement.HAVE_NOTHING });

    await interact(() => requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 }));

    // Hiding and re-showing re-parks the span. Its deadline belongs to the press, so a
    // clip that never loads cannot have it renewed indefinitely.
    vi.setSystemTime(Date.now() + 10_000);
    await renderVideo();
    vi.setSystemTime(Date.now() + 10_000);

    const reshown = getVideo();
    const reshownPlayback = stubSpanPlayback(reshown, { readyState: HTMLMediaElement.HAVE_METADATA });

    await interact(() => reshown.dispatchEvent(new Event('loadedmetadata')));

    expect(reshownPlayback.play).not.toHaveBeenCalled();
    expect(playback.play).not.toHaveBeenCalled();
  });

  it('hands the playhead back for good once the user scrubs', async () => {
    requestVideoSpanPlayback({ endSeconds: 4, itemKey: videoSource.itemKey, startSeconds: 2 });
    await renderVideo();
    const video = getVideo();
    const playback = stubSpanPlayback(video);

    await interact(() => video.dispatchEvent(new Event('loadedmetadata')));
    expect(playback.getTime()).toBe(2);

    await interact(() => playback.scrubTo(8));
    await interact(() => {
      playback.setTime(9);
      video.dispatchEvent(new Event('timeupdate'));
    });

    expect(playback.getTime()).toBe(9);
  });

  it('does not arm a drag or cancel wheel events from the video surface and native controls', async () => {
    await interact(() => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <ChakraProvider value={system}>
            <VideoHarness />
          </ChakraProvider>
        </I18nextProvider>
      );
    });

    const video = host!.querySelector<HTMLVideoElement>('video')!;
    const content = video.parentElement;

    expect(content).not.toBeNull();
    expect(content ? getComputedStyle(content).touchAction : '').not.toBe('none');

    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    video.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);

    await interact(() => pointer('pointerdown', video, 220, 230), 20);
    await interact(() => pointer('pointermove', video.ownerDocument, 260, 230), 50);
    await interact(() => pointer('pointerup', video.ownerDocument, 260, 230), 300);

    expect(onDragStart).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Drop to compare');
  });

  it('lets a trusted browser media error enter protected-media recovery', async () => {
    const trustedErrors: Event[] = [];
    const recordTrustedMediaError = (event: Event): void => {
      if (event.isTrusted && event.target instanceof HTMLMediaElement) {
        trustedErrors.push(event);
      }
    };
    document.addEventListener('error', recordTrustedMediaError, true);
    identityMocks.refreshProtectedMediaCookie.mockResolvedValueOnce(false);

    try {
      await renderVideo(() => true, invalidVideoSource);
      await act(async () => {
        await vi.waitFor(
          () => {
            expect(trustedErrors.length).toBeGreaterThan(0);
            expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledOnce();
          },
          { timeout: 5_000 }
        );
      });
    } finally {
      document.removeEventListener('error', recordTrustedMediaError, true);
    }
  });

  it('refreshes the protected-media cookie once and reloads after the first media failure', async () => {
    const refresh = deferred<boolean>();
    identityMocks.refreshProtectedMediaCookie.mockReturnValueOnce(refresh.promise);
    await renderVideo();
    const video = getVideo();
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);

    await interact(() => video.dispatchEvent(new Event('error')));

    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();

    await interact(() => refresh.resolve(true));

    expect(load).toHaveBeenCalledTimes(1);
    expect(host?.textContent).not.toContain('Video could not be loaded');
  });

  it('does not reload or publish failure after the account changes while refresh is pending', async () => {
    const refresh = deferred<boolean>();
    identityMocks.refreshProtectedMediaCookie.mockReturnValueOnce(refresh.promise);
    await renderVideo();
    const video = getVideo();
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);

    await interact(() => video.dispatchEvent(new Event('error')));
    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(1);
    identityMocks.accountEpoch = 8;
    await interact(() => refresh.resolve(true));

    expect(load).not.toHaveBeenCalled();
    expect(host?.textContent).not.toContain('Video could not be loaded');
  });

  it('does not reload or publish failure after a different item becomes current', async () => {
    let isCurrent = true;
    const refresh = deferred<boolean>();
    identityMocks.refreshProtectedMediaCookie.mockReturnValueOnce(refresh.promise);
    await renderVideo(() => isCurrent);
    const video = getVideo();
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);

    await interact(() => video.dispatchEvent(new Event('error')));
    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(1);
    isCurrent = false;
    await interact(() => refresh.resolve(true));

    expect(load).not.toHaveBeenCalled();
    expect(host?.textContent).not.toContain('Video could not be loaded');
  });

  it('shows a poster-backed failure state when refresh fails or the automatic reload fails', async () => {
    identityMocks.refreshProtectedMediaCookie.mockResolvedValueOnce(false);
    await renderVideo();
    const firstVideo = getVideo();
    vi.spyOn(firstVideo, 'load').mockImplementation(() => undefined);

    await interact(() => firstVideo.dispatchEvent(new Event('error')));

    expect(host?.textContent).toContain('Video could not be loaded');
    expect(host?.querySelector<HTMLButtonElement>('button')?.textContent).toBe('Retry');
    expect(
      [...(host?.querySelectorAll<HTMLImageElement>('img') ?? [])].some(
        (image) => image.getAttribute('src') === videoSource.poster
      )
    ).toBe(true);

    identityMocks.refreshProtectedMediaCookie.mockResolvedValueOnce(true);
    await renderVideo(() => true, { ...videoSource, itemKey: 'video:second.mp4' });
    const secondVideo = getVideo();
    const load = vi.spyOn(secondVideo, 'load').mockImplementation(() => undefined);

    await interact(() => secondVideo.dispatchEvent(new Event('error')));
    expect(load).toHaveBeenCalledTimes(1);
    await interact(() => secondVideo.dispatchEvent(new Event('error')));

    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(2);
    expect(host?.textContent).toContain('Video could not be loaded');
  });

  it('gives a manual retry a fresh automatic refresh budget', async () => {
    await renderVideo();
    const video = getVideo();
    const load = vi.spyOn(video, 'load').mockImplementation(() => undefined);

    await interact(() => video.dispatchEvent(new Event('error')));
    await interact(() => video.dispatchEvent(new Event('error')));
    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(1);

    await interact(() => host?.querySelector<HTMLButtonElement>('button')?.click());
    expect(load).toHaveBeenCalledTimes(2);
    expect(host?.textContent).not.toContain('Video could not be loaded');

    const secondRefresh = deferred<boolean>();
    identityMocks.refreshProtectedMediaCookie.mockReturnValueOnce(secondRefresh.promise);
    await interact(() => video.dispatchEvent(new Event('error')));
    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(2);
    await interact(() => secondRefresh.resolve(true));

    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keys retry state to the selected video item', async () => {
    await renderVideo();
    const firstVideo = getVideo();
    vi.spyOn(firstVideo, 'load').mockImplementation(() => undefined);

    await interact(() => firstVideo.dispatchEvent(new Event('error')));
    await interact(() => firstVideo.dispatchEvent(new Event('error')));
    expect(host?.textContent).toContain('Video could not be loaded');

    const nextSource = {
      ...videoSource,
      itemKey: 'video:next.mp4' as const,
      label: 'Video next.mp4',
    };
    await renderVideo(() => true, nextSource);
    const nextVideo = getVideo();
    vi.spyOn(nextVideo, 'load').mockImplementation(() => undefined);

    expect(host?.textContent).not.toContain('Video could not be loaded');
    await interact(() => nextVideo.dispatchEvent(new Event('error')));

    expect(identityMocks.refreshProtectedMediaCookie).toHaveBeenCalledTimes(2);
  });

  it('enables frame copy only for current intrinsic frame data and ClipboardItem write support', async () => {
    setClipboardUnsupported();
    const controllerRef = createRef<PreviewVideoFrameController>();
    const onCopyAvailabilityChange = vi.fn();
    await renderVideo(() => true, videoSource, controllerRef, onCopyAvailabilityChange);
    const video = getVideo();

    setVideoFrameState(video, { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });
    await interact(() => video.dispatchEvent(new Event('loadeddata')));

    expect(controllerRef.current?.isCopyAvailable()).toBe(false);
    expect(onCopyAvailabilityChange).toHaveBeenLastCalledWith(videoSource.itemKey, false);

    installClipboardSupport();
    setVideoFrameState(video, { height: 0, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });
    await interact(() => video.dispatchEvent(new Event('resize')));
    expect(controllerRef.current?.isCopyAvailable()).toBe(false);

    setVideoFrameState(video, { height: 1080, readyState: HTMLMediaElement.HAVE_METADATA, width: 1920 });
    await interact(() => video.dispatchEvent(new Event('waiting')));
    expect(controllerRef.current?.isCopyAvailable()).toBe(false);

    setVideoFrameState(video, { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });
    await interact(() => video.dispatchEvent(new Event('canplay')));

    expect(controllerRef.current?.isCopyAvailable()).toBe(true);
    expect(onCopyAvailabilityChange).toHaveBeenLastCalledWith(videoSource.itemKey, true);
  });

  it('draws the intrinsic video frame, encodes PNG, and writes one ClipboardItem', async () => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    const { clipboardItems, write } = installClipboardSupport();
    const drawImage = vi.fn();
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return { drawImage } as unknown as CanvasRenderingContext2D;
    });
    const png = new Blob(['frame'], { type: 'image/png' });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => {
      expect(type).toBe('image/png');
      callback(png);
    });
    await renderVideo(() => true, videoSource, controllerRef);
    const video = getVideo();
    setVideoFrameState(video, { height: 720, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1280 });

    const result = await copyFrame(controllerRef);

    expect(result).toEqual({ ok: true });
    expect(canvases[0]?.width).toBe(1280);
    expect(canvases[0]?.height).toBe(720);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720);
    expect(clipboardItems).toHaveLength(1);
    expect(clipboardItems[0]?.['image/png']).toBe(png);
    expect(write).toHaveBeenCalledOnce();
  });

  it('distinguishes unsupported Clipboard APIs from media without a current frame', async () => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    setClipboardUnsupported();
    await renderVideo(() => true, videoSource, controllerRef);
    const video = getVideo();
    setVideoFrameState(video, { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'unsupported' });

    installClipboardSupport();
    setVideoFrameState(video, { height: 1080, readyState: HTMLMediaElement.HAVE_METADATA, width: 1920 });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'not-ready' });
  });

  it('reports canvas draw and taint failures without touching the clipboard', async () => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    const { write } = installClipboardSupport();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: () => {
        throw new DOMException('The canvas is tainted.', 'SecurityError');
      },
    } as unknown as CanvasRenderingContext2D);
    await renderVideo(() => true, videoSource, controllerRef);
    setVideoFrameState(getVideo(), { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'draw-failed' });
    expect(write).not.toHaveBeenCalled();

    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
      throw new DOMException('The canvas is tainted.', 'SecurityError');
    });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'draw-failed' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    {
      configure: () => vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null)),
      label: 'null PNG encoding',
    },
    {
      configure: () =>
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
          throw new Error('encoder rejected');
        }),
      label: 'rejected PNG encoding',
    },
  ])('reports $label without writing', async ({ configure }) => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    const { write } = installClipboardSupport();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    configure();
    await renderVideo(() => true, videoSource, controllerRef);
    setVideoFrameState(getVideo(), { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'encode-failed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports ClipboardItem construction and clipboard write rejection', async () => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    const { write } = installClipboardSupport();
    installSuccessfulCanvas();
    await renderVideo(() => true, videoSource, controllerRef);
    setVideoFrameState(getVideo(), { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('ClipboardItem rejected');
        }
      },
    });

    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'clipboard-failed' });

    installClipboardSupport().write.mockRejectedValueOnce(new Error('permission denied'));
    await expect(copyFrame(controllerRef)).resolves.toEqual({ ok: false, reason: 'clipboard-failed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not report success after the account epoch changes during clipboard write', async () => {
    const controllerRef = createRef<PreviewVideoFrameController>();
    const writeResult = deferred<void>();
    const { write } = installClipboardSupport();
    write.mockReturnValueOnce(writeResult.promise);
    installSuccessfulCanvas();
    await renderVideo(() => true, videoSource, controllerRef);
    setVideoFrameState(getVideo(), { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });

    const result = copyFrame(controllerRef);
    await interact(() => undefined);
    identityMocks.accountEpoch = 8;
    await interact(() => writeResult.resolve());

    await expect(result).resolves.toEqual({ ok: false, reason: 'stale' });
  });

  it('does not report success after a different GalleryItemKey becomes current', async () => {
    let isCurrent = true;
    const controllerRef = createRef<PreviewVideoFrameController>();
    const writeResult = deferred<void>();
    const { write } = installClipboardSupport();
    write.mockReturnValueOnce(writeResult.promise);
    installSuccessfulCanvas();
    await renderVideo(() => isCurrent, videoSource, controllerRef);
    setVideoFrameState(getVideo(), { height: 1080, readyState: HTMLMediaElement.HAVE_CURRENT_DATA, width: 1920 });

    const result = copyFrame(controllerRef);
    await interact(() => undefined);
    isCurrent = false;
    await interact(() => writeResult.resolve());

    await expect(result).resolves.toEqual({ ok: false, reason: 'stale' });
  });
});

describe('PreviewFrame video keep-alive', () => {
  it('stops playback when the shell hides the widget instead of unmounting it', async () => {
    await renderKeptVideo('visible');
    const video = getVideo();
    const pause = vi.spyOn(video, 'pause');

    await renderKeptVideo('hidden');

    // The element survives — this is the keep-alive path, not an unmount — but
    // `display: none` does not stop media, so the frame has to pause it itself.
    expect(getVideo()).toBe(video);
    expect(video.checkVisibility()).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
    expect(video.paused).toBe(true);
  });

  it('leaves playback alone while the widget stays visible', async () => {
    await renderKeptVideo('visible');
    const video = getVideo();
    const pause = vi.spyOn(video, 'pause');

    await renderKeptVideo('visible');

    expect(getVideo()).toBe(video);
    expect(pause).not.toHaveBeenCalled();
  });
});

const renderKeptVideo = async (mode: 'hidden' | 'visible'): Promise<void> => {
  await interact(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <Activity mode={mode}>
            <VideoHarness />
          </Activity>
        </ChakraProvider>
      </I18nextProvider>
    );
  });
};

const renderVideo = async (
  isItemCurrent?: (itemKey: GalleryItemKey) => boolean,
  source: VideoSource = videoSource,
  videoControllerRef?: Ref<PreviewVideoFrameController>,
  onCopyAvailabilityChange?: (itemKey: GalleryItemKey, isAvailable: boolean) => void
): Promise<void> => {
  await interact(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <VideoHarness
            isItemCurrent={isItemCurrent}
            onCopyAvailabilityChange={onCopyAvailabilityChange}
            source={source}
            videoControllerRef={videoControllerRef}
          />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
};

const getVideo = (): HTMLVideoElement => {
  const video = host?.querySelector<HTMLVideoElement>('video');

  if (!video) {
    throw new Error('Expected the preview video to be mounted.');
  }

  return video;
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalClipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

const restoreClipboardGlobals = (): void => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }

  if (originalClipboardItemDescriptor) {
    Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItemDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
  }
};

afterEach(restoreClipboardGlobals);

const setClipboardUnsupported = (): void => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  Reflect.deleteProperty(globalThis, 'ClipboardItem');
};

const installClipboardSupport = () => {
  const clipboardItems: Record<string, Blob>[] = [];
  const write = vi.fn<(items: ClipboardItems) => Promise<void>>().mockResolvedValue(undefined);

  class TestClipboardItem {
    constructor(data: Record<string, Blob>) {
      clipboardItems.push(data);
    }
  }

  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });

  return { clipboardItems, write };
};

const stubPlaybackPosition = (video: HTMLVideoElement, state: { paused?: boolean } = {}): { get: () => number } => {
  // A `data:` audio source has no seekable range, so a real assignment to `currentTime`
  // clamps straight back to 0. Standing in for the accessor is what makes the nudge
  // observable at all.
  let currentTime = 0;

  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    paused: { configurable: true, value: state.paused ?? true },
  });

  return { get: () => currentTime };
};

/**
 * A playable stand-in for the `data:` source, whose seekable range is empty: a real
 * `currentTime` assignment clamps back to 0, and `play()` on it never enters a playing
 * state, so neither the seek nor the loop would be observable against the element itself.
 */
const stubSpanPlayback = (
  video: HTMLVideoElement,
  { duration = 10, readyState = HTMLMediaElement.HAVE_METADATA }: { duration?: number; readyState?: number } = {}
) => {
  let currentTime = 0;
  let paused = true;
  let silentSeek = false;
  let currentReadyState = readyState;

  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;

        if (!silentSeek) {
          video.dispatchEvent(new Event('seeking'));
        }
      },
    },
    duration: { configurable: true, get: () => duration },
    paused: { configurable: true, get: () => paused },
    readyState: { configurable: true, get: () => currentReadyState },
  });

  const play = vi.spyOn(video, 'play').mockImplementation(() => {
    paused = false;
    video.dispatchEvent(new Event('play'));

    return Promise.resolve();
  });

  return {
    play,
    /** What `load()` does to the element before it refires `loadedmetadata`. */
    reload: () => {
      currentTime = 0;
      paused = true;
      silentSeek = false;
    },
    getTime: () => currentTime,
    pause: () => {
      paused = true;
      video.dispatchEvent(new Event('pause'));
    },
    playToEnd: () => {
      currentTime = duration;
      paused = true;
      video.dispatchEvent(new Event('ended'));
    },
    scrubTo: (value: number) => {
      currentTime = value;
      video.dispatchEvent(new Event('seeking'));
    },
    /** Engines fire no `seeking` for a seek the playhead cannot act on. */
    setSilentSeek: (value: boolean) => {
      silentSeek = value;
    },
    setReadyState: (value: number) => {
      currentReadyState = value;
    },
    setTime: (value: number) => {
      currentTime = value;
    },
  };
};

const clearSpanRequest = (): void => {
  const request = getVideoSpanPlaybackRequest();

  if (request) {
    consumeVideoSpanPlaybackRequest(request.token);
  }
};

const setVideoFrameState = (
  video: HTMLVideoElement,
  state: { height: number; readyState: number; width: number }
): void => {
  Object.defineProperties(video, {
    readyState: { configurable: true, value: state.readyState },
    videoHeight: { configurable: true, value: state.height },
    videoWidth: { configurable: true, value: state.width },
  });
};

const installSuccessfulCanvas = (): void => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['frame'], { type: 'image/png' }));
  });
};

const copyFrame = (controllerRef: {
  current: PreviewVideoFrameController | null;
}): Promise<PreviewVideoFrameCopyResult> => {
  const controller = controllerRef.current;

  expect(controller).not.toBeNull();

  if (!controller) {
    return Promise.reject(new Error('Expected a video frame controller.'));
  }

  return controller.copyCurrentFrame();
};
