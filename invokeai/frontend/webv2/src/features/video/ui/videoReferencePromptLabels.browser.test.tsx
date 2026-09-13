import type { VideoReferenceConditioning, VideoReferenceItem } from '@features/video/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { system } from '@theme/system';
import i18next from 'i18next';
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoReferenceListField } from './VideoReferenceListField';
import { VideoUiProvider, type VideoUiAdapter } from './VideoUiContext';

/**
 * Each card is badged with the labels the prompt must use for that reference. The numbers
 * come from three independent per-modality counters over the WHOLE list, so they are not a
 * card's own business: a move renumbers cards the user never touched, and the cards are
 * memoized against exactly that kind of re-render.
 */
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
            referenceConditioningAudio: 'Audio only',
            referenceConditioningVideo: 'Video only',
            referenceConditioningVideoAudio: 'Video + audio',
            referenceDetailMatch: 'Match generation size',
            referenceDetailMax: 'Max detail',
            referenceFromInitialVideo: 'Initial video',
            referenceImageCost: '{{width}}×{{height}} · {{rows}} rows per step',
            referencesHelp: 'help',
            removeReference: 'Remove reference',
            sampleLength: 'Sample Length',
            sampleLengthWithSeconds: 'Sample Length ({{seconds}}s)',
            trimEndShort: 'End',
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

const adapter = {
  getUploadBoardId: () => 'none',
  patchValues: vi.fn(),
  playVideoSpanInPreview: vi.fn(),
  reportError: vi.fn(),
  touchGalleryImages: vi.fn(),
} as unknown as VideoUiAdapter;

const imageReference = (name: string): VideoReferenceItem => ({
  detail: 'match',
  image: { height: 512, image_name: name, width: 512 },
  kind: 'image',
});

const videoReference = (name: string, conditioning: VideoReferenceConditioning): VideoReferenceItem => ({
  clip: { endFrame: 47, fps: 24, height: 480, numFrames: 48, startFrame: 0, video_name: name, width: 832 },
  conditioning,
  kind: 'video',
});

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

const render = async (initial: VideoReferenceItem[]): Promise<void> => {
  await act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <DndContext>
            <VideoUiProvider adapter={adapter}>
              <Harness initial={initial} />
            </VideoUiProvider>
          </DndContext>
        </ChakraProvider>
      </I18nextProvider>
    )
  );
};

/** The rendered label badges, in document order -- the trim thumbs badge their frames too. */
const badges = (): string[] =>
  [...host.querySelectorAll<HTMLElement>('.chakra-badge')]
    .map((badge) => badge.textContent!)
    .filter((text) => /^<(?:Picture|Video|Audio) \d+>$/.test(text));

/**
 * Each card's accessible name, in card order: the labels it carries followed by its media
 * name. Asserting the pairing rather than a flat list of badges is what catches a card
 * rendering someone else's labels — which is the failure an identity-keyed, memoized list
 * of same-named references can produce.
 */
const cards = (): string[] =>
  // `[aria-label]` narrows past the unnamed groups Chakra's own slider and select markup adds.
  [...host.querySelectorAll<HTMLElement>('[role="group"][aria-label]')].map((card) => card.getAttribute('aria-label')!);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('video reference prompt labels', () => {
  it('badges each card with the labels its reference answers to', async () => {
    await render([
      videoReference('voiceover.mp4', 'audio'),
      imageReference('portrait.png'),
      videoReference('street.mp4', 'video_audio'),
      imageReference('backdrop.png'),
      videoReference('b-roll.mp4', 'video'),
    ]);

    // The badges carry the tokens verbatim, brackets included -- they are what the user
    // copies into the prompt.
    expect(badges()).toEqual(['<Audio 1>', '<Picture 1>', '<Video 1>', '<Audio 2>', '<Picture 2>', '<Video 2>']);
    // An audio-only reference takes an audio number and no video number; the sounded video
    // takes one from each counter, so neither number is the card's position in the list.
    expect(cards()).toEqual([
      '<Audio 1> voiceover.mp4',
      '<Picture 1> portrait.png',
      '<Video 1> <Audio 2> street.mp4',
      '<Picture 2> backdrop.png',
      '<Video 2> b-roll.mp4',
    ]);
  });

  it('renumbers a card whose own reference did not change', async () => {
    await render([videoReference('v1.mp4', 'video'), videoReference('v2.mp4', 'video_audio')]);
    expect(cards()).toEqual(['<Video 1> v1.mp4', '<Video 2> <Audio 1> v2.mp4']);

    const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]');

    await act(() => trigger!.click());
    const option = document.querySelector<HTMLElement>('[role="option"][data-value="audio"]');

    expect(option).not.toBeNull();
    await act(() => option!.click());

    // Dropping the FIRST reference's image track hands its video number to the second card,
    // whose own reference and slot are untouched -- the card is memoized, so its labels have
    // to arrive as props that change, not be derived from what it holds.
    expect(cards()).toEqual(['<Audio 1> v1.mp4', '<Video 1> <Audio 2> v2.mp4']);
  });
  it('keeps the token in prompt order inside an RTL document', async () => {
    // The brackets are bidi-neutral, so in an RTL paragraph they flip and the badge reads
    // '>Picture 1<' -- a token the encoder will not match, shown to a user who is being
    // told to type it. Arabic and Hebrew set dir on the document root (I18nController), and
    // widgets.video has no translations yet, so these badges DO get rendered in an RTL
    // document today.
    host.dir = 'rtl';
    await render([imageReference('portrait.png')]);

    const badge = host.querySelector<HTMLElement>('.chakra-badge')!;

    expect(badge.textContent).toBe('<Picture 1>');
    expect(getComputedStyle(badge).direction).toBe('ltr');
  });

  it('moves the labels with the card, not with the slot', async () => {
    // Twins: same media name, so the list's identity keys collide by design and React
    // reuses the card instances in place rather than moving them. Only the labels arriving
    // as props keeps the pairing honest through the move.
    await render([videoReference('twin.mp4', 'video'), videoReference('twin.mp4', 'video_audio')]);
    expect(cards()).toEqual(['<Video 1> twin.mp4', '<Video 2> <Audio 1> twin.mp4']);

    const [moveDown] = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Move reference down"]')];

    await act(async () => {
      moveDown!.click();
      await Promise.resolve();
    });

    // The sounded twin is now first, so it takes <Video 1> and the silent one takes <Video 2>.
    expect(cards()).toEqual(['<Video 1> <Audio 1> twin.mp4', '<Video 2> twin.mp4']);
  });
});
