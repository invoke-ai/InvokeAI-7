import type { GenerateLora, ImageWithDims } from '@features/generation/contracts';

import {
  DEFAULT_NEGATIVE_PROMPT_HEIGHT_PX,
  DEFAULT_POSITIVE_PROMPT_HEIGHT_PX,
  isLoraModelConfig,
  isMainModelConfig,
  isModelIdentifierConfig,
  isVaeModelConfig,
  MAX_NEGATIVE_PROMPT_HEIGHT_PX,
  MAX_POSITIVE_PROMPT_HEIGHT_PX,
  MIN_NEGATIVE_PROMPT_HEIGHT_PX,
  MIN_POSITIVE_PROMPT_HEIGHT_PX,
  sanitizeBatchCount,
} from '@features/generation/settings';

import type {
  MiniMaxH3TargetResolution,
  VideoAspectRatioId,
  VideoGenerationMode,
  VideoReferenceItem,
  VideoSettings,
  VideoSourceClip,
  VideoTargetResolution,
  VideoWidgetValues,
  WanTargetResolution,
} from './types';

import { MINIMAX_H3_FPS } from './dimensions';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

const hasFiniteNumber = (record: Record<string, unknown>, key: string): boolean =>
  typeof record[key] === 'number' && Number.isFinite(record[key]);

const getClampedNumber = (record: Record<string, unknown>, key: string, min: number, max: number, fallback: number) =>
  hasFiniteNumber(record, key) ? Math.min(Math.max(record[key] as number, min), max) : fallback;

export const VIDEO_ASPECT_RATIO_IDS: readonly VideoAspectRatioId[] = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '1:1',
  '3:4',
  '2:3',
  '9:16',
  '9:21',
];

export const isVideoAspectRatioId = (value: unknown): value is VideoAspectRatioId =>
  typeof value === 'string' && (VIDEO_ASPECT_RATIO_IDS as readonly string[]).includes(value);

export const WAN_TARGET_RESOLUTIONS: readonly WanTargetResolution[] = ['480p', '720p', '1080p'];
export const MINIMAX_H3_TARGET_RESOLUTIONS: readonly MiniMaxH3TargetResolution[] = ['768 highres', '768 lowres'];

export const isVideoTargetResolution = (value: unknown): value is VideoTargetResolution =>
  typeof value === 'string' &&
  ((WAN_TARGET_RESOLUTIONS as readonly string[]).includes(value) ||
    (MINIMAX_H3_TARGET_RESOLUTIONS as readonly string[]).includes(value));

export const isImageWithDims = (value: unknown): value is ImageWithDims =>
  isRecord(value) &&
  typeof value.image_name === 'string' &&
  hasFiniteNumber(value, 'width') &&
  hasFiniteNumber(value, 'height');

export const isVideoSourceClip = (value: unknown): value is VideoSourceClip =>
  isRecord(value) &&
  typeof value.video_name === 'string' &&
  hasFiniteNumber(value, 'width') &&
  hasFiniteNumber(value, 'height') &&
  hasFiniteNumber(value, 'numFrames') &&
  hasFiniteNumber(value, 'fps') &&
  hasFiniteNumber(value, 'startFrame') &&
  hasFiniteNumber(value, 'endFrame');

/** Upstream Ref2VA's reference caps (mirrored by the backend's validate_reference_kinds). */
export const VIDEO_REFERENCE_MAX_VIDEOS = 3;
export const VIDEO_REFERENCE_MAX_IMAGES = 9;

/**
 * Default sample length (in frames) for a newly added video reference. Reference rows cost
 * VRAM in every denoise step — the packed sequence grows with reference length — so the
 * useful sample is a short window that captures the wanted visual/audio features, not the
 * whole clip. 200 frames ≈ 8s at the models' native 24 fps.
 */
export const DEFAULT_REFERENCE_SAMPLE_FRAMES = 200;

/**
 * Move a reference clip's sample window to a new start frame.
 *
 * Ordinary references slide at CONSTANT length, stopping at the clip's end rather than
 * shrinking — a transient overshoot during a drag must not ratchet the sample down. The
 * reference-extend anchor (`pinEnd`) instead keeps its end frame pinned to the Initial
 * Video cutpoint (seam continuity depends on the frames adjacent to it; see
 * deriveReferenceExtendClip), so moving its start only adjusts the lead-in length.
 *
 * Self-healing by construction: the returned window always satisfies
 * 0 <= start <= end <= numFrames - 1, even from a corrupt persisted trim.
 */
export const slideReferenceSampleWindow = (
  clip: VideoSourceClip,
  rawStart: number,
  pinEnd: boolean
): VideoSourceClip => {
  const maxFrame = Math.max(0, clip.numFrames - 1);

  if (pinEnd) {
    const endFrame = Math.min(Math.max(0, clip.endFrame), maxFrame);
    const startFrame = Math.min(Math.max(0, Math.round(rawStart)), endFrame);

    return { ...clip, endFrame, startFrame };
  }

  const sampleFrames = Math.min(Math.max(1, clip.endFrame - clip.startFrame + 1), maxFrame + 1);
  const startFrame = Math.min(Math.max(0, Math.round(rawStart)), maxFrame - (sampleFrames - 1));

  return { ...clip, endFrame: startFrame + sampleFrames - 1, startFrame };
};

