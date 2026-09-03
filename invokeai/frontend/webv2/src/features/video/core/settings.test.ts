import { describe, expect, it } from 'vitest';

import type { VideoReferenceItem, VideoSettings } from './types';

import { MINIMAX_H3_NUM_FRAMES_CHOICES } from './dimensions';
import {
  resizeReferenceSampleWindow,
  slideReferenceSampleWindow,
  applyReferenceExtendSourceVideo,
  applyReferenceExtendNumFrames,
  canPlaceReferenceExtendAnchor,
  pinReferenceExtendAnchor,
  clearDeletedVideoMedia,
  cloneVideoWidgetValues,
  createVideoSourceClip,
  deriveReferenceExtendClip,
  isVideoSettings,
  isVideoSourceClip,
  normalizeVideoSettings,
  normalizeVideoWidgetValues,
  resolveVideoMode,
  VIDEO_SOURCE_FALLBACK_FPS,
} from './settings';
import { getDefaultVideoSettings } from './videoPolicies';

const FIRST_FRAME = { height: 1080, image_name: 'first.png', width: 1920 };
const LAST_FRAME = { height: 1080, image_name: 'last.png', width: 1920 };
const SOURCE_VIDEO = {
  endFrame: 79,
  fps: 16,
  height: 480,
  numFrames: 81,
  startFrame: 0,
  video_name: 'clip.mp4',
  width: 832,
};

const createSettings = (overrides: Partial<VideoSettings> = {}): VideoSettings => ({
  ...getDefaultVideoSettings(),
  ...overrides,
});

describe('resolveVideoMode', () => {
  it('infers the mode from which inputs are filled', () => {
    expect(resolveVideoMode(createSettings())).toBe('txt2vid');
    expect(resolveVideoMode(createSettings({ firstFrameImage: FIRST_FRAME }))).toBe('first-frame');
    expect(resolveVideoMode(createSettings({ firstFrameImage: FIRST_FRAME, lastFrameImage: LAST_FRAME }))).toBe(
      'first-last'
    );
    expect(resolveVideoMode(createSettings({ lastFrameImage: LAST_FRAME }))).toBe('last-frame');
    expect(resolveVideoMode(createSettings({ sourceVideo: SOURCE_VIDEO }))).toBe('extend');
    // A last frame with a source video is still extend — it is the destination anchor.
    expect(resolveVideoMode(createSettings({ lastFrameImage: LAST_FRAME, sourceVideo: SOURCE_VIDEO }))).toBe('extend');
  });
});

describe('normalizeVideoSettings', () => {
  it('round-trips canonical settings', () => {
    const settings = createSettings({ firstFrameImage: FIRST_FRAME, positivePrompt: 'a cat' });
    const normalized = normalizeVideoSettings(settings);

    expect(normalized).toEqual(settings);
    expect(isVideoSettings(settings)).toBe(true);
  });

  it('rejects non-records but heals partial records field-by-field, upscale-style', () => {
    expect(normalizeVideoSettings(null)).toBeNull();
    expect(normalizeVideoSettings(7)).toBeNull();
    // A seeded partial write ("Send to Video" on a never-opened widget) keeps
    // its payload instead of being nulled and wiped by the reconciler.
    const seeded = normalizeVideoSettings({ firstFrameImage: FIRST_FRAME, sourceVideo: null });

    expect(seeded).not.toBeNull();
    expect(seeded?.firstFrameImage).toEqual(FIRST_FRAME);
    expect(seeded).toMatchObject({ fps: 16, modelKey: '', numFrames: 81, steps: 40, targetResolution: '720p' });
    // Invalid field types heal to defaults rather than failing wholesale.
    expect(normalizeVideoSettings({ ...createSettings(), numFrames: 'many' })?.numFrames).toBe(81);
    expect(normalizeVideoSettings({ ...createSettings(), positivePrompt: 7 })?.positivePrompt).toBe('');
  });

  it('fills fields older persisted projects predate with defaults', () => {
    const legacy: Record<string, unknown> = {
      cfgScale: 5,
      fps: 16,
      modelKey: 'wan-key',
      negativePrompt: '',
      numFrames: 81,
      positivePrompt: 'a dog',
      seed: 123,
      shouldRandomizeSeed: false,
      steps: 40,
    };
    const normalized = normalizeVideoSettings(legacy);

    expect(normalized).not.toBeNull();
    expect(normalized?.aspectRatioId).toBe('16:9');
    expect(normalized?.targetResolution).toBe('720p');
    expect(normalized?.firstFrameImage).toBeNull();
    expect(normalized?.sourceVideo).toBeNull();
    expect(normalized?.loras).toEqual([]);
    expect(normalized?.acceleratorEnabled).toBe(false);
    expect(normalized?.positivePrompt).toBe('a dog');
  });

  it('drops malformed media values instead of failing wholesale', () => {
    const normalized = normalizeVideoSettings({
      ...createSettings(),
      firstFrameImage: { image_name: 'x.png' },
      sourceVideo: { video_name: 'clip.mp4' },
    });

    expect(normalized?.firstFrameImage).toBeNull();
    expect(normalized?.sourceVideo).toBeNull();
  });

  it('clears an accelerator flag whose recorded LoRAs are gone — the flag means they are active', () => {
    const lightningLora = {
      isEnabled: true,
      model: { base: 'wan', key: 'lit', name: 'Wan Lightning High Noise', type: 'lora' as const },
      weight: 1,
    };

    // Flag without recorded keys, or with a recorded key missing from the list, clears.
    expect(
      normalizeVideoSettings({ ...createSettings(), acceleratorEnabled: true, loras: [lightningLora] })
        ?.acceleratorEnabled
    ).toBe(false);
    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit', 'gone'],
        loras: [lightningLora],
      })
    ).toMatchObject({ acceleratorEnabled: false, acceleratorLoraKeys: [] });
    // Flag with all recorded keys present survives.
    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [lightningLora],
      })
    ).toMatchObject({ acceleratorEnabled: true, acceleratorLoraKeys: ['lit'] });
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: true, acceleratorLoraKeys: [], loras: [] })).toBe(
      false
    );
    expect(
      isVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [lightningLora],
      })
    ).toBe(true);
    // A recorded LoRA that is merely DISABLED also clears the flag: the graph
    // skips disabled LoRAs, so the fast path would silently run without it.
    const disabledLightning = { ...lightningLora, isEnabled: false };

    expect(
      normalizeVideoSettings({
        ...createSettings(),
        acceleratorEnabled: true,
        acceleratorLoraKeys: ['lit'],
        loras: [disabledLightning],
      })
    ).toMatchObject({ acceleratorEnabled: false, acceleratorLoraKeys: [] });

    // A disabled flag must not carry stale keys.
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: false, acceleratorLoraKeys: ['lit'] })).toBe(
      false
    );
  });

  it('resolves an illegal first-frame + source-video combination in favor of the first frame', () => {
    const normalized = normalizeVideoSettings({
      ...createSettings(),
      firstFrameImage: FIRST_FRAME,
      sourceVideo: SOURCE_VIDEO,
    });

    expect(normalized?.firstFrameImage).toEqual(FIRST_FRAME);
    expect(normalized?.sourceVideo).toBeNull();
  });
});

