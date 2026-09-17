import type { VideoReferenceItem } from '@features/video/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { system } from '@theme/system';
import i18next from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { VideoReferenceListField } from './VideoReferenceListField';
import { VideoUiProvider, type VideoUiAdapter } from './VideoUiContext';

/**
 * A reference card carries ONE find badge — an image reference's poster, or the
 * START bound of a video reference, whose two trim thumbs are frames of a single
 * gallery record. It reveals the card's own media, so the kind has to travel
 * with the name: a video asked for as an image resolves against the wrong
 * endpoint and the gesture dies in a rejected promise, silently.
 */
const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          gallery: { findNamedInGallery: 'Find {{name}} in Gallery', picker: { dropHint: 'Drop', upload: 'Upload' } },
          video: {
            chooseReference: 'Choose from Gallery',
            moveReferenceDown: 'Move reference down',
            moveReferenceUp: 'Move reference up',
            playSelection: 'Play selection in Preview',
            referenceConditioningAudio: 'Audio only',
            referenceConditioningVideo: 'Video only',
            referenceConditioningVideoAudio: 'Video + audio',
            referenceDetailMatch: 'Match generation size',
            referenceDetailMax: 'Max detail',
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

const findInGallery = vi.fn();
const adapter = {
  findInGallery,
  getUploadBoardId: () => 'none',
  patchValues: vi.fn(),
  playVideoSpanInPreview: vi.fn(),
  reportError: vi.fn(),
  touchGalleryImages: vi.fn(),
  videoSpanPlayback: { getState: () => null, subscribe: () => () => undefined },
} as unknown as VideoUiAdapter;

const REFERENCES: VideoReferenceItem[] = [
  { detail: 'match', image: { height: 512, image_name: 'still.png', width: 512 }, kind: 'image' },
  {
    clip: { endFrame: 47, fps: 24, height: 480, numFrames: 48, startFrame: 0, video_name: 'clip.mp4', width: 832 },
    conditioning: 'video_audio',
    kind: 'video',
  },
];

const noop = () => REFERENCES;

const render = async (): Promise<void> => {
  await act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <DndContext>
            <VideoUiProvider adapter={adapter}>
              <VideoReferenceListField
                maxImages={9}
                maxVideos={3}
                references={REFERENCES}
                targetArea={null}
                onChange={noop}
              />
            </VideoUiProvider>
          </DndContext>
        </ChakraProvider>
      </I18nextProvider>
    )
  );
};

/**
 * Park the cursor clear of the harness, BEFORE anything renders. The runner's
 * pointer is stationary at the viewport origin and this list renders into the
 * top-left corner, so the first card's thumbnail sits under it — and a hover
 * badge whose whole contract is "hidden until this thumbnail is hovered" is
 * then revealed before the test has touched anything. Mirrors
 * `resetPointerAndScroll` in the rebalance-bars suite, which hit the same
 * stationary cursor.
 *
 * Parking first, rather than after mounting, is what keeps the resting state
 * readable: un-hovering something already on screen starts the reveal's
 * fade-out, and the resting opacity then answers for where that animation has
 * got to. A badge mounted un-hovered has no previous value to transition from,
 * so it is simply at rest.
 */
const parkPointer = async (): Promise<void> => {
  const parking = document.createElement('div');

  parking.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;z-index:2147483647';
  document.body.append(parking);

  await act(async () => {
    await userEvent.hover(parking);
  });

  parking.remove();
};

const findButtons = (name: string): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="Find ${name} in Gallery"]`),
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  findInGallery.mockClear();
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe('video reference find-in-gallery badges', () => {
  it('reveals an image reference as an image', async () => {
    await render();

    expect(findButtons('still.png')).toHaveLength(1);

    await act(() => findButtons('still.png')[0]?.click());

    expect(findInGallery).toHaveBeenCalledWith({ kind: 'image', name: 'still.png' });
  });

  it('keeps the badge out of the way until its own thumbnail is hovered or focused', async () => {
    await parkPointer();
    await render();

    // Each badge is scoped to its own thumbnail's `.group`, which is the whole
    // mechanism that makes it a hover overlay rather than permanent chrome. A
    // mouse hover cannot be synthesised, but focus-within comes from the same
    // ancestor, so it proves the scoping either way.
    //
    // The focus sweep below reads `pointer-events` rather than `opacity`: the
    // reveal sets both, under the same selector, but only opacity is
    // transitioned — so opacity answers for where the animation has got to,
    // while pointer-events answers for which badge the CSS considers revealed.
    // That is the actual claim, and it is true the instant focus lands rather
    // than a few frames later. Opacity is still worth asserting at rest, where
    // nothing is animating: it is what makes the badge invisible rather than
    // merely inert.
    const badges = [...findButtons('still.png'), ...findButtons('clip.mp4')];
    const revealed = () => badges.map((button) => getComputedStyle(button).pointerEvents);

    expect(badges).toHaveLength(2);
    expect(revealed()).toEqual(['none', 'none']);
    expect(badges.map((button) => getComputedStyle(button).opacity)).toEqual(['0', '0']);

    // Each in turn: the one holding focus is revealed and only it. A badge whose
    // thumbnail lost its `.group` would never be revealed; a `.group` hoisted to
    // the card would reveal both at once.
    for (const [index] of badges.entries()) {
      await act(() => {
        badges[index]!.focus();
      });

      expect(revealed()).toEqual(badges.map((_button, other) => (other === index ? 'auto' : 'none')));
    }
  });

  it('reveals a video reference as a video, once, from its start bound', async () => {
    await render();

    // The end bound shows the same clip, so a second badge there would be a
    // second control with one destination — and one name to tell them apart.
    const bounds = findButtons('clip.mp4');

    expect(bounds).toHaveLength(1);

    await act(() => bounds[0]?.click());

    expect(findInGallery).toHaveBeenCalledExactlyOnceWith({ kind: 'video', name: 'clip.mp4' });
  });
});