/**
 * Resize a reference clip's sample window to a new length in frames.
 *
 * Ordinary references grow from the start frame (the end moves, clamped to the clip); the
 * reference-extend anchor (`pinEnd`) grows backward from its pinned end (the start moves),
 * since its end must stay on the Initial Video cutpoint. Same self-healing bounds as
 * slideReferenceSampleWindow.
 */
export const resizeReferenceSampleWindow = (
  clip: VideoSourceClip,
  rawSampleFrames: number,
  pinEnd: boolean
): VideoSourceClip => {
  const maxFrame = Math.max(0, clip.numFrames - 1);
  const sampleFrames = Math.min(Math.max(1, Math.round(rawSampleFrames)), maxFrame + 1);

  if (pinEnd) {
    const endFrame = Math.min(Math.max(0, clip.endFrame), maxFrame);

    return { ...clip, endFrame, startFrame: Math.max(0, endFrame - (sampleFrames - 1)) };
  }

  const startFrame = Math.min(Math.max(0, clip.startFrame), maxFrame);

  return { ...clip, endFrame: Math.min(startFrame + sampleFrames - 1, maxFrame), startFrame };
};

const VIDEO_REFERENCE_CONDITIONINGS = ['video_audio', 'video', 'audio'] as const;
const VIDEO_REFERENCE_IMAGE_DETAILS = ['max', 'match'] as const;

export const isVideoReferenceItem = (value: unknown): value is VideoReferenceItem => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'video') {
    return (
      isVideoSourceClip(value.clip) &&
      VIDEO_REFERENCE_CONDITIONINGS.includes(value.conditioning as (typeof VIDEO_REFERENCE_CONDITIONINGS)[number])
    );
  }
  if (value.kind === 'image') {
    return (
      isImageWithDims(value.image) &&
      VIDEO_REFERENCE_IMAGE_DETAILS.includes(value.detail as (typeof VIDEO_REFERENCE_IMAGE_DETAILS)[number])
    );
  }
  return false;
};

/**
 * Drops invalid entries and enforces the per-kind caps, preserving order.
 *
 * An over-cap list should never reach here — the add paths re-check the cap
 * against the live list at apply time and the Initial Video field disables
 * itself when the video slots are full — so this is the guard for a stale or
 * hand-edited project record.
 *
 * Video overflow drops the NEWEST non-anchor entries: the surplus is whatever
 * arrived last, and a plain front-drop deleted the user's OLDEST reference
 * whenever a racing add slipped past the cap. The anchor is exempt whatever
 * its position — request order is rotary order and the generated frames
 * continue from the LAST block, so it is the one entry the extension depends
 * on. Images carry no ordering role and keep the front.
 */
const sanitizeVideoReferences = (value: unknown, sourceVideoName?: string): VideoReferenceItem[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  let valid = value.filter((entry) => isVideoReferenceItem(entry));

  // Canonicalize the flag to AT MOST ONE entry, keeping the LAST. Only a
  // corrupt or hand-merged record carries two, but two is a poisoned state:
  // the pin moves the FIRST flagged entry last, so normalization oscillates
  // between the pair on alternate passes, and the overflow trim below exempts
  // every flagged entry, so an over-cap list of them could never be brought
  // under the cap again. The last one matches the pin invariant every healthy
  // record was written under.
  let flagged = -1;
  for (let index = valid.length - 1; index >= 0; index -= 1) {
    const entry = valid[index]!;

    if (entry.kind === 'video' && entry.fromSourceVideo === true) {
      flagged = index;
      break;
    }
  }
  valid = valid.map((entry, index) =>
    index !== flagged && entry.kind === 'video' && entry.fromSourceVideo === true
      ? { ...entry, fromSourceVideo: false }
      : entry
  );

  // Re-establish the linkage recall drops. `fromSourceVideo` is panel state
  // and never reaches metadata, so a recalled panel arrives with its anchor
  // UNFLAGGED beside the source video -- and every invariant keyed on the flag
  // (the pin, the frame-count re-budget, the seam-anchored start index)
  // silently lapses: a Frames change left the recalled window unbudgeted and
  // the backend cut 2s off the seam. The flag is derivable, not just
  // storable: the video reference naming the Initial Video's clip IS the
  // anchor. An already-flagged entry stays authoritative.
  //
  // Adopt the LAST same-name entry, not the first. The pin invariant means
  // the anchor is always recorded last, and recorded metadata can hold a
  // user's OWN reference to the same clip ahead of it -- a first-match
  // flagged that one instead: the user's trim got re-budgeted, the list
  // reordered against the recording, and the true tail window was left
  // unprotected at the seam.
  if (flagged === -1 && sourceVideoName !== undefined) {
    for (let index = valid.length - 1; index >= 0; index -= 1) {
      const entry = valid[index]!;

      if (entry.kind === 'video' && entry.clip.video_name === sourceVideoName) {
        valid = valid.map((candidate, candidateIndex) =>
          candidateIndex === index && candidate.kind === 'video' ? { ...candidate, fromSourceVideo: true } : candidate
        );
        break;
      }
    }
  }

  // Pin BEFORE the cap trim. The front-drop below assumes the anchor is last,
  // but a project saved by the build that PREPENDED it loads with the anchor
  // first -- so without this the overflow rule deletes the one entry it exists
  // to protect. Pinning here also heals those panels on load: normalization
  // runs on every read, whereas `setReferences` only fires once the user
  // touches the reference list.
  valid = pinReferenceExtendAnchor(valid);

  // Keyed by INDEX, not object identity: a hand-edited record can alias the
  // same entry object twice, and an identity Set would drop both copies.
  // With the flag canonicalized to at most one entry above, the flag
  // exemption can never leave the surplus undroppable.
  let videosToDrop = Math.max(0, valid.filter((entry) => entry.kind === 'video').length - VIDEO_REFERENCE_MAX_VIDEOS);
  const dropped = new Set<number>();
  for (let index = valid.length - 1; index >= 0 && videosToDrop > 0; index -= 1) {
    const entry = valid[index]!;

    if (entry.kind === 'video' && entry.fromSourceVideo !== true) {
      dropped.add(index);
      videosToDrop -= 1;
    }
  }

  const result: VideoReferenceItem[] = [];
  let images = 0;
  for (const [index, entry] of valid.entries()) {
    if (entry.kind === 'image') {
      if (images >= VIDEO_REFERENCE_MAX_IMAGES) {
        continue;
      }
      images += 1;
    } else if (dropped.has(index)) {
      continue;
    }
    result.push(entry);
  }
  return result;
};