describe('isVideoSettings', () => {
  it('is strict over the keys normalize would invent', () => {
    expect(isVideoSettings({ ...createSettings(), aspectRatioId: 'Free' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), targetResolution: '4k' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), acceleratorEnabled: 'yes' })).toBe(false);
    expect(isVideoSettings({ ...createSettings(), firstFrameImage: FIRST_FRAME, sourceVideo: SOURCE_VIDEO })).toBe(
      false
    );
  });
});

describe('isVideoSourceClip', () => {
  it('requires the trim and probe fields', () => {
    expect(isVideoSourceClip(SOURCE_VIDEO)).toBe(true);
    expect(isVideoSourceClip({ ...SOURCE_VIDEO, fps: undefined })).toBe(false);
    expect(isVideoSourceClip({ ...SOURCE_VIDEO, video_name: 7 })).toBe(false);
  });
});

describe('normalizeVideoWidgetValues / cloneVideoWidgetValues', () => {
  const model = { base: 'wan', key: 'wan-key', name: 'Wan', type: 'main' as const, variant: 't2v_a14b' };

  it('carries a valid main model and nulls an invalid one', () => {
    expect(normalizeVideoWidgetValues({ ...createSettings(), model })?.model).toEqual(model);
    expect(normalizeVideoWidgetValues({ ...createSettings(), model: { key: 'x' } })?.model).toBeNull();
  });

  it('clones deeply enough that mutating the clone leaves the original untouched', () => {
    const values = { ...createSettings({ firstFrameImage: FIRST_FRAME, sourceVideo: null }), model };
    const clone = cloneVideoWidgetValues(values);

    expect(clone).toEqual(values);
    (clone.firstFrameImage as { image_name: string }).image_name = 'mutated.png';
    if (clone.model) {
      clone.model.key = 'mutated';
    }
    expect(values.firstFrameImage?.image_name).toBe('first.png');
    expect(values.model?.key).toBe('wan-key');
  });
});

describe('createVideoSourceClip', () => {
  it('estimates frames from duration and defaults the trim to drop the final frame', () => {
    const clip = createVideoSourceClip({ durationSeconds: 5, fps: 16, height: 480, name: 'clip.mp4', width: 832 });

    expect(clip).toEqual({
      endFrame: 78,
      fps: 16,
      height: 480,
      numFrames: 80,
      startFrame: 0,
      video_name: 'clip.mp4',
      width: 832,
    });
  });

  it('falls back to 16 fps when the probe recorded none, mirroring extract_video_range', () => {
    const clip = createVideoSourceClip({ durationSeconds: 2, height: 480, name: 'clip.mp4', width: 832 });

    expect(clip.fps).toBe(VIDEO_SOURCE_FALLBACK_FPS);
    expect(clip.numFrames).toBe(32);
  });

  it('keeps the default end frame at 1 or above so the crossfade tail survives', () => {
    const clip = createVideoSourceClip({ durationSeconds: 0.1, fps: 16, height: 480, name: 'c.mp4', width: 832 });

    expect(clip.endFrame).toBeGreaterThanOrEqual(1);
  });

  it('never produces negative trim bounds for very short clips', () => {
    const clip = createVideoSourceClip({ durationSeconds: 0.05, fps: 16, height: 480, name: 'c.mp4', width: 832 });

    expect(clip.numFrames).toBeGreaterThanOrEqual(1);
    expect(clip.endFrame).toBeGreaterThanOrEqual(0);
    expect(clip.startFrame).toBe(0);
  });
});

