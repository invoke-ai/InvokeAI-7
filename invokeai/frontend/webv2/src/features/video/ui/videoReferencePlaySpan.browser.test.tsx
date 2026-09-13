import type { GalleryVideoItem } from '@features/gallery';
import type { VideoReferenceItem, VideoSourceClip } from '@features/video/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { system } from '@theme/system';
import i18next from 'i18next';
import { act, useCallback, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoReferenceListField } from './VideoReferenceListField';
import { VideoSourceClipField } from './VideoSourceClipField';
import { VideoUiProvider, type VideoUiAdapter } from './VideoUiContext';

/**
 * The trim rows show two still frames, which cannot say what is between them — and for an
 * audio reference, whose frames are a drawing of the sound, say nothing at all. The play
 * button is the panel's answer, and what it has to get right is the arithmetic: the trim
 * is inclusive frame indices, Preview wants seconds.
 */

const galleryMocks = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('@features/gallery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  galleryItems: { resolve: galleryMocks.resolve },
}));

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          gallery: { picker: { dropHint: 'Drop', upload: 'Upload' } },
          video: {
            addReference: 'Add reference',
            chooseReference: 'Choose from Gallery',
            moveReferenceDown: 'Move reference down',
            moveReferenceUp: 'Move reference up',
            playSelection: 'Play selection in Preview',
            referenceConditioningVideo: 'Video only',
            referenceConditioningVideoAudio: 'Video + audio',
            referenceDetailMatch: 'Match generation size',
            referenceDetailMax: 'Max detail',
            initialVideoBlocked: 'blocked',
            referencesHelp: 'help',
            removeReference: 'Remove reference',
            sampleLength: 'Sample Length',
            removeClip: 'Remove video',
            trim: 'Trim',
            trimEnd: 'End Frame',
            trimEndShort: 'End',
            trimHelp: 'help',
            trimStart: 'Start Frame',
            trimStartShort: 'Start',
            uploadImageReference: 'Upload image',
            uploadVideoReference: 'Upload video',
          },
        },
      },
    },
  },
});

let host: HTMLDivElement;
let root: Root;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const playVideoSpanInPreview = vi.fn();
const reportError = vi.fn();

const adapter = {
  getUploadBoardId: () => 'none',
  patchValues: vi.fn(),
  playVideoSpanInPreview,
  reportError,
  touchGalleryImages: vi.fn(),
} as unknown as VideoUiAdapter;

const galleryVideoItem = {
  kind: 'video',
  name: 'clip.mp4',
} as unknown as GalleryVideoItem;

const clip = (overrides: Partial<VideoSourceClip> = {}): VideoSourceClip => ({
  endFrame: 47,
  fps: 16,
  height: 480,
  numFrames: 200,
  startFrame: 32,
  video_name: 'clip.mp4',
  width: 832,
  ...overrides,
});

const videoReference = (overrides: Partial<VideoSourceClip> = {}): VideoReferenceItem => ({
  clip: clip(overrides),
  conditioning: 'video_audio',
  kind: 'video',
});

const imageReference: VideoReferenceItem = {
  detail: 'match',
  image: { height: 512, image_name: 'still.png', width: 512 },
  kind: 'image',
};

const Harness = ({ initial }: { initial: VideoReferenceItem[] }) => {
  const [references, setReferences] = useState(initial);
  const handleChange = useCallback((update: (current: VideoReferenceItem[]) => VideoReferenceItem[]) => {
    setReferences((current) => update(current));
  }, []);

  return (
    <VideoReferenceListField
      maxImages={9}
      maxVideos={3}
      references={references}
      targetArea={null}
      onChange={handleChange}
    />
  );
};

const InitialVideoHarness = ({ disabled }: { disabled: boolean }) => {
  const [source, setSource] = useState<VideoSourceClip | null>(clip());

  return <VideoSourceClipField disabled={disabled} sourceVideo={source} onChange={setSource} />;
};

const renderTree = async (element: ReactNode): Promise<void> => {
  await act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <DndContext>
            <VideoUiProvider adapter={adapter}>{element}</VideoUiProvider>
          </DndContext>
        </ChakraProvider>
      </I18nextProvider>
    )
  );
};

const render = (initial: VideoReferenceItem[]): Promise<void> => renderTree(<Harness initial={initial} />);

const playButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Play selection in Preview"]'),
];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
};

const press = async (button: HTMLButtonElement): Promise<void> => {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};

beforeEach(() => {
  galleryMocks.resolve.mockReset().mockResolvedValue(galleryVideoItem);
  playVideoSpanInPreview.mockReset();
  reportError.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('video reference span playback', () => {
  it('asks Preview for the window the trim selected, in seconds', async () => {
    await render([videoReference()]);
    const [button] = playButtons();

    expect(button).toBeDefined();
    await press(button!);

    // The lookup is cancelled with the account lifetime, like every other gallery read.
    expect(galleryMocks.resolve).toHaveBeenCalledWith(
      { kind: 'video', name: 'clip.mp4' },
      expect.any(AbortSignal) as AbortSignal
    );
    // Frames 32..47 inclusive at 16 fps: the window ends at the far edge of frame 47, so
    // the last selected frame is played rather than cut short.
    expect(playVideoSpanInPreview).toHaveBeenCalledWith({
      endSeconds: 3,
      item: galleryVideoItem,
      startSeconds: 2,
    });
  });

  it('offers the control only where there is something to play', async () => {
    // An image reference is already fully visible as its own thumbnail; there is no window
    // to audition, so the control is absent rather than dead.
    await render([imageReference]);

    expect(playButtons()).toHaveLength(0);
  });

  it("plays the Initial Video clip's window, and stays live while the field is disabled", async () => {
    // Playing changes nothing, so a clip the user can see is one they can audition — the
    // field is disabled whenever a first-frame image or a full reference stack blocks
    // EDITING it, and its trim rows stay on screen throughout.
    await renderTree(<InitialVideoHarness disabled />);
    const [button] = playButtons();

    expect(button).toBeDefined();
    await press(button!);

    expect(playVideoSpanInPreview).toHaveBeenCalledWith({ endSeconds: 3, item: galleryVideoItem, startSeconds: 2 });
  });

  it('refuses a second press without dropping keyboard focus', async () => {
    const pending = deferred<GalleryVideoItem>();
    galleryMocks.resolve.mockReturnValueOnce(pending.promise);
    await render([videoReference()]);
    const [button] = playButtons();

    button!.focus();
    await press(button!);

    // aria-disabled, never the DOM's `disabled`: disabling a focused button blurs it to
    // <body>, which would drop a keyboard user out of the card for the length of a
    // network round trip.
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    await press(button!);
    expect(galleryMocks.resolve).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(galleryVideoItem);
      await Promise.resolve();
    });

    expect(playVideoSpanInPreview).toHaveBeenCalledTimes(1);
    expect(button?.getAttribute('aria-disabled')).toBe('false');
  });

  it('reports a failed lookup instead of leaving the control stuck', async () => {
    galleryMocks.resolve.mockRejectedValueOnce(new Error('clip is gone'));
    await render([videoReference()]);
    const [button] = playButtons();

    await press(button!);

    expect(reportError).toHaveBeenCalledWith('clip is gone');
    expect(playVideoSpanInPreview).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(false);
  });
});