const isVideoLora = (value: unknown): value is GenerateLora =>
  isRecord(value) &&
  isLoraModelConfig(value.model) &&
  hasFiniteNumber(value, 'weight') &&
  typeof value.isEnabled === 'boolean';

const getStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** Whether every key the accelerator toggle recorded is still present AND enabled in the LoRA list. */
const areAcceleratorLorasPresent = (keys: readonly string[], loras: readonly GenerateLora[]): boolean =>
  keys.length > 0 && keys.every((key) => loras.some((lora) => lora.model.key === key && lora.isEnabled));

/**
 * Which inputs are filled decides the mode; there is no mode selector. A first
 * frame and a source video never coexist (normalization and the setters both
 * enforce it), and a last frame refines whichever mode its partner implies:
 * with a first frame it becomes FLF2V interpolation, with a source video it is
 * the destination the extension should land on. References always win: with a
 * source video alongside them (Ref2VA reference-extend) the mode stays
 * `reference` and the graph appends the new clip to the source.
 */
export const resolveVideoMode = (
  settings: Pick<VideoSettings, 'firstFrameImage' | 'lastFrameImage' | 'sourceVideo' | 'references'>
): VideoGenerationMode => {
  if (settings.references.length > 0) {
    return 'reference';
  }

  if (settings.sourceVideo) {
    return 'extend';
  }

  if (settings.firstFrameImage) {
    return settings.lastFrameImage ? 'first-last' : 'first-frame';
  }

  return settings.lastFrameImage ? 'last-frame' : 'txt2vid';
};

/**
 * The fields of `VideoSettings` that describe how the panel is arranged rather
 * than what will be generated. Mirrors `GENERATE_UI_STATE_KEYS`.
 */
export const VIDEO_UI_STATE_KEYS = {
  batchCount: true,
  negativePromptHeightPx: true,
  positivePromptHeightPx: true,
} satisfies Partial<Record<keyof VideoSettings, true>>;

// Model-agnostic fallbacks for healing partial records. They intentionally
// mirror the Wan fallback in the capability matrix, which cannot be imported
// here (videoPolicies imports this module); when a model is known, the
// selection transition re-snaps them to its family anyway.
const SETTINGS_FALLBACKS = {
  aspectRatioId: '16:9',
  cfgScale: 5,
  fps: 16,
  numFrames: 81,
  steps: 40,
  targetResolution: '720p',
} as const;

/**
 * Heals older/partial persisted values without silently clamping invalid user
 * input, upscale-style: any record normalizes field-by-field (so a seeded
 * partial write — e.g. "Send to Video" landing on a never-opened widget —
 * keeps its payload), while range problems stay validation reasons.
 */