describe('clearDeletedVideoMedia', () => {
  const withMedia = createSettings({
    firstFrameImage: FIRST_FRAME,
    lastFrameImage: LAST_FRAME,
    sourceVideo: null,
  });

  it('returns the same object when nothing referenced was deleted', () => {
    expect(clearDeletedVideoMedia(withMedia, new Set(['other.png']), new Set())).toBe(withMedia);
  });

  it('clears exactly the deleted references', () => {
    const cleared = clearDeletedVideoMedia(withMedia, new Set(['first.png']), new Set());

    expect(cleared.firstFrameImage).toBeNull();
    expect(cleared.lastFrameImage).toEqual(LAST_FRAME);

    const withClip = createSettings({ sourceVideo: SOURCE_VIDEO });
    const clipCleared = clearDeletedVideoMedia(withClip, new Set(), new Set(['clip.mp4']));

    expect(clipCleared.sourceVideo).toBeNull();
  });

  it('clears a reference the exclusion masking would hide from a normalized snapshot', () => {
    // A raw store can hold BOTH slots (a rollback race); normalization would
    // mask the source video, so the sweep must run on the raw values or the
    // masked reference dangles past the delete.
    const rawBoth = { ...createSettings({ firstFrameImage: FIRST_FRAME }), sourceVideo: SOURCE_VIDEO } as Record<
      string,
      unknown
    >;
    const cleared = clearDeletedVideoMedia(rawBoth, new Set(), new Set(['clip.mp4']));

    expect(cleared.sourceVideo).toBeNull();
    expect(cleared.firstFrameImage).toEqual(FIRST_FRAME);

    // Junk in a slot never throws — the guards ignore non-media shapes.
    const junk = { firstFrameImage: 'nonsense', lastFrameImage: 7, sourceVideo: {} } as Record<string, unknown>;

    expect(clearDeletedVideoMedia(junk, new Set(['nonsense']), new Set())).toBe(junk);
  });
});

// ---------------------------------------------------------------------------
// Ref2VA references

const IMAGE_REFERENCE = {
  detail: 'max',
  image: { height: 512, image_name: 'ref.png', width: 512 },
  kind: 'image',
} as const;
const VIDEO_REFERENCE = {
  clip: { endFrame: 47, fps: 24, height: 480, numFrames: 48, startFrame: 0, video_name: 'ref.mp4', width: 832 },
  conditioning: 'video_audio',
  kind: 'video',
} as const;

describe('references', () => {
  it('reference mode wins the mode inference', () => {
    expect(resolveVideoMode(createSettings({ references: [IMAGE_REFERENCE] }))).toBe('reference');
    expect(resolveVideoMode(createSettings({ references: [VIDEO_REFERENCE], sourceVideo: SOURCE_VIDEO }))).toBe(
      'reference'
    );
  });

  it('normalization drops frame media when references are present, keeping the source video', () => {
    const normalized = normalizeVideoSettings(
      createSettings({ firstFrameImage: FIRST_FRAME, references: [IMAGE_REFERENCE], sourceVideo: SOURCE_VIDEO })
    );

    expect(normalized?.references).toEqual([IMAGE_REFERENCE]);
    expect(normalized?.firstFrameImage).toBeNull();
    // References + source video is the Ref2VA reference-extend shape;
    // validation rejects the pair on models that cannot consume it.
    expect(normalized?.sourceVideo).toEqual(SOURCE_VIDEO);
  });

  it('normalization drops malformed entries and enforces the caps, preserving order', () => {
    // Videos over the cap drop the NEWEST non-anchor entries — the surplus is
    // whatever arrived last. See the over-cap tests below.
    const tooMany = [
      ...Array.from({ length: 4 }, (_, index) => ({
        ...VIDEO_REFERENCE,
        clip: { ...VIDEO_REFERENCE.clip, video_name: `v${index}.mp4` },
      })),
      { kind: 'image' },
      IMAGE_REFERENCE,
    ];
    const normalized = normalizeVideoSettings(createSettings({ references: tooMany as never }));

    expect(normalized?.references.map((entry) => (entry.kind === 'video' ? entry.clip.video_name : 'img'))).toEqual([
      'v0.mp4',
      'v1.mp4',
      'v2.mp4',
      'img',
    ]);
  });

  it('over-cap overflow drops the newest videos but never the anchor', () => {
    const named = (entry: { kind: string; clip?: { video_name: string } }) =>
      entry.kind === 'video' ? entry.clip!.video_name : 'img';
    const tooMany = [
      IMAGE_REFERENCE,
      ...Array.from({ length: 5 }, (_unused, index) => ({
        ...VIDEO_REFERENCE,
        clip: { ...VIDEO_REFERENCE.clip, video_name: `v${index}.mp4` },
      })),
    ];
    const normalized = normalizeVideoSettings(createSettings({ references: tooMany as never }));

    expect(normalized?.references.map(named as never)).toEqual(['img', 'v0.mp4', 'v1.mp4', 'v2.mp4']);

    // The race shape: an add slipped past the render-time cap gate while the
    // Initial Video was placing its anchor. The surplus is the racing add (D),
    // not the user's oldest reference (B) — a plain front-drop deleted B.
    const anchor = {
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, video_name: 'anchor.mp4' },
      fromSourceVideo: true,
    };
    const raced = ['b.mp4', 'c.mp4'].map((video_name) => ({
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, video_name },
    }));
    const healed = normalizeVideoSettings(
      createSettings({
        references: [
          ...raced,
          anchor,
          { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'd.mp4' } },
        ] as never,
      })
    );

    expect(healed?.references.map(named as never)).toEqual(['b.mp4', 'c.mp4', 'anchor.mp4']);
    expect(healed?.references.at(-1)).toMatchObject({ fromSourceVideo: true });
  });

  it('normalization heals a panel saved with the anchor prepended', () => {
    // The build before the anchor was pinned PREPENDED it, so those projects
    // load with it at index 0. Normalization must move it last -- otherwise the
    // generated frames continue from whatever reference follows it -- and it
    // must do so BEFORE the cap trim, or the front-drop deletes the anchor.
    const anchor = {
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, video_name: 'anchor.mp4' },
      fromSourceVideo: true,
    };
    const named = (entry: { kind: string; clip?: { video_name: string } }) =>
      entry.kind === 'video' ? entry.clip!.video_name : 'img';

    const healed = normalizeVideoSettings(createSettings({ references: [anchor, IMAGE_REFERENCE] as never }));

    expect(healed?.references.map(named as never)).toEqual(['img', 'anchor.mp4']);

    // Over the cap, with the anchor in the position the old build left it.
    const stale = [
      anchor,
      ...Array.from({ length: 3 }, (_unused, index) => ({
        ...VIDEO_REFERENCE,
        clip: { ...VIDEO_REFERENCE.clip, video_name: `v${index}.mp4` },
      })),
    ];
    const trimmed = normalizeVideoSettings(createSettings({ references: stale as never }));

    expect(trimmed?.references.map(named as never)).toEqual(['v0.mp4', 'v1.mp4', 'anchor.mp4']);
    expect(trimmed?.references.at(-1)).toMatchObject({ fromSourceVideo: true });
  });

  it('isVideoSettings rejects references combined with frame media', () => {
    expect(isVideoSettings(createSettings({ firstFrameImage: FIRST_FRAME, references: [IMAGE_REFERENCE] }))).toBe(
      false
    );
    expect(isVideoSettings(createSettings({ references: [IMAGE_REFERENCE] }))).toBe(true);
  });

  it('clone deep-copies references', () => {
    const values = { ...createSettings({ references: [VIDEO_REFERENCE] }), model: null };
    const clone = cloneVideoWidgetValues(values);

    expect(clone.references).toEqual(values.references);
    expect(clone.references[0]).not.toBe(values.references[0]);
  });

  it('clearDeletedVideoMedia filters deleted reference media, preserving order and identity', () => {
    const values = createSettings({ references: [VIDEO_REFERENCE, IMAGE_REFERENCE] });
    const untouched = clearDeletedVideoMedia(values, new Set(), new Set());

    expect(untouched).toBe(values);

    const swept = clearDeletedVideoMedia(values, new Set(['ref.png']), new Set());

    expect(swept.references).toEqual([VIDEO_REFERENCE]);

    const sweptVideo = clearDeletedVideoMedia(values, new Set(), new Set(['ref.mp4']));

    expect(sweptVideo.references).toEqual([IMAGE_REFERENCE]);
  });
});