export const normalizeVideoSettings = (values: unknown): VideoSettings | null => {
  if (!isRecord(values)) {
    return null;
  }

  // References are mutually exclusive with the frame slots; when a stale
  // record somehow holds both, the references win deterministically. A source
  // video COEXISTS with references (Ref2VA reference-extend) — validation
  // rejects the pair on models that cannot consume it.
  const references = sanitizeVideoReferences(
    values.references,
    isVideoSourceClip(values.sourceVideo) ? values.sourceVideo.video_name : undefined
  );
  const hasReferences = references.length > 0;
  const firstFrameImage = !hasReferences && isImageWithDims(values.firstFrameImage) ? values.firstFrameImage : null;
  // A first frame and a source video are mutually exclusive; if a stale
  // project somehow holds both, the first frame wins deterministically.
  const sourceVideo = !firstFrameImage && isVideoSourceClip(values.sourceVideo) ? values.sourceVideo : null;
  const loras = Array.isArray(values.loras) ? values.loras.filter(isVideoLora) : [];
  const acceleratorLoraKeys = getStringArray(values.acceleratorLoraKeys);
  // The flag means "the accelerator LoRAs the toggle added are active": if any
  // of them is gone (deleted from Concepts, dropped as incompatible), the flag
  // clears rather than claiming a fast path that has nothing behind it.
  const acceleratorEnabled =
    values.acceleratorEnabled === true && areAcceleratorLorasPresent(acceleratorLoraKeys, loras);

  return {
    aspectRatioId: isVideoAspectRatioId(values.aspectRatioId) ? values.aspectRatioId : SETTINGS_FALLBACKS.aspectRatioId,
    batchCount: sanitizeBatchCount(values.batchCount),
    cfgScale: hasFiniteNumber(values, 'cfgScale') ? (values.cfgScale as number) : SETTINGS_FALLBACKS.cfgScale,
    cfgScaleLowNoise: hasFiniteNumber(values, 'cfgScaleLowNoise') ? (values.cfgScaleLowNoise as number) : null,
    firstFrameImage,
    fps: hasFiniteNumber(values, 'fps') ? (values.fps as number) : SETTINGS_FALLBACKS.fps,
    h3TextEncoderModel: isModelIdentifierConfig(values.h3TextEncoderModel) ? values.h3TextEncoderModel : null,
    h3TransformerModel: isMainModelConfig(values.h3TransformerModel) ? values.h3TransformerModel : null,
    acceleratorEnabled,
    acceleratorLoraKeys: acceleratorEnabled ? acceleratorLoraKeys : [],
    lastFrameImage: !hasReferences && isImageWithDims(values.lastFrameImage) ? values.lastFrameImage : null,
    loras,
    modelKey: typeof values.modelKey === 'string' ? values.modelKey : '',
    negativePrompt: typeof values.negativePrompt === 'string' ? values.negativePrompt : '',
    negativePromptEnabled: typeof values.negativePromptEnabled === 'boolean' ? values.negativePromptEnabled : true,
    negativePromptHeightPx: getClampedNumber(
      values,
      'negativePromptHeightPx',
      MIN_NEGATIVE_PROMPT_HEIGHT_PX,
      MAX_NEGATIVE_PROMPT_HEIGHT_PX,
      DEFAULT_NEGATIVE_PROMPT_HEIGHT_PX
    ),
    numFrames: hasFiniteNumber(values, 'numFrames') ? (values.numFrames as number) : SETTINGS_FALLBACKS.numFrames,
    positivePrompt: typeof values.positivePrompt === 'string' ? values.positivePrompt : '',
    positivePromptHeightPx: getClampedNumber(
      values,
      'positivePromptHeightPx',
      MIN_POSITIVE_PROMPT_HEIGHT_PX,
      MAX_POSITIVE_PROMPT_HEIGHT_PX,
      DEFAULT_POSITIVE_PROMPT_HEIGHT_PX
    ),
    references,
    seed: hasFiniteNumber(values, 'seed') ? (values.seed as number) : 0,
    shouldRandomizeSeed: typeof values.shouldRandomizeSeed === 'boolean' ? values.shouldRandomizeSeed : true,
    sourceVideo,
    steps: hasFiniteNumber(values, 'steps') ? (values.steps as number) : SETTINGS_FALLBACKS.steps,
    targetResolution: isVideoTargetResolution(values.targetResolution)
      ? values.targetResolution
      : SETTINGS_FALLBACKS.targetResolution,
    vae: isVaeModelConfig(values.vae) ? values.vae : null,
    wanLowNoiseModel: isMainModelConfig(values.wanLowNoiseModel) ? values.wanLowNoiseModel : null,
    wanT5EncoderModel: isModelIdentifierConfig(values.wanT5EncoderModel) ? values.wanT5EncoderModel : null,
    componentSourceModel: isMainModelConfig(values.componentSourceModel) ? values.componentSourceModel : null,
  };
};

export const isVideoSettings = (values: unknown): values is VideoSettings => {
  const normalized = normalizeVideoSettings(values);

  if (!normalized || !isRecord(values)) {
    return false;
  }

  // Strict only over the keys normalize would have to invent.
  return (
    isVideoAspectRatioId(values.aspectRatioId) &&
    isVideoTargetResolution(values.targetResolution) &&
    typeof values.negativePromptEnabled === 'boolean' &&
    typeof values.acceleratorEnabled === 'boolean' &&
    Array.isArray(values.acceleratorLoraKeys) &&
    values.acceleratorLoraKeys.every((key) => typeof key === 'string') &&
    (values.acceleratorEnabled === false
      ? (values.acceleratorLoraKeys as string[]).length === 0
      : Array.isArray(values.loras) &&
        areAcceleratorLorasPresent(values.acceleratorLoraKeys as string[], values.loras.filter(isVideoLora))) &&
    hasFiniteNumber(values, 'negativePromptHeightPx') &&
    hasFiniteNumber(values, 'positivePromptHeightPx') &&
    (values.cfgScaleLowNoise === null || hasFiniteNumber(values, 'cfgScaleLowNoise')) &&
    (values.firstFrameImage === null || isImageWithDims(values.firstFrameImage)) &&
    (values.lastFrameImage === null || isImageWithDims(values.lastFrameImage)) &&
    (values.sourceVideo === null || isVideoSourceClip(values.sourceVideo)) &&
    !(values.firstFrameImage !== null && values.sourceVideo !== null) &&
    Array.isArray(values.references) &&
    values.references.every(isVideoReferenceItem) &&
    !(
      (values.references as unknown[]).length > 0 &&
      (values.firstFrameImage !== null || values.lastFrameImage !== null)
    ) &&
    Array.isArray(values.loras) &&
    values.loras.every(isVideoLora) &&
    (values.vae === null || isVaeModelConfig(values.vae)) &&
    (values.wanT5EncoderModel === null || isModelIdentifierConfig(values.wanT5EncoderModel)) &&
    (values.wanLowNoiseModel === null || isMainModelConfig(values.wanLowNoiseModel)) &&
    (values.componentSourceModel === null || isMainModelConfig(values.componentSourceModel)) &&
    (values.h3TransformerModel === null || isMainModelConfig(values.h3TransformerModel)) &&
    (values.h3TextEncoderModel === null || isModelIdentifierConfig(values.h3TextEncoderModel))
  );
};

export const normalizeVideoWidgetValues = (values: unknown): VideoWidgetValues | null => {
  const settings = normalizeVideoSettings(values);

  if (!settings || !isRecord(values)) {
    return null;
  }

  return { ...settings, model: isMainModelConfig(values.model) ? values.model : null };
};

export const isVideoWidgetValues = (values: unknown): values is VideoWidgetValues => {
  if (!isVideoSettings(values)) {
    return false;
  }

  const model = (values as unknown as Record<string, unknown>).model;

  return model === null || isMainModelConfig(model);
};

export const cloneVideoWidgetValues = (values: VideoWidgetValues): VideoWidgetValues & Record<string, unknown> => ({
  ...values,
  acceleratorLoraKeys: [...values.acceleratorLoraKeys],
  componentSourceModel: values.componentSourceModel ? { ...values.componentSourceModel } : null,
  firstFrameImage: values.firstFrameImage ? { ...values.firstFrameImage } : null,
  h3TextEncoderModel: values.h3TextEncoderModel ? { ...values.h3TextEncoderModel } : null,
  h3TransformerModel: values.h3TransformerModel ? { ...values.h3TransformerModel } : null,
  lastFrameImage: values.lastFrameImage ? { ...values.lastFrameImage } : null,
  loras: values.loras.map((lora) => ({ ...lora, model: { ...lora.model } })),
  model: values.model ? { ...values.model } : null,
  references: values.references.map((reference) =>
    reference.kind === 'video'
      ? { ...reference, clip: { ...reference.clip } }
      : { ...reference, image: { ...reference.image } }
  ),
  sourceVideo: values.sourceVideo ? { ...values.sourceVideo } : null,
  vae: values.vae ? { ...values.vae } : null,
  wanLowNoiseModel: values.wanLowNoiseModel ? { ...values.wanLowNoiseModel } : null,
  wanT5EncoderModel: values.wanT5EncoderModel ? { ...values.wanT5EncoderModel } : null,
});

/** Fallback frame rate when a clip's probe did not record one (mirrors extract_video_range). */
export const VIDEO_SOURCE_FALLBACK_FPS = 16;

/**
 * Builds the panel's source-clip record from a gallery video. The frame count
 * is an estimate (duration × fps — the records store no exact count); the
 * backend's extract_video_range resolves authoritative indices at run time.
 * The default trim keeps everything but the final frame (the bundled extend
 * templates' `end_frame: -2`): the extension starts on the trimmed clip's last
 * frame, so keeping the very last one would duplicate it across the seam.
 */
export const createVideoSourceClip = (item: {
  durationSeconds: number;
  fps?: number;
  height: number;
  name: string;
  width: number;
}): VideoSourceClip => {
  const fps = item.fps && Number.isFinite(item.fps) && item.fps > 0 ? item.fps : VIDEO_SOURCE_FALLBACK_FPS;
  const numFrames = Math.max(1, Math.round(item.durationSeconds * fps));

  return {
    // Never below 1: the crossfade join needs at least a two-frame trim.
    endFrame: Math.max(1, numFrames - 2),
    fps,
    height: item.height,
    numFrames,
    startFrame: 0,
    video_name: item.name,
    width: item.width,
  };
};

/** The minimum frames a trim must keep — video_concat's crossfade consumes a 2-frame tail. */
export const MIN_VIDEO_TRIM_FRAMES = 2;