describe('reference-extend linkage', () => {
  // H3 generates at a fixed 24 fps; SOURCE_VIDEO runs at 16, so the two rates
  // are exercised separately.
  const longSource = { ...SOURCE_VIDEO, endFrame: 400, numFrames: 402, video_name: 'long.mp4' };
  const source24 = { ...longSource, fps: 24 };
  // The panel's default; every choice is on the 17n+5 grid.
  const FRAMES = 141;

  it('derives the tail trim: the window ending at the cutpoint, clamped at 0', () => {
    expect(deriveReferenceExtendClip(source24, FRAMES)).toMatchObject({ endFrame: 400, startFrame: 260 });
    // Shorter than the tail window: fall back to the largest ON-GRID budget the
    // clip supports (80 frames -> 73) so the window still ENDS on the cutpoint.
    // Starting at 0 kept the same 73 frames but stopped 7 short of the seam.
    expect(deriveReferenceExtendClip({ ...SOURCE_VIDEO, fps: 24 }, FRAMES)).toMatchObject({
      endFrame: 79,
      startFrame: 7,
    });
  });

  it('budgets the window against the generated frame count', () => {
    // `normalize_reference_video_frames` truncates a reference to the generated
    // frame count keeping the FRONT, so a window longer than the generation
    // loses its tail — the frames at the seam. It must never outrun the count.
    expect(deriveReferenceExtendClip(source24, 124)).toMatchObject({ endFrame: 400, startFrame: 277 });
    expect(deriveReferenceExtendClip(source24, 90)).toMatchObject({ endFrame: 400, startFrame: 311 });
    // Above the tail window the budget stops binding: ~5s of lead-in is the cap.
    expect(deriveReferenceExtendClip(source24, 345)).toMatchObject({ endFrame: 400, startFrame: 260 });
  });

  it('lands the window ON the 17n+5 grid the backend keeps, at every source rate', () => {
    // The real test of the window: run it through ALL THREE backend rules.
    // `resample_video_frame_repeats` onto 24 fps, `frames[:num_frames]`, then
    // `snap_reference_num_frames` DOWN to 17n+5 — every one of which cuts the
    // seam end. Rounding the fps conversion DOWN satisfied the first two and
    // failed the third, losing 17 frames at 23.976 fps at every frame count.
    const resample = (n: number, fps: number) => Math.floor((n * 24) / fps + 0.5);
    const snapDown = (n: number) => Math.max(1, Math.floor((n - 5) / 17)) * 17 + 5;

    for (const fps of [10, 12, 15, 16, 18, 20, 23.976, 24, 25, 29.97, 30, 60]) {
      for (const numFrames of MINIMAX_H3_NUM_FRAMES_CHOICES) {
        const clip = deriveReferenceExtendClip({ ...longSource, fps }, numFrames);
        const budget = Math.min(141, numFrames);
        const kept = snapDown(Math.min(resample(clip.endFrame - clip.startFrame + 1, fps), numFrames));

        expect({ fps, kept, numFrames }).toEqual({ fps, kept: budget, numFrames });
      }
    }
  });

  it('a clip SHORTER than the window still ends its tail on the cutpoint', () => {
    // The clamped branch used to take the whole clip, whose length is
    // arbitrary: off the 17n+5 grid, so the snap-down cut the difference from
    // the END. Nothing about it needs an inexact estimate — it was the common
    // case for any source under ~5.9s at 24 fps, and the sweep above could not
    // see it because it only runs a 402-frame clip.
    const resample = (n: number, fps: number) => Math.floor((n * 24) / fps + 0.5);
    const snapDown = (n: number) => Math.max(1, Math.floor((n - 5) / 17)) * 17 + 5;

    for (const fps of [12, 16, 23.976, 24, 25, 30]) {
      for (const total of [40, 60, 80, 100, 120, 141, 200]) {
        for (const numFrames of [90, 124, 141, 345]) {
          const source = { ...longSource, endFrame: total - 1, fps, numFrames: total };
          const clip = deriveReferenceExtendClip(source, numFrames);
          const window = clip.endFrame - clip.startFrame + 1;
          const kept = snapDown(Math.min(resample(window, fps), numFrames));

          const discarded = Math.min(resample(window, fps), numFrames) - kept;

          // At most a single frame is trimmed off the seam end -- the source's
          // own frame boundaries sometimes cannot land on the grid exactly (12
          // fps cannot reach an odd 141 at all). The old clamp shed up to 16.
          expect({ discarded: discarded <= 1, fps, numFrames, total }).toEqual({
            discarded: true,
            fps,
            numFrames,
            total,
          });
          // And the window always still ends where it was asked to.
          expect(clip.endFrame).toBe(source.endFrame);
        }
      }
    }
  });

  it('converts the window into the source clip fps', () => {
    // 141 frames of 24 fps material is 94 frames of a 16 fps clip — the same
    // 5.875s of wall time, which is what the tail window actually means.
    expect(deriveReferenceExtendClip(longSource, FRAMES)).toMatchObject({ endFrame: 400, startFrame: 307 });
    // A clip whose probe recorded no usable rate falls back to a no-op
    // conversion rather than collapsing to the 2-frame floor.
    expect(deriveReferenceExtendClip({ ...longSource, fps: 0 }, FRAMES)).toMatchObject({ startFrame: 260 });
    expect(deriveReferenceExtendClip({ ...longSource, fps: -30 }, FRAMES)).toMatchObject({ startFrame: 260 });
  });

  it('appends a linked video+audio reference and re-derives it on cutpoint changes', () => {
    // Appended, not prepended: request order is rotary order and the generated
    // rows continue from the LAST reference block, so the continuity anchor
    // has to be the final entry.
    const added = applyReferenceExtendSourceVideo([IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(added).toHaveLength(2);
    expect(added[0]).toBe(IMAGE_REFERENCE);
    expect(added[1]).toMatchObject({
      clip: { endFrame: 400, startFrame: 260, video_name: 'long.mp4' },
      conditioning: 'video_audio',
      fromSourceVideo: true,
      kind: 'video',
    });

    // The user tunes the conditioning, then moves the cutpoint: the trim
    // re-derives, the position and conditioning survive.
    const tuned = added.map((entry, index) =>
      index === 1 && entry.kind === 'video' ? { ...entry, conditioning: 'video' as const } : entry
    );
    const retrimmed = applyReferenceExtendSourceVideo(tuned, { ...source24, endFrame: 300 }, 3, FRAMES);

    expect(retrimmed[1]).toMatchObject({
      clip: { endFrame: 300, startFrame: 160 },
      conditioning: 'video',
      fromSourceVideo: true,
    });
    expect(retrimmed[0]).toBe(added[0]);
  });

  it('clearing the initial video removes only the linked reference (identity-preserving when none)', () => {
    const list = applyReferenceExtendSourceVideo([VIDEO_REFERENCE, IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(applyReferenceExtendSourceVideo(list, null, 3, FRAMES)).toEqual([VIDEO_REFERENCE, IMAGE_REFERENCE]);

    const unlinked = [VIDEO_REFERENCE, IMAGE_REFERENCE];

    expect(applyReferenceExtendSourceVideo(unlinked, null, 3, FRAMES)).toBe(unlinked);
  });

  it('normalization re-establishes the linkage recall drops, and the invariants reach it', () => {
    // `fromSourceVideo` never reaches metadata, so a recalled reference-extend
    // panel arrives with its anchor UNFLAGGED beside the source video. Every
    // invariant keys on the flag, so before this: not pinned (the model
    // continued from whatever followed it), and not re-budgeted (a Frames
    // change left the window overrunning -- 2s cut off the seam at 345 -> 90).
    const recalled = { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'long.mp4' } };
    const normalized = normalizeVideoSettings(
      createSettings({ references: [recalled, IMAGE_REFERENCE], sourceVideo: source24 })
    );

    // Flagged by clip identity -- the same rule the setter adopts by -- and pinned.
    expect(normalized?.references).toHaveLength(2);
    expect(normalized?.references[0]).toBe(IMAGE_REFERENCE);
    expect(normalized?.references[1]).toMatchObject({
      clip: { video_name: 'long.mp4' },
      fromSourceVideo: true,
    });

    // The frame-count re-budget now reaches the recalled window.
    const rebudgeted = applyReferenceExtendNumFrames(normalized!.references, 90);

    expect(rebudgeted[1]).toMatchObject({ clip: { endFrame: 47, startFrame: 9 } });

    // A flagged entry stays authoritative: an unflagged same-name entry beside
    // it is NOT a second anchor.
    const flaggedElsewhere = normalizeVideoSettings(
      createSettings({
        references: [recalled, { ...VIDEO_REFERENCE, fromSourceVideo: true }],
        sourceVideo: source24,
      })
    );

    expect(
      flaggedElsewhere?.references.filter((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)
    ).toHaveLength(1);
    expect(flaggedElsewhere?.references[1]).toMatchObject({ clip: { video_name: 'ref.mp4' }, fromSourceVideo: true });

    // No source video: nothing to link, nothing flagged.
    const unlinked = normalizeVideoSettings(createSettings({ references: [recalled] }));

    expect(unlinked?.references[0]).not.toHaveProperty('fromSourceVideo');
  });

  it('adopts the LAST same-name entry: the pin invariant records the anchor last', () => {
    // Recorded metadata can hold a user's OWN reference to the source clip
    // ahead of the anchor -- the pin forces the anchor last, so it is always
    // the later same-name entry. A first-match flagged the user's reference:
    // their trim got re-budgeted, the list reordered against the recording,
    // and the true tail window sat unprotected at the seam.
    const userRef = {
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, endFrame: 20, startFrame: 0, video_name: 'long.mp4' },
    };
    const tailRef = { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'long.mp4' } };
    const normalized = normalizeVideoSettings(
      createSettings({ references: [userRef, tailRef], sourceVideo: source24 })
    );

    expect(normalized?.references[0]).toBe(userRef);
    expect(normalized?.references[1]).toMatchObject({ clip: { endFrame: 47 }, fromSourceVideo: true });
  });

  it('canonicalizes the flag to at most one entry and keeps normalization stable', () => {
    // Two flagged entries (a corrupt or hand-merged record) used to oscillate:
    // the pin moves the FIRST flagged entry last, swapping the pair on every
    // pass -- and the overflow trim exempts every flagged entry, so an
    // over-cap list of them could never come back under the cap.
    const flaggedNamed = (video_name: string) => ({
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, video_name },
      fromSourceVideo: true,
    });
    const once = normalizeVideoSettings(createSettings({ references: [flaggedNamed('a.mp4'), flaggedNamed('b.mp4')] }));
    const twice = normalizeVideoSettings(createSettings({ references: once!.references }));

    expect(once?.references.filter((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)).toHaveLength(
      1
    );
    expect(once?.references.at(-1)).toMatchObject({ clip: { video_name: 'b.mp4' }, fromSourceVideo: true });
    expect(twice?.references).toEqual(once?.references);

    // All-flagged over the cap: the exemption can no longer make the surplus
    // immortal -- the cap holds, and the surviving flag is the last one.
    const overCap = normalizeVideoSettings(
      createSettings({ references: ['a', 'b', 'c', 'd'].map((name) => flaggedNamed(`${name}.mp4`)) })
    );

    expect(overCap?.references).toHaveLength(3);
    expect(
      overCap?.references.filter((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)
    ).toHaveLength(1);
    expect(overCap?.references.at(-1)).toMatchObject({ clip: { video_name: 'd.mp4' }, fromSourceVideo: true });
  });

  it('an absurd probed frame rate falls back to 24 instead of hanging', () => {
    // Past ~2^53 source frames, tailSourceFrames' adjustment loops cannot even
    // step (tail + 1 === tail in floats) -- fps 1e17 froze the tab. Any rate
    // no real container produces now takes the same fallback as a broken one.
    expect(deriveReferenceExtendClip({ ...source24, fps: 1e17 }, 141)).toMatchObject({
      endFrame: 400,
      startFrame: 260,
    });
    // Below the bound, a genuinely high-rate clip still gets its REAL window:
    // 1200 fps needs 7025 source frames for 141 resampled ones. A 1000-fps
    // bound sent this through the 24 fallback, and the backend -- which
    // resamples at the rate it probes itself -- collapsed the 141-source-frame
    // window to 3 frames and raised under text conditioning's 13-frame floor.
    const highRate = { ...source24, endFrame: 50000, fps: 1200, numFrames: 50001 };

    expect(deriveReferenceExtendClip(highRate, 141)).toMatchObject({ endFrame: 50000, startFrame: 42976 });
    expect(deriveReferenceExtendClip({ ...highRate, fps: 1e17 }, 141)).toMatchObject({ startFrame: 49860 });
  });

  it('adopts an unflagged reference for the same clip instead of duplicating it (recall shape)', () => {
    const recalled = { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'long.mp4' } };
    const result = applyReferenceExtendSourceVideo([IMAGE_REFERENCE, recalled], source24, 3, FRAMES);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      clip: { endFrame: 400, startFrame: 260, video_name: 'long.mp4' },
      fromSourceVideo: true,
    });
  });

  it('prefers the flagged entry over an earlier same-name reference on a source swap', () => {
    // User: linked ref for clip A, plus their OWN hand-trimmed reference for
    // clip B sitting above it. Swapping the Initial Video to clip B must
    // update the FLAGGED entry — not rewrite the user's B reference.
    const linkedA = applyReferenceExtendSourceVideo([], source24, 3, FRAMES)[0];
    const handTrimmedB = {
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, endFrame: 200, numFrames: 300, startFrame: 100, video_name: 'b.mp4' },
    };
    const sourceB = { ...source24, endFrame: 290, numFrames: 300, video_name: 'b.mp4' };
    const result = applyReferenceExtendSourceVideo([handTrimmedB, linkedA!], sourceB, 3, FRAMES);

    expect(result[0]).toBe(handTrimmedB);
    expect(result[1]).toMatchObject({
      clip: { endFrame: 290, startFrame: 150, video_name: 'b.mp4' },
      fromSourceVideo: true,
    });
    expect(result.filter((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)).toHaveLength(1);
  });

  it('leaves a full video-reference list unchanged instead of overflowing the cap', () => {
    const full = [
      VIDEO_REFERENCE,
      { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'b.mp4' } },
      { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'c.mp4' } },
    ];

    expect(applyReferenceExtendSourceVideo(full, source24, 3, FRAMES)).toBe(full);
  });

  it('applyReferenceExtendNumFrames re-derives the window and is idempotent', () => {
    const linked = applyReferenceExtendSourceVideo([IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(linked[1]).toMatchObject({ clip: { startFrame: 260 } });

    const at124 = applyReferenceExtendNumFrames(linked, 124);

    expect(at124[1]).toMatchObject({ clip: { endFrame: 400, startFrame: 277 }, fromSourceVideo: true });
    expect(at124[0]).toBe(linked[0]);
    // Idempotent, and identity-preserving when nothing moves.
    expect(applyReferenceExtendNumFrames(at124, 124)).toBe(at124);
    expect(applyReferenceExtendNumFrames(linked, FRAMES)).toBe(linked);
  });

  it('applyReferenceExtendNumFrames does not ratchet: the window re-widens', () => {
    // The Frames number input emits a value per keystroke, unclamped, so typing
    // "345" arrives as 3, then 34, then 345. A shrink-only rule would pin the
    // window at the 3-frame budget for the rest of the session.
    const linked = applyReferenceExtendSourceVideo([], source24, 3, 345);
    const typed = [3, 34, 345].reduce(applyReferenceExtendNumFrames, linked);

    expect(typed[0]).toMatchObject({ clip: { endFrame: 400, startFrame: 260 } });
    // And a slider dragged down and back up ends where it started.
    expect([90, 124, 345].reduce(applyReferenceExtendNumFrames, linked)[0]).toMatchObject({
      clip: { startFrame: 260 },
    });
  });

  it('an updater applied after a concurrent write keeps both changes', () => {
    // The reference field hands `setReferences` an UPDATER because its add
    // handlers await a gallery resolve before writing. Modelled here: the
    // handler captures the list, the Initial Video field places the anchor
    // during the await, then the resolve lands. A captured-array write would
    // drop the anchor entirely; an updater over live state keeps both.
    const captured: VideoReferenceItem[] = [];
    const add = (current: VideoReferenceItem[]): VideoReferenceItem[] => [...current, IMAGE_REFERENCE];

    // ...the Initial Video lands mid-flight.
    const live = applyReferenceExtendSourceVideo(captured, source24, 3, FRAMES);

    expect(live.some((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)).toBe(true);

    // ...then the resolve writes, against LIVE state rather than `captured`.
    const merged = pinReferenceExtendAnchor(add(live));

    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(IMAGE_REFERENCE);
    expect(merged[1]).toMatchObject({ fromSourceVideo: true, kind: 'video' });

    // The snapshot write this replaced would have produced just the image.
    expect(add(captured)).toEqual([IMAGE_REFERENCE]);
  });

  it('pins the continuity anchor last, whatever the add or drag order', () => {
    // Request order is rotary order: the generated frames continue from the
    // LAST reference block. An image added after the Initial Video would
    // otherwise take a rotary slot between the initial video's tail and the
    // first generated frame.
    const linked = applyReferenceExtendSourceVideo([], source24, 3, FRAMES);
    const anchor = linked[0]!;

    expect(pinReferenceExtendAnchor([anchor, IMAGE_REFERENCE])).toEqual([IMAGE_REFERENCE, anchor]);
    expect(pinReferenceExtendAnchor([IMAGE_REFERENCE, VIDEO_REFERENCE, anchor])).toEqual([
      IMAGE_REFERENCE,
      VIDEO_REFERENCE,
      anchor,
    ]);
    // Identity-preserving when already last, and when there is no anchor.
    const settled = [IMAGE_REFERENCE, anchor];

    expect(pinReferenceExtendAnchor(settled)).toBe(settled);
    const none = [IMAGE_REFERENCE, VIDEO_REFERENCE];

    expect(pinReferenceExtendAnchor(none)).toBe(none);

    // Adopting a recalled entry re-pins it rather than leaving it in place.
    const recalled = { ...VIDEO_REFERENCE, clip: { ...VIDEO_REFERENCE.clip, video_name: 'long.mp4' } };
    const adopted = applyReferenceExtendSourceVideo([recalled, IMAGE_REFERENCE], source24, 3, FRAMES);

    expect(adopted[1]).toMatchObject({ fromSourceVideo: true, kind: 'video' });
  });

  it('canPlaceReferenceExtendAnchor agrees with the setter in every state', () => {
    const video = (name: string, flagged = false) => ({
      ...VIDEO_REFERENCE,
      clip: { ...VIDEO_REFERENCE.clip, video_name: name },
      ...(flagged ? { fromSourceVideo: true } : {}),
    });
    const states: VideoReferenceItem[][] = [
      [],
      [IMAGE_REFERENCE],
      [video('a.mp4')],
      [video('a.mp4'), video('b.mp4')],
      [video('a.mp4'), video('b.mp4'), video('c.mp4')],
      // Recall's shape: three unflagged videos, one naming the source clip.
      [video('long.mp4'), video('b.mp4'), video('c.mp4')],
      [video('a.mp4'), video('b.mp4'), video('long.mp4', true)],
    ];

    for (const references of states) {
      const placed = applyReferenceExtendSourceVideo(references, source24, 3, FRAMES);
      // The setter signals refusal by returning the input array unchanged.
      const setterAccepted = placed !== references;

      expect({
        references: references.map((e) => (e.kind === 'video' ? e.clip.video_name : 'img')),
        placed: canPlaceReferenceExtendAnchor(references, source24.video_name, 3),
      }).toEqual({
        references: references.map((e) => (e.kind === 'video' ? e.clip.video_name : 'img')),
        placed: setterAccepted,
      });
    }
  });

  it('applyReferenceExtendNumFrames leaves unlinked references alone', () => {
    const unlinked = [VIDEO_REFERENCE, IMAGE_REFERENCE];

    expect(applyReferenceExtendNumFrames(unlinked, 90)).toBe(unlinked);
  });
});

describe('reference sample window', () => {
  const clip = (startFrame: number, endFrame: number, numFrames = 300) => ({
    endFrame,
    fps: 24,
    height: 480,
    numFrames,
    startFrame,
    video_name: 'clip.mp4',
    width: 640,
  });

  describe('slideReferenceSampleWindow', () => {
    it('slides an ordinary window at constant length', () => {
      const next = slideReferenceSampleWindow(clip(0, 199), 50, false);
      expect([next.startFrame, next.endFrame]).toEqual([50, 249]);
    });

    it('stops at the clip end instead of shrinking (no overshoot ratchet)', () => {
      // Drag far past the wall, then back to 0: the length must survive the round trip.
      const overshot = slideReferenceSampleWindow(clip(0, 199), 299, false);
      expect([overshot.startFrame, overshot.endFrame]).toEqual([100, 299]);
      const back = slideReferenceSampleWindow(overshot, 0, false);
      expect([back.startFrame, back.endFrame]).toEqual([0, 199]);
    });

    it('keeps the extend anchor end pinned to the cutpoint', () => {
      // The anchor's seam continuity depends on frames adjacent to its end frame.
      const next = slideReferenceSampleWindow(clip(180, 298), 200, true);
      expect([next.startFrame, next.endFrame]).toEqual([200, 298]);
      const backAndForth = slideReferenceSampleWindow(slideReferenceSampleWindow(next, 250, true), 200, true);
      expect([backAndForth.startFrame, backAndForth.endFrame]).toEqual([200, 298]);
    });

    it('clamps the anchor start to its pinned end', () => {
      const next = slideReferenceSampleWindow(clip(180, 298), 500, true);
      expect([next.startFrame, next.endFrame]).toEqual([298, 298]);
    });

    it('self-heals a corrupt persisted trim into bounds', () => {
      // end < start and end beyond the clip must both come back as a valid window.
      const inverted = slideReferenceSampleWindow(clip(10, 5, 20), 0, false);
      expect(inverted.startFrame).toBeGreaterThanOrEqual(0);
      expect(inverted.endFrame).toBeGreaterThanOrEqual(inverted.startFrame);
      expect(inverted.endFrame).toBeLessThanOrEqual(19);
      const oversized = slideReferenceSampleWindow(clip(0, 999, 20), 5, false);
      expect([oversized.startFrame, oversized.endFrame]).toEqual([0, 19]);
    });

    it('handles a single-frame clip', () => {
      const next = slideReferenceSampleWindow(clip(0, 0, 1), 5, false);
      expect([next.startFrame, next.endFrame]).toEqual([0, 0]);
    });
  });

  describe('resizeReferenceSampleWindow', () => {
    it('grows an ordinary window forward from its start', () => {
      const next = resizeReferenceSampleWindow(clip(50, 60), 100, false);
      expect([next.startFrame, next.endFrame]).toEqual([50, 149]);
    });

    it('clamps the length to the clip end', () => {
      const next = resizeReferenceSampleWindow(clip(250, 260), 100, false);
      expect([next.startFrame, next.endFrame]).toEqual([250, 299]);
    });

    it('grows the extend anchor backward from its pinned end', () => {
      const next = resizeReferenceSampleWindow(clip(280, 298), 100, true);
      expect([next.startFrame, next.endFrame]).toEqual([199, 298]);
    });

    it('clamps the anchor lead-in at the clip start', () => {
      const next = resizeReferenceSampleWindow(clip(280, 298), 1000, true);
      expect([next.startFrame, next.endFrame]).toEqual([0, 298]);
    });

    it('never produces a window shorter than one frame', () => {
      const next = resizeReferenceSampleWindow(clip(50, 199), -5, false);
      expect([next.startFrame, next.endFrame]).toEqual([50, 50]);
    });
  });
});