/**
 * The MAXIMUM lead-in the reference-extend tail reference samples ahead of the
 * cutpoint, expressed at 24 fps: ~5s, and exactly on the 17n+5 frame grid
 * (17*8+5) so the backend's 24 fps resample + snap-down keeps all of it.
 *
 * The window is a DURATION — `deriveReferenceExtendClip` scales it to the
 * source clip's own frame rate, so a 16 fps source samples 94 frames of the
 * same ~5.9 s rather than 141 frames of ~8.8 s. It is also a CEILING, not a
 * fixed size: the generated frame count is the other bound, and the smaller of
 * the two wins.
 */
export const VIDEO_REFERENCE_EXTEND_TAIL_FRAMES = 141;

/**
 * The tail reference's default trim: the frames right before the cutpoint,
 * sized so the backend keeps ALL of them.
 *
 * Three backend rules bound the window, and every one of them discards from
 * the END — the frames adjacent to the cutpoint, the only ones continuity
 * depends on. `normalize_reference_video_frames` resamples onto H3's fixed
 * 24 fps and truncates to the GENERATED frame count keeping the FRONT
 * (`frames[:num_frames]`); `encode_reference_video` then snaps what survives
 * DOWN to the `17n + 5` grid the video VAE encodes without padding.
 *
 * The budget is therefore `min(TAIL, numFrames)` frames of 24 fps material,
 * and both of those sit ON that grid already (141 = 17*8+5; every frame choice
 * is 90 + 17i). The conversion into the source clip's own frame space rounds
 * UP: overshooting is free, because the truncation cuts the window back to
 * exactly `numFrames` and the snap then keeps it whole, while undershooting
 * lands OFF the grid and the snap eats up to 16 frames at the seam. Rounding
 * down looks safer and is not — it cost 17 frames at 23.976 fps (NTSC film) at
 * every frame count on offer, and 17 at 16 fps at the 124-frame default.
 */
export const deriveReferenceExtendClip = (sourceVideo: VideoSourceClip, numFrames: number): VideoSourceClip => ({
  ...sourceVideo,
  endFrame: sourceVideo.endFrame,
  // Deliberately unclamped by the Initial Video's START cutpoint: the
  // reference samples the original clip for continuity, independent of which
  // portion the extension keeps.
  startFrame: referenceExtendStartFrame(sourceVideo, numFrames),
});

/**
 * The highest source frame rate the tail-window math accepts as real; see the
 * fps guard below. The float plateau it guards (`tail + 1 === tail`) starts
 * around fps 1.5e15, so 1e6 keeps nine orders of margin — a tighter bound of
 * 1000 turned real high-rate containers (probe-reported 1200 fps decoded fine
 * before) into backend hard failures: the 24 fps fallback sized a 141-SOURCE-
 * frame window that the backend, resampling at the rate it probes itself,
 * collapsed to 3 frames, under text conditioning's 13-frame minimum.
 */
const MAX_REFERENCE_SOURCE_FPS = 1e6;

/** `snap_reference_num_frames`: down to the `17n + 5` grid the video VAE encodes whole. */
const snapReferenceFrames = (frames: number): number => Math.max(1, Math.floor((frames - 5) / 17)) * 17 + 5;

/** Source frames -> frames after the backend's 24 fps resample (ffmpeg's fps-filter count). */
const resampledFrameCount = (sourceFrames: number, fps: number): number =>
  Math.floor((sourceFrames * MINIMAX_H3_FPS) / fps + 0.5);

/** The tail window's start index — see `deriveReferenceExtendClip`. */
const referenceExtendStartFrame = (clip: VideoSourceClip, numFrames: number): number => {
  // A clip whose probe recorded no usable rate: the backend resamples at the
  // rate it probes, so 24 — a no-op conversion — is the only safe assumption.
  // A zero or negative rate would otherwise collapse the window to the 2-frame
  // floor, which is below the 13 frames text conditioning needs. The upper
  // bound is a hang guard: past ~2^53 source frames, `tailSourceFrames`'
  // adjustment loops cannot even step (`tail + 1 === tail` in floats) and spin
  // forever on the main thread — a hand-edited record with fps 1e17 froze the
  // tab on the first Frames keystroke.
  const fps =
    Number.isFinite(clip.fps) && clip.fps > 0 && clip.fps <= MAX_REFERENCE_SOURCE_FPS ? clip.fps : MINIMAX_H3_FPS;
  const requested = Number.isFinite(numFrames)
    ? Math.min(VIDEO_REFERENCE_EXTEND_TAIL_FRAMES, Math.trunc(numFrames))
    : VIDEO_REFERENCE_EXTEND_TAIL_FRAMES;
  // A clip shorter than the window cannot supply the whole budget, and simply
  // taking what is there leaves the window OFF the 17n+5 grid — so the
  // snap-down cuts the difference from the END, the frames at the cutpoint.
  // (24 fps, a 120-frame clip, numFrames 345: a [0,118] window keeps 107 of
  // its 119 frames and stops half a second short of the seam.) Falling back to
  // the largest on-grid budget the clip DOES support keeps the same frames and
  // lands them on the seam. Both bounds are already on the grid in the normal
  // case, so this is an identity there.
  const budget = Math.min(
    requested,
    snapReferenceFrames(Math.min(resampledFrameCount(clip.endFrame + 1, fps), requested))
  );

  return Math.max(0, clip.endFrame - (tailSourceFrames(budget, fps) - 1));
};

/**
 * The fewest source frames that still resample to at least `budget` frames.
 *
 * `floor(t * 24/fps + 0.5) >= budget` is, for an integer budget, exactly
 * `t >= (budget - 0.5) * fps / 24` — so the smallest such `t` has a closed
 * form. The two bounded loops absorb the last-ulp disagreements between that
 * expression and `resampledFrameCount`'s association of the same arithmetic;
 * each runs at most a step or two. (An earlier version walked down from
 * `ceil(budget * fps / 24)` instead, which is `~fps / 24` iterations — 124 ms
 * per Frames keystroke at an absurd-but-probeable rate.)
 *
 * Landing short is what matters: the resample is a step function, and every
 * frame past the budget is discarded from the END — the seam. The minimum
 * lands on the budget exactly wherever the source's frame boundaries allow,
 * and within a frame where they cannot (12 fps cannot hit an odd 141 at all).
 */
const tailSourceFrames = (budget: number, fps: number): number => {
  let tail = Math.max(MIN_VIDEO_TRIM_FRAMES, Math.ceil(((budget - 0.5) * fps) / MINIMAX_H3_FPS));

  while (resampledFrameCount(tail, fps) < budget) {
    tail += 1;
  }
  while (tail > MIN_VIDEO_TRIM_FRAMES && resampledFrameCount(tail - 1, fps) >= budget) {
    tail -= 1;
  }

  return tail;
};

/**
 * Re-derives the linked tail reference's window for a generated frame count.
 *
 * The window is a function of that count, so a frame-count change has to move
 * it. This RE-DERIVES rather than shrinks-to-fit: a shrink-only rule ratchets.
 * The Frames number input emits a value per keystroke, unclamped, so typing
 * "345" passes through 3 — and a shrink-only window would collapse to 3 frames
 * and never come back, silently, for the rest of the session. Dragging the
 * slider down and back up does the same. Re-deriving is idempotent in
 * `numFrames`, so the values a keystroke or a drag passes through leave no
 * trace.
 *
 * The cost is that a hand-tuned linked trim resets on a frame-count change as
 * well as on a cutpoint change — the same bargain the section's help text
 * already describes, and the backend leaves no alternative: a window that does
 * not fit the budget loses its seam end.
 */
export const applyReferenceExtendNumFrames = (
  references: VideoReferenceItem[],
  numFrames: number
): VideoReferenceItem[] => {
  let changed = false;
  const next = references.map((entry) => {
    if (entry.kind !== 'video' || entry.fromSourceVideo !== true) {
      return entry;
    }
    const startFrame = referenceExtendStartFrame(entry.clip, numFrames);

    if (startFrame === entry.clip.startFrame) {
      return entry;
    }
    changed = true;

    return { ...entry, clip: { ...entry.clip, startFrame } };
  });

  return changed ? next : references;
};

/**
 * Moves the linked tail reference to the end of the list.
 *
 * Request order is rotary order: `build_ref2va_packed_sequence` lays the
 * reference blocks out in order, each advancing a shared clock, and the
 * generated rows start at the position the LAST block left behind. The
 * continuity anchor only anchors anything if it IS that block — an image
 * dropped afterwards wedges itself (a whole rotary slot) between the initial
 * video's tail and the first generated frame, and the model continues from the
 * image instead.
 *
 * Add order and drag order must not decide that, so the anchor's position is
 * derived like its trim: last, always. Identity-preserving when it is already
 * last, or when there is no anchor.
 */
export const pinReferenceExtendAnchor = (references: VideoReferenceItem[]): VideoReferenceItem[] => {
  const index = references.findIndex((entry) => entry.kind === 'video' && entry.fromSourceVideo === true);

  if (index < 0 || index === references.length - 1) {
    return references;
  }
  const pinned = references[index]!;

  return [...references.slice(0, index), ...references.slice(index + 1), pinned];
};

/**
 * Whether setting `videoName` as the Initial Video could place its anchor.
 *
 * Mirrors `applyReferenceExtendSourceVideo`'s refusal condition so the UI gate
 * cannot drift from what the setter actually does. An adoptable entry consumes
 * no slot: the flagged anchor is rewritten in place, and so is an unflagged
 * reference already naming the same clip -- which is exactly the shape recall
 * restores, since `fromSourceVideo` is panel state and never reaches metadata.
 *
 * `videoName` is the clip currently set; for a clip not yet dropped its name is
 * unknowable, so the answer is the conservative one -- whether a NEW anchor
 * would fit.
 */
export const canPlaceReferenceExtendAnchor = (
  references: VideoReferenceItem[],
  videoName: string | undefined,
  maxVideos: number
): boolean => {
  const videos = references.filter(
    (entry): entry is Extract<VideoReferenceItem, { kind: 'video' }> => entry.kind === 'video'
  );

  return (
    videos.some(
      (entry) => entry.fromSourceVideo === true || (videoName !== undefined && entry.clip.video_name === videoName)
    ) || videos.length < maxVideos
  );
};

/**
 * Keeps the reference list in step with the Initial Video on a reference-extend
 * panel (pure; the setter and the model-selection transition both use it):
 *
 * - clearing the Initial Video removes its linked reference;
 * - setting or re-trimming it re-derives the linked reference's default trim
 *   (the tail window ending on the cutpoint) — a manually tuned trim
 *   therefore holds only until the next cutpoint change, which the section's
 *   help text says;
 * - with no linked entry yet, an existing video reference for the same clip
 *   is adopted (recall restores the pair without the linkage flag; adopting
 *   avoids a duplicate), else a new one is APPENDED — unless the video cap is
 *   already full, in which case the list is returned unchanged and the
 *   extension simply runs without a tail reference.
 *
 * Appended, not prepended, because request order IS rotary order:
 * `build_ref2va_packed_sequence` lays the reference blocks out in order, each
 * advancing a shared clock, and the generated rows then start at the position
 * the LAST block left behind. The reference the model continues from is
 * therefore the final one, so the continuity anchor belongs at the end. (The
 * entry stays reorderable and keeps its place on a re-derive; only the
 * default position is fixed here.)
 */
export const applyReferenceExtendSourceVideo = (
  references: VideoReferenceItem[],
  sourceVideo: VideoSourceClip | null,
  maxVideos: number,
  numFrames: number
): VideoReferenceItem[] => {
  if (!sourceVideo) {
    const kept = references.filter((entry) => !(entry.kind === 'video' && entry.fromSourceVideo === true));

    return kept.length === references.length ? references : kept;
  }

  const linked: VideoReferenceItem = {
    clip: deriveReferenceExtendClip(sourceVideo, numFrames),
    conditioning: 'video_audio',
    fromSourceVideo: true,
    kind: 'video',
  };
  // The flagged entry is THE linked reference; adopt-by-name only when none
  // exists (a recall-restored pair carries no flag). A flag-or-name findIndex
  // would rewrite a user's own same-clip reference — hand trim and all —
  // whenever it sat above the flagged one.
  const flaggedIndex = references.findIndex((entry) => entry.kind === 'video' && entry.fromSourceVideo === true);
  const linkedIndex =
    flaggedIndex >= 0
      ? flaggedIndex
      : references.findIndex((entry) => entry.kind === 'video' && entry.clip.video_name === sourceVideo.video_name);

  if (linkedIndex >= 0) {
    return pinReferenceExtendAnchor(
      references.map((entry, index) =>
        index === linkedIndex && entry.kind === 'video' ? { ...linked, conditioning: entry.conditioning } : entry
      )
    );
  }

  const videoCount = references.filter((entry) => entry.kind === 'video').length;

  return videoCount >= maxVideos ? references : [...references, linked];
};

/**
 * Clears conditioning media that no longer exists in the gallery. Returns the
 * input object untouched when nothing changes.
 *
 * Deliberately operates on RAW widget values rather than a normalized
 * snapshot: normalization resolves the first-frame/initial-video exclusion by
 * masking one slot, and a masked reference would silently survive the
 * deletion sweep — a dangling media name waiting to resurface.
 */
export const clearDeletedVideoMedia = <T extends object>(
  values: T,
  removedImageNames: ReadonlySet<string>,
  removedVideoNames: ReadonlySet<string>
): T => {
  const slots = values as {
    firstFrameImage?: unknown;
    lastFrameImage?: unknown;
    sourceVideo?: unknown;
    references?: unknown;
  };
  const clearFirst = isImageWithDims(slots.firstFrameImage) && removedImageNames.has(slots.firstFrameImage.image_name);
  const clearLast = isImageWithDims(slots.lastFrameImage) && removedImageNames.has(slots.lastFrameImage.image_name);
  const clearSource = isVideoSourceClip(slots.sourceVideo) && removedVideoNames.has(slots.sourceVideo.video_name);
  const references = Array.isArray(slots.references) ? slots.references : null;
  const keptReferences = references?.filter(
    (entry) =>
      !isVideoReferenceItem(entry) ||
      (entry.kind === 'video'
        ? !removedVideoNames.has(entry.clip.video_name)
        : !removedImageNames.has(entry.image.image_name))
  );
  const clearReferences = keptReferences !== undefined && keptReferences.length !== references?.length;

  if (!clearFirst && !clearLast && !clearSource && !clearReferences) {
    return values;
  }

  // The spread widens the cleared keys to `null`; T itself declares them
  // nullable in every real shape (VideoSettings, raw widget values).
  return {
    ...values,
    ...(clearFirst ? { firstFrameImage: null } : {}),
    ...(clearLast ? { lastFrameImage: null } : {}),
    ...(clearSource ? { sourceVideo: null } : {}),
    ...(clearReferences ? { references: keptReferences } : {}),
  } as T;
};
