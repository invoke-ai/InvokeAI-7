import type {
  GenerateLora,
  GenerationModelCatalogItem as ModelConfig,
  GenerationModelTaxonomyType as ModelTaxonomyType,
  LoraModelConfig,
  MainModelConfig,
} from '@features/generation/contracts';

import {
  getCompatibleDiffusersComponentSource,
  isDiffusersMainForBase,
  isLoraCompatibleWithModel,
  isLoraModelConfig,
  isVaeForBases,
  isWanLoraTargetingMain,
  SEED_MAX,
} from '@features/generation/settings';

import type { VideoAspectRatioId, VideoGenerationMode, VideoSettings, VideoTargetResolution } from './types';

import {
  getVideoAspectRatioParts,
  MINIMAX_H3_FPS,
  MINIMAX_H3_NUM_FRAMES_CHOICES,
  MINIMAX_H3_NUM_FRAMES_DEFAULT,
  resolveMiniMaxH3Canvas,
  scaleAndSnapWanDimensions,
  snapMiniMaxH3NumFrames,
  snapWanNumFrames,
  WAN_A14B_PIXEL_MULTIPLE,
  WAN_FPS_DEFAULT,
  WAN_FPS_MAX,
  WAN_FPS_MIN,
  WAN_NUM_FRAMES_DEFAULT,
  WAN_NUM_FRAMES_MAX,
  WAN_NUM_FRAMES_MIN,
  WAN_NUM_FRAMES_STEP,
  WAN_TI2V_PIXEL_MULTIPLE,
  type VideoDimensions,
} from './dimensions';
import {
  applyReferenceExtendSourceVideo,
  applyReferenceExtendNumFrames,
  MIN_VIDEO_TRIM_FRAMES,
  resolveVideoMode,
  VIDEO_ASPECT_RATIO_IDS,
} from './settings';

// Video capabilities registry keyed by model base AND variant: unlike still-image
// generation, Wan's variants differ structurally (which conditioning modes exist,
// the pixel grid, whether a second expert/CFG applies), so base alone is not
// enough. Display identity stays in @features/models; graph topology will stay
// explicit in graph.ts.

export type SupportedVideoBase = 'wan' | 'minimax-h3';

export type VideoNegativePromptUsage = 'always' | 'cfg-gated' | 'never';

export interface VideoTargetResolutionOption {
  id: VideoTargetResolution;
  label: string;
}

export interface VideoFramesGridPolicy {
  kind: 'grid';
  min: number;
  max: number;
  /** Valid counts are `min + k * step` (Wan: 4k + 1, from the VAE's temporal compression). */
  step: number;
  defaultValue: number;
}

export interface VideoFramesChoicesPolicy {
  kind: 'choices';
  choices: readonly number[];
  defaultValue: number;
}

export type VideoFramesPolicy = VideoFramesGridPolicy | VideoFramesChoicesPolicy;

export interface VideoFpsPolicy {
  editable: boolean;
  defaultValue: number;
  min: number;
  max: number;
}

/**
 * The family's distillation fast path: which LoRA(s) it runs on and the
 * sampling parameters they were trained for. Wan A14B uses the Lightning
 * high/low pair; MiniMax H3 uses a single Turbo LoRA.
 *
 * `steps` is the count the family's reference LoRA was distilled for (the
 * bundled H3 templates assume the 6-step repack). Releases trained for a
 * different schedule are resolved per-LoRA by `getAcceleratorSteps`.
 */
export interface VideoAcceleratorConfig {
  label: 'Lightning' | 'Turbo';
  steps: number;
  /**
   * Step counts for releases whose names carry no "N-step" token. First match
   * wins; consulted only when the name does not state the count itself.
   */
  stepOverrides?: readonly { pattern: RegExp; steps: number }[];
  cfgScale: number;
  cfgScaleLowNoise: number | null;
}

interface VideoVariantConfig {
  modes: readonly VideoGenerationMode[];
  pixelMultiple: number;
  targetResolutions: readonly VideoTargetResolutionOption[];
  defaults: {
    targetResolution: VideoTargetResolution;
    steps: number;
    cfgScale: number;
    cfgScaleLowNoise: number | null;
  };
  minSteps: number;
  frames: VideoFramesPolicy;
  fps: VideoFpsPolicy;
  cfg: { visible: boolean; lowNoiseVisible: boolean };
  negativePrompt: { visible: boolean; usage: VideoNegativePromptUsage };
  accelerator: VideoAcceleratorConfig | null;
  audioOutput: boolean;
  /** Ref2VA reference caps; present only on variants whose modes include 'reference'. */
  references?: { maxVideos: number; maxImages: number; extend?: boolean };
}

export const WAN_LIGHTNING_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: 1,
  label: 'Lightning',
  steps: 4,
};

// LightX2V's H3 release is distilled to 8 steps where the repack the templates
// assume is 6, and only its *file* name says so — the starter installs it as
// "MiniMax H3 LightX2V Turbo LoRA", so the org name is the signal that survives.
const LIGHTX2V_PATTERN = /(?:^|[^a-z0-9])lightx2v(?:[^a-z0-9]|$)/i;

export const MINIMAX_H3_TURBO_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: null,
  label: 'Turbo',
  steps: 6,
  stepOverrides: [{ pattern: LIGHTX2V_PATTERN, steps: 8 }],
};

/** The Ref2VA-trained 4-step Turbo distillation (Comfy-Org's ref2v turbo repack). */
export const MINIMAX_H3_REF2V_TURBO_ACCELERATOR: VideoAcceleratorConfig = {
  cfgScale: 1,
  cfgScaleLowNoise: null,
  label: 'Turbo',
  steps: 4,
};

const WAN_TARGET_RESOLUTION_OPTIONS: readonly VideoTargetResolutionOption[] = [
  { id: '480p', label: '480p (Wan native)' },
  { id: '720p', label: '720p (Wan native)' },
  { id: '1080p', label: '1080p (extrapolated)' },
];

const MINIMAX_H3_TARGET_RESOLUTION_OPTIONS: readonly VideoTargetResolutionOption[] = [
  { id: '768 highres', label: '768 highres (H3 native)' },
  { id: '768 lowres', label: '768 lowres (fast preview)' },
];

const WAN_FRAMES: VideoFramesGridPolicy = {
  defaultValue: WAN_NUM_FRAMES_DEFAULT,
  kind: 'grid',
  max: WAN_NUM_FRAMES_MAX,
  min: WAN_NUM_FRAMES_MIN,
  step: WAN_NUM_FRAMES_STEP,
};

const WAN_FPS: VideoFpsPolicy = { defaultValue: WAN_FPS_DEFAULT, editable: true, max: WAN_FPS_MAX, min: WAN_FPS_MIN };

// wan_video_denoise defaults: guidance_scale=5.0 (high), guidance_scale_low_noise=4.0.
const WAN_A14B_COMMON = {
  accelerator: WAN_LIGHTNING_ACCELERATOR,
  cfg: { lowNoiseVisible: true, visible: true },
  defaults: { cfgScale: 5, cfgScaleLowNoise: 4, steps: 40, targetResolution: '720p' as const },
  fps: WAN_FPS,
  frames: WAN_FRAMES,
  minSteps: 1,
  audioOutput: false,
  negativePrompt: { usage: 'cfg-gated' as const, visible: true },
  pixelMultiple: WAN_A14B_PIXEL_MULTIPLE,
  targetResolutions: WAN_TARGET_RESOLUTION_OPTIONS,
};

const WAN_VARIANTS: Record<string, VideoVariantConfig> = {
  // The T2V expert pair has no reference-image conditioning channels.
  t2v_a14b: { ...WAN_A14B_COMMON, modes: ['txt2vid'] },
  // The I2V expert pair conditions on a reference frame (and optionally an end
  // frame — FLF2V); it has no text-only mode. Extend is FLF2V machinery fed by
  // the source video's last frame.
  i2v_a14b: { ...WAN_A14B_COMMON, modes: ['first-frame', 'first-last', 'extend'] },
  // TI2V-5B does both text and image conditioning, but its ref encoder has no
  // end-frame channel, and it is a single expert (no low-noise pair, no
  // Lightning LoRAs).
  ti2v_5b: {
    ...WAN_A14B_COMMON,
    accelerator: null,
    cfg: { lowNoiseVisible: false, visible: true },
    defaults: { cfgScale: 5, cfgScaleLowNoise: null, steps: 40, targetResolution: '720p' },
    modes: ['txt2vid', 'first-frame', 'extend'],
    pixelMultiple: WAN_TI2V_PIXEL_MULTIPLE,
  },
};

// An unknown Wan variant (new backend release) gets the most permissive A14B
// capabilities rather than being blocked: the backend probe is the authority.
const WAN_FALLBACK_VARIANT: VideoVariantConfig = {
  ...WAN_A14B_COMMON,
  modes: ['txt2vid', 'first-frame', 'first-last', 'extend'],
};

// Guidance-distilled: no CFG, no negative prompt, fixed 24 fps, audio included.
const MINIMAX_H3_FL2VA: VideoVariantConfig = {
  accelerator: MINIMAX_H3_TURBO_ACCELERATOR,
  audioOutput: true,
  cfg: { lowNoiseVisible: false, visible: false },
  defaults: { cfgScale: 1, cfgScaleLowNoise: null, steps: 50, targetResolution: '768 highres' },
  fps: { defaultValue: MINIMAX_H3_FPS, editable: false, max: MINIMAX_H3_FPS, min: MINIMAX_H3_FPS },
  frames: { choices: MINIMAX_H3_NUM_FRAMES_CHOICES, defaultValue: MINIMAX_H3_NUM_FRAMES_DEFAULT, kind: 'choices' },
  minSteps: 2,
  modes: ['txt2vid', 'first-frame', 'last-frame', 'first-last', 'extend'],
  negativePrompt: { usage: 'never', visible: false },
  pixelMultiple: 32,
  targetResolutions: MINIMAX_H3_TARGET_RESOLUTION_OPTIONS,
};

// The Ref2VA task transformer supports ONLY reference-conditioned generation (upstream
// declares tasks: ["ref2va"]); everything else it inherits from the FL2VA panel policy.
const MINIMAX_H3_REF2VA: VideoVariantConfig = {
  ...MINIMAX_H3_FL2VA,
  accelerator: MINIMAX_H3_REF2V_TURBO_ACCELERATOR,
  modes: ['reference'],
  // `extend` = reference-extend: an Initial Video the new clip is appended to,
  // with a linked tail reference for continuity (no frame conditioning — the
  // panel derives a reference from the clip instead).
  references: { extend: true, maxImages: 9, maxVideos: 3 },
};

export const VIDEO_GENERATION: Record<
  SupportedVideoBase,
  { variants: Record<string, VideoVariantConfig>; fallback: VideoVariantConfig }
> = {
  // ref2va is REGISTERED, never the fallback: an unknown future variant may fall back to
  // fl2va's config, but a known ref2va transformer must not silently get fl2va's modes.
  'minimax-h3': { fallback: MINIMAX_H3_FL2VA, variants: { fl2va: MINIMAX_H3_FL2VA, ref2va: MINIMAX_H3_REF2VA } },
  wan: { fallback: WAN_FALLBACK_VARIANT, variants: WAN_VARIANTS },
};

export const SUPPORTED_VIDEO_BASES = Object.keys(VIDEO_GENERATION) as SupportedVideoBase[];

/**
 * A model the video panel can reason about at all: any Wan main, and MiniMax
 * H3 mains in both shapes — the Diffusers folder install and the single-file
 * transformer checkpoint. For H3 the checkpoint IS the model identity (its
 * task variant decides the panel's mode); the Diffusers install supplies the
 * five other submodels, either as the model itself (full install) or through
 * the component-source slot (checkpoint main).
 */
export const isSupportedVideoModel = <T extends { base: string; type: string; format?: string }>(
  model: T
): model is T & MainModelConfig =>
  model.type === 'main' &&
  (model.base === 'wan' ||
    (model.base === 'minimax-h3' && (model.format === 'diffusers' || model.format === 'checkpoint')));

/**
 * What the top model selector offers — like the image Generate panel, the top
 * pick is what decides the panel's UI, so it lists the identity-bearing models:
 * H3 single-file transformers (either task variant) and full Diffusers
 * installs. Excluded, though still "supported" for stored/recalled state:
 * a components-only folder (no transformer weights — it belongs in the Model
 * Components slot) and a Ref2VA Diffusers folder (its `transformer_ref`
 * weights are not folder-loadable; the single-file checkpoint is the runnable
 * form, with the folder serving as the component source).
 */
export const isVideoModelSelectable = <T extends ModelConfig>(model: T): boolean =>
  isSupportedVideoModel(model) &&
  !isComponentsOnlyH3Main(model) &&
  !(model.base === 'minimax-h3' && model.format === 'diffusers' && model.variant === 'ref2va');

/**
 * A slim MiniMax H3 folder install: tokenizer/processor/VAEs only, no
 * transformer or text-encoder weights. The backend probe records
 * `components_only` on the config precisely so the UI can require the
 * single-file overrides up front instead of failing mid-generation.
 */
export const isComponentsOnlyH3Main = (model: MainModelConfig): boolean =>
  // Demand the full config, not a Pick: a narrowed object would type-check
  // here but silently read `components_only` as absent — a false negative
  // that re-opens the fail-mid-generation hole this helper exists to close.
  model.base === 'minimax-h3' && model.format === 'diffusers' && model.components_only === true;

const getVideoVariantConfig = (
  model: Pick<MainModelConfig, 'base' | 'type' | 'variant' | 'format'> | undefined
): VideoVariantConfig | null => {
  if (!model || !isSupportedVideoModel(model)) {
    return null;
  }

  const baseEntry = VIDEO_GENERATION[model.base as SupportedVideoBase];
  const variant = typeof model.variant === 'string' ? model.variant : '';

  return baseEntry.variants[variant] ?? baseEntry.fallback;
};

// Fallback keeps UI selectors crash-safe while nothing is selected;
// isSupportedVideoModel() still blocks invocation.
const FALLBACK_VARIANT_CONFIG = WAN_FALLBACK_VARIANT;

const getVideoConfig = (
  model: Pick<MainModelConfig, 'base' | 'type' | 'variant' | 'format'> | undefined
): VideoVariantConfig => getVideoVariantConfig(model) ?? FALLBACK_VARIANT_CONFIG;

export const getVideoModes = (model: MainModelConfig | undefined): readonly VideoGenerationMode[] =>
  getVideoConfig(model).modes;

export const isVideoModeSupported = (model: MainModelConfig | undefined, mode: VideoGenerationMode): boolean =>
  getVideoModes(model).includes(mode);

export const getVideoFramesPolicy = (model: MainModelConfig | undefined): VideoFramesPolicy =>
  getVideoConfig(model).frames;

export const getVideoFpsPolicy = (model: MainModelConfig | undefined): VideoFpsPolicy => getVideoConfig(model).fps;

export const getVideoTargetResolutionOptions = (
  model: MainModelConfig | undefined
): readonly VideoTargetResolutionOption[] => getVideoConfig(model).targetResolutions;

export const getVideoAspectRatioOptions = (_model: MainModelConfig | undefined): readonly VideoAspectRatioId[] =>
  // Both current families accept every offered ratio (H3's 1:4–4:1 bound is
  // wider than the preset list); the hook stays per-model for the next family.
  VIDEO_ASPECT_RATIO_IDS;

const coerceTargetResolution = (
  config: VideoVariantConfig,
  targetResolution: VideoTargetResolution
): VideoTargetResolution =>
  config.targetResolutions.some((option) => option.id === targetResolution)
    ? targetResolution
    : config.defaults.targetResolution;

export const snapVideoNumFrames = (model: MainModelConfig | undefined, numFrames: number): number => {
  const frames = getVideoConfig(model).frames;

  return frames.kind === 'grid' ? snapWanNumFrames(numFrames) : snapMiniMaxH3NumFrames(numFrames);
};

export const isValidVideoNumFrames = (model: MainModelConfig | undefined, numFrames: number): boolean => {
  const frames = getVideoConfig(model).frames;

  if (frames.kind === 'choices') {
    return frames.choices.includes(numFrames);
  }

  return (
    Number.isInteger(numFrames) &&
    numFrames >= frames.min &&
    numFrames <= frames.max &&
    (numFrames - frames.min) % frames.step === 0
  );
};

export type VideoDimensionSource = 'aspect-ratio' | 'first-frame' | 'last-frame' | 'source-video';

export interface ResolvedVideoDimensions extends VideoDimensions {
  source: VideoDimensionSource;
}

/**
 * The exact pixel dimensions a graph will run at. Text-to-video derives them
 * from the aspect-ratio preset; once conditioning media is set, its own ratio
 * takes over (the panel's Dimensions section locks accordingly) and only the
 * target-resolution preset still applies. Null when the media's ratio is
 * outside the model's supported range or the inputs are degenerate — reported
 * via `getVideoValidationReasons`.
 */
export const getVideoDimensions = (
  model: MainModelConfig | undefined,
  settings: Pick<
    VideoSettings,
    'aspectRatioId' | 'targetResolution' | 'firstFrameImage' | 'lastFrameImage' | 'sourceVideo'
  >
): ResolvedVideoDimensions | null => {
  const config = getVideoConfig(model);
  const targetResolution = coerceTargetResolution(config, settings.targetResolution);

  const media = settings.sourceVideo
    ? { ...settings.sourceVideo, source: 'source-video' as const }
    : settings.firstFrameImage
      ? { ...settings.firstFrameImage, source: 'first-frame' as const }
      : settings.lastFrameImage
        ? { ...settings.lastFrameImage, source: 'last-frame' as const }
        : null;

  const inputs = media ?? { ...getVideoAspectRatioParts(settings.aspectRatioId), source: 'aspect-ratio' as const };

  const dimensions =
    model?.base === 'minimax-h3'
      ? resolveMiniMaxH3Canvas(inputs.width, inputs.height, targetResolution as '768 highres' | '768 lowres')
      : scaleAndSnapWanDimensions(
          inputs.width,
          inputs.height,
          targetResolution as '480p' | '720p' | '1080p',
          config.pixelMultiple
        );

  return dimensions ? { ...dimensions, source: inputs.source } : null;
};

export const getVideoPromptPolicy = (
  model: MainModelConfig | undefined,
  settings: Pick<VideoSettings, 'cfgScale' | 'cfgScaleLowNoise' | 'negativePromptEnabled' | 'wanLowNoiseModel'>
) => {
  const config = getVideoConfig(model);
  // Mirrors wan_video_denoise's do_cfg: negative conditioning is also consumed
  // when the LOW-noise half runs CFG (> 1) — which needs a second expert, i.e.
  // a Diffusers dual-expert main or a wired low-noise transformer.
  const lowNoiseCfgActive =
    config.cfg.lowNoiseVisible &&
    (model?.format === 'diffusers' || settings.wanLowNoiseModel !== null) &&
    settings.cfgScaleLowNoise !== null &&
    settings.cfgScaleLowNoise > 1;
  const negativeUsedInGraph =
    settings.negativePromptEnabled &&
    (config.negativePrompt.usage === 'always' ||
      (config.negativePrompt.usage === 'cfg-gated' && (settings.cfgScale > 1 || lowNoiseCfgActive)));

  return {
    negativeVisible: config.negativePrompt.visible,
    negativeUsedInGraph,
    ...(config.negativePrompt.usage === 'cfg-gated'
      ? { negativeHelpText: 'Used only when CFG is greater than 1.' }
      : {}),
  };
};

export interface VideoModelPolicy {
  isSupported: boolean;
  modes: readonly VideoGenerationMode[];
  pixelMultiple: number;
  /** The family's floor for the steps control (validation enforces it too). */
  minSteps: number;
  aspectRatioOptions: readonly VideoAspectRatioId[];
  targetResolutions: readonly VideoTargetResolutionOption[];
  frames: VideoFramesPolicy;
  fps: VideoFpsPolicy;
  defaults: {
    targetResolution: VideoTargetResolution;
    steps: number;
    cfgScale: number;
    cfgScaleLowNoise: number | null;
  };
  prompt: {
    negativeVisible: boolean;
    negativeUsedInGraph: boolean;
    negativeHelpText?: string;
  };
  /** Ref2VA reference caps; null unless the effective variant has a reference mode. */
  references: { maxVideos: number; maxImages: number; extend?: boolean } | null;
  ui: {
    cfgVisible: boolean;
    cfgLowNoiseVisible: boolean;
    fpsVisible: boolean;
    /** The family's distillation fast path, or null when it has none. */
    accelerator: VideoAcceleratorConfig | null;
    /** Steps for the fast path as currently configured, or null when it has none. */
    acceleratorSteps: number | null;
    audioOutput: boolean;
  };
}

export const getVideoModelPolicy = (model: MainModelConfig | undefined, settings: VideoSettings): VideoModelPolicy => {
  // The H3 task (fl2va vs ref2va) lives on the selected model itself: a
  // single-file transformer checkpoint carries its own variant.
  const config = getVideoConfig(model);

  return {
    aspectRatioOptions: getVideoAspectRatioOptions(model),
    defaults: config.defaults,
    fps: config.fps,
    frames: config.frames,
    isSupported: model ? isSupportedVideoModel(model) : false,
    minSteps: config.minSteps,
    modes: config.modes,
    pixelMultiple: config.pixelMultiple,
    prompt: getVideoPromptPolicy(model, settings),
    references: config.references ?? null,
    targetResolutions: config.targetResolutions,
    ui: {
      accelerator: config.accelerator,
      // The step count the help text quotes is the one the *running*
      // accelerator LoRA was distilled for — with the 8-step LightX2V Turbo
      // LoRA on, "6 steps" would be a lie. It is deliberately NOT folded into
      // `accelerator`: that stays the family config, so callers can keep using
      // it as the reference other counts are resolved against.
      acceleratorSteps: config.accelerator
        ? getAcceleratorSteps(config.accelerator, getRecordedAcceleratorLoras(settings))
        : null,
      audioOutput: config.audioOutput,
      cfgLowNoiseVisible: config.cfg.lowNoiseVisible,
      cfgVisible: config.cfg.visible,
      fpsVisible: config.fps.editable,
    },
  };
};

// ---------------------------------------------------------------------------
// Distillation fast paths (Wan Lightning, MiniMax H3 Turbo)

export interface WanLightningLoraPair {
  high: LoraModelConfig;
  low: LoraModelConfig;
}

export interface FindAcceleratorLoraOptions {
  /**
   * Accept only LoRAs that also name the model family. Used when the candidate
   * list is the user's own Concepts list rather than the installed catalog:
   * there is no better-named release for a look-alike to lose to, so a
   * personal "Turbo …" LoRA — or a T2V Lightning pair sitting on an I2V main —
   * would otherwise be mistaken for a distillation fast path.
   */
  requireFamilyName?: boolean;
}

/** MiniMax H3 only: the task variant decides which Turbo distillation qualifies. */
export interface FindMiniMaxH3TurboLoraOptions extends FindAcceleratorLoraOptions {
  /** The effective model's variant; ref2va REQUIRES the ref2v-token repack, every other variant excludes it. */
  variant?: string | null;
}

// "high"/"low" as standalone words. \b is useless here because release files
// use underscores ("high_noise_model") where \w breaks no boundary, while a
// plain word-suffix match swallows "Slow"/"Thigh" — so the token must be
// delimited by non-alphanumerics (or the string edge) on BOTH sides.
const HIGH_NOISE_PATTERN = /(?:^|[^a-z0-9])high(?:[^a-z0-9]|$)/i;
const LOW_NOISE_PATTERN = /(?:^|[^a-z0-9])low(?:[^a-z0-9]|$)/i;

/**
 * The installed Lightning LoRA pair for a Wan A14B main, if any. When pairs for
 * more than one family are installed (e.g. T2V and I2V releases), the one
 * naming the main's family wins; noise assignment comes from the model names.
 *
 * `requireFamilyName` drops the fallback and demands the family token, so a
 * T2V pair is not read as a valid accelerator for an I2V main — the question
 * asked when the candidates are LoRAs already in the panel rather than the
 * catalog the toggle is free to pick from. With no family token to demand it
 * matches nothing, leaving the answer to the catalog.
 */
export const findWanLightningLoraPair = (
  models: readonly ModelConfig[],
  mainVariant: string | null | undefined,
  { requireFamilyName = false }: FindAcceleratorLoraOptions = {}
): WanLightningLoraPair | null => {
  const candidates = models.filter(
    (model): model is ModelConfig & LoraModelConfig =>
      isLoraModelConfig(model) &&
      model.base === 'wan' &&
      /lightning/i.test(model.name) &&
      isWanLoraTargetingMain(model.variant, mainVariant)
  );

  // Delimited-token match so 'i2v' cannot score inside "TI2V".
  const familyToken = typeof mainVariant === 'string' ? mainVariant.split('_')[0] : undefined;
  const familyPattern = familyToken ? new RegExp(`(?:^|[^a-z0-9])${familyToken}(?:[^a-z0-9]|$)`, 'i') : null;
  const score = (model: LoraModelConfig): number => (familyPattern?.test(model.name) ? 0 : 1);
  // With `requireFamilyName` and no family token to check against (an unprobed
  // Wan release on the fallback variant) there is nothing to verify, so this
  // fails closed rather than accepting everything — the caller falls back to
  // the catalog pick, which is a real answer.
  const pick = (pattern: RegExp): LoraModelConfig | null =>
    candidates
      .filter((model) => pattern.test(model.name) && (!requireFamilyName || score(model) === 0))
      .sort((a, b) => score(a) - score(b))[0] ?? null;

  const high = pick(HIGH_NOISE_PATTERN);
  const low = pick(LOW_NOISE_PATTERN);

  return high && low && high.key !== low.key ? { high, low } : null;
};

const TURBO_PATTERN = /(?:^|[^a-z0-9])turbo(?:[^a-z0-9]|$)/i;
const MINIMAX_H3_NAME_PATTERN = /(?:^|[^a-z0-9])(?:minimax|h3)(?:[^a-z0-9]|$)/i;
// Ref2VA-trained distillation LoRAs (delimited "ref2v"/"ref2va" token). They must never
// auto-apply to an FL2VA generation - the Ref2V Turbo repack is trained against the Ref2VA
// transformer only.
const MINIMAX_H3_REF2V_PATTERN = /(?:^|[^a-z0-9])ref2va?(?:[^a-z0-9]|$)/i;

/**
 * The installed MiniMax H3 Turbo distillation LoRA, if any. Distillation LoRAs
 * carry no dedicated taxonomy, so this is a name heuristic: a delimited
 * "turbo" token, preferring names that also name the model family, with a
 * deterministic tie-break — a user's own "Turbo …" style LoRA loses to the
 * real repack whenever one is installed. Ref2VA-trained turbo LoRAs are
 * excluded: the FL2VA accelerator must not pick them.
 */
export const findMiniMaxH3TurboLora = (
  models: readonly ModelConfig[],
  { requireFamilyName = false, variant = 'fl2va' }: FindMiniMaxH3TurboLoraOptions = {}
): LoraModelConfig | null => {
  const score = (model: LoraModelConfig): number => (MINIMAX_H3_NAME_PATTERN.test(model.name) ? 0 : 1);
  // The task decides which distillation qualifies: ref2va REQUIRES the ref2v-token repack,
  // every other variant excludes it — the two are trained against different transformers.
  const matchesTask = (name: string): boolean =>
    variant === 'ref2va' ? MINIMAX_H3_REF2V_PATTERN.test(name) : !MINIMAX_H3_REF2V_PATTERN.test(name);

  return (
    models
      .filter(
        (model): model is ModelConfig & LoraModelConfig =>
          isLoraModelConfig(model) &&
          model.base === 'minimax-h3' &&
          TURBO_PATTERN.test(model.name) &&
          matchesTask(model.name) &&
          (!requireFamilyName || MINIMAX_H3_NAME_PATTERN.test(model.name))
      )
      .sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))[0] ?? null
  );
};

/**
 * The complete accelerator LoRA set contained in `candidates`, or null when it
 * is not all there. The candidates are the installed catalog when asking what
 * the toggle *would* run, and the user's own Concepts list when asking what is
 * actually running. `model` must be the EFFECTIVE model: for MiniMax H3 the
 * task variant (fl2va vs ref2va) decides which Turbo distillation qualifies.
 */
export const findAcceleratorLorasIn = (
  model: MainModelConfig,
  candidates: readonly ModelConfig[],
  options: FindAcceleratorLoraOptions = {}
): LoraModelConfig[] | null => {
  if (model.base === 'minimax-h3') {
    const turbo = findMiniMaxH3TurboLora(candidates, {
      ...options,
      variant: typeof model.variant === 'string' ? model.variant : 'fl2va',
    });

    return turbo ? [turbo] : null;
  }

  const pair = findWanLightningLoraPair(candidates, model.variant, options);

  return pair ? [pair.high, pair.low] : null;
};

// "4-step", "8 steps", "6step" — how a distillation release states the schedule
// it was trained for. Two digits at most, so a checkpoint tag ("step600") or a
// rank cannot be read as a step count.
const STEP_COUNT_PATTERN = /(?:^|[^a-z0-9])(\d{1,2})[ _-]?steps?(?:[^a-z0-9]|$)/i;

/**
 * The step count one distillation LoRA was trained for. Its name is the only
 * record of it: an explicit "N-step" token wins, then the family's per-release
 * overrides, and failing both the family's reference count.
 */
const getLoraAcceleratorSteps = (config: VideoAcceleratorConfig, lora: LoraModelConfig): number => {
  const stated = Number(STEP_COUNT_PATTERN.exec(lora.name)?.[1] ?? 0);

  if (stated > 0) {
    return stated;
  }

  return config.stepOverrides?.find((override) => override.pattern.test(lora.name))?.steps ?? config.steps;
};

/**
 * The step count for a whole accelerator set. Both halves of a Wan Lightning
 * pair state the same schedule; if a mismatched pair is ever assembled, the
 * higher count is the safe pick — under-stepping is what reads as a broken
 * model.
 */
export const getAcceleratorSteps = (config: VideoAcceleratorConfig, loras: readonly LoraModelConfig[]): number =>
  loras.reduce((steps, lora) => Math.max(steps, getLoraAcceleratorSteps(config, lora)), 0) || config.steps;

/** The LoRA models the user currently has switched on in the Concepts list. */
const getEnabledLoraModels = (settings: Pick<VideoSettings, 'loras'>): LoraModelConfig[] =>
  settings.loras.filter((lora) => lora.isEnabled).map((lora) => lora.model);

/** The LoRA models the accelerator toggle recorded, as they stand in the list. */
const getRecordedAcceleratorLoras = (
  settings: Pick<VideoSettings, 'acceleratorEnabled' | 'acceleratorLoraKeys' | 'loras'>
): LoraModelConfig[] => {
  const recorded = new Set(settings.acceleratorLoraKeys);

  return settings.acceleratorEnabled
    ? settings.loras.filter((lora) => recorded.has(lora.model.key)).map((lora) => lora.model)
    : [];
};

/**
 * The complete accelerator set contained in `candidates`, judged the way the
 * panel has to judge LoRAs the user is holding: one that names the model's own
 * family, or failing that the very set the catalog would install. The
 * family-name requirement keeps a personal "Turbo …" LoRA — or a T2V Lightning
 * pair left over on an I2V main — from passing as a fast path; the catalog
 * pick is exempt from it because it is what the toggle itself installs, odd
 * name and all.
 */
const findAcceleratorAmong = (
  model: MainModelConfig,
  candidates: readonly LoraModelConfig[],
  models: readonly ModelConfig[]
): LoraModelConfig[] | null => {
  const named = findAcceleratorLorasIn(model, candidates, { requireFamilyName: true });

  if (named) {
    return named;
  }

  const catalogPick = findAcceleratorLorasIn(model, models);

  return catalogPick?.every((lora) => candidates.some((candidate) => candidate.key === lora.key)) ? catalogPick : null;
};

/**
 * Whether the settings' recorded accelerator keys still name a complete set of
 * enabled LoRAs that is a valid fast path *for this model* — the question both
 * the model-switch reconcile and the Concepts-list reconcile turn on. Asked of
 * the recorded keys alone, so with two Turbo LoRAs enabled the one the user
 * anchored on keeps the fast path instead of losing it to a tie-break.
 */
const isRecordedAcceleratorIntact = (
  settings: Pick<VideoSettings, 'acceleratorLoraKeys' | 'loras'>,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  config: VideoVariantConfig
): boolean => {
  const recorded = new Set(settings.acceleratorLoraKeys);

  if (!config.accelerator || recorded.size === 0) {
    return false;
  }

  // Deduplicated by key: a list holding the same LoRA twice (a hand-edited
  // project file, metadata whose graph listed one twice) must not make this
  // permanently false — the identity guarantee in `syncVideoWidgetValuesWithModels`
  // depends on an unchanged value reaching the 'unchanged' outcome.
  const live = [
    ...new Map(
      getEnabledLoraModels(settings)
        .filter((lora) => recorded.has(lora.key))
        .map((lora) => [lora.key, lora])
    ).values(),
  ];

  return live.length === recorded.size && findAcceleratorAmong(model, live, models)?.length === recorded.size;
};

/**
 * The accelerator LoRA entries for a model, or null when they are not
 * installed. Deliberately catalog-only: the family name test is all that
 * separates a distillation LoRA from any other, and "MiniMax H3 …" is how a
 * user names their OWN H3 LoRA too, so letting the panel's list steer this
 * would let the toggle arm itself on a LoRA with no distillation in it.
 */
const findAcceleratorLoraEntries = (model: MainModelConfig, models: readonly ModelConfig[]): GenerateLora[] | null =>
  findAcceleratorLorasIn(model, models)?.map((lora) => ({ isEnabled: true, model: lora, weight: 1 })) ?? null;

export interface AcceleratorToggleResult {
  settings: VideoSettings;
  /** True when enabling was requested but the accelerator LoRA(s) are not installed. */
  missingLoras: boolean;
}

/**
 * Applies the accelerator toggle as a plain settings transition: the LoRA(s)
 * appear in (or leave) the Concepts list and steps/CFG are patched, so the
 * graph builder needs no hidden behavior and the user sees exactly what runs.
 */
export const getAcceleratorToggleResult = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  enabled: boolean
): AcceleratorToggleResult => {
  const config = getVideoConfig(model);
  // Remove exactly the entries a previous toggle added — never a user's own
  // LoRA that happens to share a Lightning/Turbo-style name.
  const previousKeys = new Set(settings.acceleratorLoraKeys);
  const withoutAccelerators = settings.loras.filter((lora) => !previousKeys.has(lora.model.key));

  if (!enabled || !config.accelerator) {
    return {
      missingLoras: false,
      settings: {
        ...settings,
        acceleratorEnabled: false,
        acceleratorLoraKeys: [],
        cfgScale: config.defaults.cfgScale,
        cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
        loras: withoutAccelerators,
        steps: config.defaults.steps,
      },
    };
  }

  const entries = findAcceleratorLoraEntries(model, models);

  if (!entries) {
    // Never leave the flag claiming a fast path that has no LoRAs behind it.
    return {
      missingLoras: true,
      settings: settings.acceleratorEnabled
        ? { ...settings, acceleratorEnabled: false, acceleratorLoraKeys: [] }
        : settings,
    };
  }

  return {
    missingLoras: false,
    settings: {
      ...settings,
      acceleratorEnabled: true,
      acceleratorLoraKeys: entries.map((entry) => entry.model.key),
      cfgScale: config.accelerator.cfgScale,
      cfgScaleLowNoise: config.accelerator.cfgScaleLowNoise,
      loras: [
        ...withoutAccelerators.filter((lora) => !entries.some((e) => e.model.key === lora.model.key)),
        ...entries,
      ],
      steps: getAcceleratorSteps(
        config.accelerator,
        entries.map((entry) => entry.model)
      ),
    },
  };
};

export type AcceleratorLoraChangeOutcome = 'unchanged' | 'switched' | 'disabled';

export interface AcceleratorLoraChangeResult {
  settings: VideoSettings;
  outcome: AcceleratorLoraChangeOutcome;
  /** The LoRA set now driving the fast path — only set when `outcome` is 'switched'. */
  acceleratorLoras: LoraModelConfig[] | null;
}

/**
 * Re-reads the fast path from the Concepts list after it changes. The flag has
 * to describe what is actually enabled, so swapping one Turbo LoRA for another
 * keeps the fast path — re-anchored on the new LoRA, at the step count *it*
 * was distilled for — instead of tearing it down. Only a list with no complete
 * accelerator left in it turns the toggle off and restores the model's own
 * sampling defaults: a silent 6-step run with no distillation LoRA behind it
 * just reads as a broken model.
 *
 * Strictly a repair of a fast path that is already ON. An off accelerator is
 * never armed by a list edit, however accelerator-shaped the LoRA that lands
 * in it looks: the name heuristic cannot tell a distillation release from a
 * user's own "… Turbo …" LoRA, and arming on it would silently drop a
 * hand-tuned step count onto a LoRA that does not support it.
 */
export const getAcceleratorLoraChangeResult = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[],
  loras: GenerateLora[]
): AcceleratorLoraChangeResult => {
  // The two H3 tasks (fl2va vs ref2va) have different accelerators; the task
  // lives on the selected model's own variant.
  const config = getVideoConfig(model);
  const next: VideoSettings = { ...settings, loras };

  // Nothing to repair, and nothing this function is allowed to start.
  if (!settings.acceleratorEnabled) {
    return { acceleratorLoras: null, outcome: 'unchanged', settings: next };
  }

  // The recorded set is still running: leave everything the user tuned alone.
  if (isRecordedAcceleratorIntact(next, model, models, config)) {
    return { acceleratorLoras: null, outcome: 'unchanged', settings: next };
  }

  const replacement = config.accelerator ? findAcceleratorAmong(model, getEnabledLoraModels(next), models) : null;

  if (replacement && config.accelerator) {
    return {
      acceleratorLoras: replacement,
      outcome: 'switched',
      settings: {
        ...next,
        acceleratorEnabled: true,
        acceleratorLoraKeys: replacement.map((lora) => lora.key),
        cfgScale: config.accelerator.cfgScale,
        cfgScaleLowNoise: config.accelerator.cfgScaleLowNoise,
        steps: getAcceleratorSteps(config.accelerator, replacement),
      },
    };
  }

  return {
    acceleratorLoras: null,
    outcome: 'disabled',
    settings: {
      ...next,
      acceleratorEnabled: false,
      acceleratorLoraKeys: [],
      cfgScale: config.defaults.cfgScale,
      cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
      steps: config.defaults.steps,
    },
  };
};

// ---------------------------------------------------------------------------
// Component slots

export type VideoComponentValueKey =
  | 'vae'
  | 'wanT5EncoderModel'
  | 'wanLowNoiseModel'
  | 'componentSourceModel'
  | 'h3TransformerModel'
  | 'h3TextEncoderModel';

export interface VideoComponentPolicyContext {
  model: MainModelConfig;
  settings: VideoSettings;
  selectedComponents: Pick<VideoSettings, VideoComponentValueKey>;
}

export interface VideoComponentSlotPolicy {
  key: VideoComponentValueKey;
  label: string;
  modelTypes: readonly ModelTaxonomyType[];
  valueKind: 'component' | 'vae' | 'main';
  helpText?: string;
  filter?: (candidate: ModelConfig, ctx: VideoComponentPolicyContext) => boolean;
  required?: (ctx: VideoComponentPolicyContext) => boolean;
  missingMessage?: string;
}

export interface VideoComponentSectionPolicy {
  defaultOpen: boolean;
  slots: readonly VideoComponentSlotPolicy[];
  validate: (ctx: VideoComponentPolicyContext) => string[];
}

const VIDEO_COMPONENT_SETTING_LABELS: Record<VideoComponentValueKey, string> = {
  componentSourceModel: 'Component source',
  h3TextEncoderModel: 'Text encoder (single file)',
  h3TransformerModel: 'Transformer (single file)',
  vae: 'VAE',
  wanLowNoiseModel: 'Low-noise expert',
  wanT5EncoderModel: 'Wan T5 Encoder',
};

const isTi2v5b = (variant: unknown): boolean => variant === 'ti2v_5b';

// A Diffusers Wan main bundles its own VAE and encoder; a GGUF/checkpoint main
// needs them from standalone models or a Diffusers component source.
const getWanComponentSource = (ctx: VideoComponentPolicyContext) =>
  getCompatibleDiffusersComponentSource(ctx.model, ctx.settings.componentSourceModel);

// The UMT5-XXL encoder is shared across Wan families, so any Diffusers source
// supplies it.
const isWanEncoderSatisfied = (ctx: VideoComponentPolicyContext): boolean =>
  ctx.model.format === 'diffusers' || Boolean(getWanComponentSource(ctx));

// The VAE is family-bound (wan_model_loader's source-VAE validation): a source
// only covers it when its TI2V-5B-ness matches the main's.
const isWanVaeSatisfied = (ctx: VideoComponentPolicyContext): boolean => {
  if (ctx.model.format === 'diffusers') {
    return true;
  }

  const source = getWanComponentSource(ctx);

  return Boolean(source) && isTi2v5b(source?.variant) === isTi2v5b(ctx.model.variant);
};

const validateSlots = (slots: readonly VideoComponentSlotPolicy[], ctx: VideoComponentPolicyContext): string[] =>
  slots.flatMap((slotPolicy) => {
    if (!slotPolicy.required?.(ctx)) {
      return [];
    }

    const value = ctx.selectedComponents[slotPolicy.key];
    const isValid = value && (!slotPolicy.filter || slotPolicy.filter(value as ModelConfig, ctx));

    return isValid ? [] : [slotPolicy.missingMessage ?? `Video needs a ${slotPolicy.label} for this model.`];
  });

const createComponentPolicy = (
  defaultOpen: boolean,
  slots: readonly VideoComponentSlotPolicy[]
): VideoComponentSectionPolicy => ({
  defaultOpen,
  slots,
  validate: (ctx) => validateSlots(slots, ctx),
});

const EMPTY_VIDEO_COMPONENT_POLICY = createComponentPolicy(false, []);

// wan_model_loader requires the low-noise expert to be a DIFFERENT single-file
// model of the SAME variant as the main. Unknown variants stay allowed — the
// backend probe is the authority.
const isWanLowNoiseExpertCandidate = (candidate: ModelConfig, ctx: VideoComponentPolicyContext): boolean =>
  candidate.type === 'main' &&
  candidate.base === 'wan' &&
  candidate.format !== 'diffusers' &&
  candidate.key !== ctx.model.key &&
  (typeof candidate.variant !== 'string' ||
    typeof ctx.model.variant !== 'string' ||
    candidate.variant === ctx.model.variant);

// wan_model_loader validates the standalone VAE's latent channels against the
// main: TI2V-5B needs the 48-channel Wan 2.2 VAE, A14B the 16-channel Wan 2.1
// VAE. A config without the field (open union) stays allowed.
const isWanVaeForMain = (candidate: ModelConfig, ctx: VideoComponentPolicyContext): boolean => {
  if (!isVaeForBases(['wan'])(candidate)) {
    return false;
  }

  const latentChannels = candidate.latent_channels;

  if (typeof latentChannels !== 'number') {
    return true;
  }

  return latentChannels === (isTi2v5b(ctx.model.variant) ? 48 : 16);
};

export const getVideoComponentSectionPolicy = (
  model: MainModelConfig | undefined,
  _settings: VideoSettings
): VideoComponentSectionPolicy => {
  if (!model || !isSupportedVideoModel(model)) {
    return EMPTY_VIDEO_COMPONENT_POLICY;
  }

  if (model.base === 'wan') {
    const config = getVideoConfig(model);
    const slots: VideoComponentSlotPolicy[] = [
      // A Diffusers main is its own component source; the loader ignores the
      // input for it, so the slot is only offered for single-file mains — and
      // never lists the selected main itself.
      ...(model.format === 'diffusers'
        ? []
        : [
            {
              filter: (candidate: ModelConfig, ctx: VideoComponentPolicyContext) =>
                isDiffusersMainForBase('wan')(candidate) && candidate.key !== ctx.model.key,
              helpText: 'Select a Diffusers Wan model to provide VAE and text-encoder components.',
              key: 'componentSourceModel',
              label: 'Component source',
              modelTypes: ['main'],
              valueKind: 'main',
            } satisfies VideoComponentSlotPolicy,
          ]),
      {
        filter: isWanVaeForMain,
        helpText: 'Required unless a Diffusers component source is available.',
        key: 'vae',
        label: 'VAE',
        missingMessage: 'Video needs a VAE for Wan models.',
        modelTypes: ['vae'],
        required: (ctx) => !isWanVaeSatisfied(ctx),
        valueKind: 'vae',
      },
      {
        filter: (candidate) => candidate.type === 'wan_t5_encoder',
        helpText: 'Required unless a Diffusers component source is available.',
        key: 'wanT5EncoderModel',
        label: 'Wan T5 Encoder',
        missingMessage: 'Video needs a Wan T5 Encoder for Wan models.',
        modelTypes: ['wan_t5_encoder'],
        required: (ctx) => !isWanEncoderSatisfied(ctx),
        valueKind: 'component',
      },
    ];

    // TI2V-5B is a single expert, and a Diffusers A14B main bundles its own
    // transformer_2 (the loader ignores this input for it) — so the slot is
    // only offered for single-file A14B mains.
    if (config.cfg.lowNoiseVisible && model.format !== 'diffusers') {
      slots.push({
        filter: isWanLowNoiseExpertCandidate,
        helpText: 'Optional second A14B expert. Without it the high-noise expert runs the whole schedule.',
        key: 'wanLowNoiseModel',
        label: 'Transformer (Low Noise)',
        modelTypes: ['main'],
        valueKind: 'main',
      });
    }

    return createComponentPolicy(model.format !== 'diffusers', slots);
  }

  // MiniMax H3. The top model selection carries the task identity (its variant
  // decides the panel's generation mode); this section supplies what that
  // selection does not bundle:
  // - a single-file transformer checkpoint at top REQUIRES a Diffusers H3
  //   install in the Model Components slot (tokenizer/processor/VAEs come from
  //   it — full and components-only installs both qualify), plus the
  //   single-file Qwen3-VL encoder when that install is components-only;
  // - a full Diffusers install at top bundles everything, so only the optional
  //   text-encoder override is offered.
  if (model.format === 'diffusers') {
    // A components-only install can still sit at top as legacy stored state
    // (it is no longer selectable); validation steers the user to pick a
    // single-file transformer as the model, and the encoder slot stays
    // required so the panel keeps showing what the install cannot provide.
    const componentsOnly = isComponentsOnlyH3Main(model);

    return createComponentPolicy(componentsOnly, [
      {
        filter: (candidate) => candidate.type === 'qwen3_vl_encoder' && candidate.base === 'minimax-h3',
        helpText: componentsOnly
          ? 'Required: this install has no text-encoder weights, so the text encoder must come from a single-file Qwen3-VL checkpoint.'
          : 'Optional single-file Qwen3-VL encoder used in place of the main model’s text encoder.',
        key: 'h3TextEncoderModel',
        label: 'Text encoder (single file)',
        missingMessage: `${model.name} is a components-only install — select a single-file Text encoder.`,
        modelTypes: ['qwen3_vl_encoder'],
        required: componentsOnly ? () => true : undefined,
        valueKind: 'component',
      },
    ]);
  }

  return createComponentPolicy(true, [
    {
      filter: (candidate) =>
        candidate.type === 'main' && candidate.base === 'minimax-h3' && candidate.format === 'diffusers',
      helpText:
        'Required: a Diffusers MiniMax H3 install (full or components-only) provides the tokenizer, processor, and VAEs the single-file transformer does not carry.',
      key: 'componentSourceModel',
      label: 'Model components',
      missingMessage: `${model.name} is a single-file transformer — select a Diffusers MiniMax H3 install under Model Components.`,
      modelTypes: ['main'],
      required: () => true,
      valueKind: 'main',
    },
    {
      filter: (candidate) => candidate.type === 'qwen3_vl_encoder' && candidate.base === 'minimax-h3',
      helpText:
        'Required when the Model Components install is components-only (no text-encoder weights); a full install provides its own.',
      key: 'h3TextEncoderModel',
      label: 'Text encoder (single file)',
      missingMessage:
        'The selected Model Components install has no text-encoder weights — select a single-file Text encoder.',
      modelTypes: ['qwen3_vl_encoder'],
      required: (ctx) => !isH3TextEncoderSatisfied(ctx),
      valueKind: 'component',
    },
  ]);
};

/** The H3 Diffusers install a checkpoint main draws its components from, if a valid one is selected. */
const getH3ComponentSource = (ctx: VideoComponentPolicyContext): MainModelConfig | null => {
  const source = ctx.settings.componentSourceModel;

  return source && source.base === 'minimax-h3' && source.format === 'diffusers' ? source : null;
};

// A full Diffusers source carries text-encoder weights; a components-only one
// does not, so the single-file Qwen3-VL override becomes required.
const isH3TextEncoderSatisfied = (ctx: VideoComponentPolicyContext): boolean => {
  const source = getH3ComponentSource(ctx);

  return source !== null && !isComponentsOnlyH3Main(source);
};

const getVideoComponentPolicyContext = (
  model: MainModelConfig,
  settings: VideoSettings
): VideoComponentPolicyContext => ({
  model,
  selectedComponents: {
    componentSourceModel: settings.componentSourceModel,
    h3TextEncoderModel: settings.h3TextEncoderModel,
    h3TransformerModel: settings.h3TransformerModel,
    vae: settings.vae,
    wanLowNoiseModel: settings.wanLowNoiseModel,
    wanT5EncoderModel: settings.wanT5EncoderModel,
  },
  settings,
});

// ---------------------------------------------------------------------------
// Wan A14B expert-wiring advisories

export type WanExpertWiringWarning =
  | { kind: 'swapped' }
  | { kind: 'high-as-low' }
  | { kind: 'low-as-main' }
  | { kind: 'single-low' }
  | null;

const getWanExpertTag = (model: MainModelConfig | null): 'high' | 'low' | 'none' => {
  const expert = (model as Record<string, unknown> | null)?.expert;

  return expert === 'high' || expert === 'low' ? expert : 'none';
};

/**
 * Advisory only — mirrors wan_model_loader's stance that explicit wiring is
 * authoritative and the expert tag is a filename heuristic ('none' is common
 * on community finetunes, and deliberate cross-wiring must stay expressible).
 * The panel surfaces this as a badge with a one-click swap; nothing blocks.
 */
export const getWanExpertWiringWarning = (
  model: MainModelConfig | null,
  wanLowNoiseModel: MainModelConfig | null
): WanExpertWiringWarning => {
  // Only single-file A14B mains run the explicit high/low wiring.
  if (!model || model.base !== 'wan' || model.format === 'diffusers') {
    return null;
  }

  const config = getVideoConfig(model);

  if (!config.cfg.lowNoiseVisible) {
    return null;
  }

  const mainTag = getWanExpertTag(model);
  const lowTag = getWanExpertTag(wanLowNoiseModel);

  if (wanLowNoiseModel) {
    if (mainTag === 'low' && lowTag === 'high') {
      return { kind: 'swapped' };
    }
    if (lowTag === 'high') {
      return { kind: 'high-as-low' };
    }
    if (mainTag === 'low') {
      return { kind: 'low-as-main' };
    }

    return null;
  }

  // Single expert running the whole schedule: fine for an untagged or
  // high-tagged file, but a low-tagged one is usually the wrong single pick.
  return mainTag === 'low' ? { kind: 'single-low' } : null;
};

// ---------------------------------------------------------------------------
// Defaults & model-selection transitions

/**
 * The H3 Diffusers install a single-file transformer main should draw its
 * components from. A full install is preferred (it also covers the text
 * encoder); a components-only folder qualifies otherwise. Used to seed
 * defaults/reset and to fill an empty slot on model selection — a checkpoint
 * main is un-invokable without one.
 */
const findH3ComponentSource = (models: readonly ModelConfig[]): MainModelConfig | null => {
  const candidates = models.filter(
    (candidate): candidate is ModelConfig & MainModelConfig =>
      candidate.type === 'main' && candidate.base === 'minimax-h3' && candidate.format === 'diffusers'
  );

  return candidates.find((candidate) => !isComponentsOnlyH3Main(candidate)) ?? candidates[0] ?? null;
};

export const getDefaultVideoSettings = (
  model?: MainModelConfig,
  models: readonly ModelConfig[] = []
): VideoSettings => {
  const config = getVideoConfig(model);

  const base: VideoSettings = {
    acceleratorEnabled: false,
    acceleratorLoraKeys: [],
    aspectRatioId: '16:9',
    batchCount: 1,
    cfgScale: config.defaults.cfgScale,
    cfgScaleLowNoise: config.defaults.cfgScaleLowNoise,
    // A single-file H3 main cannot run without a Diffusers install in the
    // Model Components slot, so defaults (and reset, which reuses them) seed
    // one from the catalog instead of starting un-invokable.
    componentSourceModel:
      model && model.base === 'minimax-h3' && model.format === 'checkpoint' ? findH3ComponentSource(models) : null,
    firstFrameImage: null,
    fps: config.fps.defaultValue,
    h3TextEncoderModel: null,
    h3TransformerModel: null,
    lastFrameImage: null,
    loras: [],
    modelKey: model?.key ?? '',
    negativePrompt: '',
    negativePromptEnabled: true,
    negativePromptHeightPx: 56,
    numFrames: config.frames.defaultValue,
    positivePrompt: '',
    positivePromptHeightPx: 96,
    references: [],
    seed: Math.floor(Math.random() * SEED_MAX),
    shouldRandomizeSeed: true,
    sourceVideo: null,
    steps: config.defaults.steps,
    targetResolution: config.defaults.targetResolution,
    vae: null,
    wanLowNoiseModel: null,
    wanT5EncoderModel: null,
  };

  // The accelerator defaults ON when its LoRA(s) are installed: the plain
  // 40/50-step paths are prohibitively slow as out-of-the-box defaults, and
  // the bundled video templates make the same choice.
  if (model && config.accelerator) {
    const result = getAcceleratorToggleResult(base, model, models, true);

    if (!result.missingLoras) {
      return result.settings;
    }
  }

  return base;
};

export const getVideoSettingsWithModelDefaults = (
  settings: VideoSettings,
  model: MainModelConfig,
  models: readonly ModelConfig[] = []
): VideoSettings => {
  const modelDefaults = getDefaultVideoSettings(model, models);

  const previousKeys = new Set(settings.acceleratorLoraKeys);

  return {
    ...settings,
    acceleratorEnabled: modelDefaults.acceleratorEnabled,
    acceleratorLoraKeys: modelDefaults.acceleratorLoraKeys,
    // The default-bearing layout/component choices reset too: a mispicked
    // VAE or expert is exactly what a user reaches for reset to undo.
    aspectRatioId: modelDefaults.aspectRatioId,
    cfgScale: modelDefaults.cfgScale,
    cfgScaleLowNoise: modelDefaults.cfgScaleLowNoise,
    componentSourceModel: modelDefaults.componentSourceModel,
    fps: modelDefaults.fps,
    h3TextEncoderModel: modelDefaults.h3TextEncoderModel,
    h3TransformerModel: modelDefaults.h3TransformerModel,
    loras: [
      ...settings.loras.filter(
        (lora) => !previousKeys.has(lora.model.key) && !modelDefaults.loras.some((d) => d.model.key === lora.model.key)
      ),
      ...modelDefaults.loras,
    ].map((lora) => (isLoraCompatibleWithModel(lora.model, model) ? lora : { ...lora, isEnabled: false })),
    modelKey: model.key,
    numFrames: modelDefaults.numFrames,
    // A reset clears the references list along with the components: on an
    // FL2VA model the orphaned list would otherwise linger for the widget
    // sync to sweep away silently. (Frame/source conditioning media stay
    // untouched: they remain valid under the FL2VA policy.)
    references: modelDefaults.references,
    steps: modelDefaults.steps,
    targetResolution: modelDefaults.targetResolution,
    vae: modelDefaults.vae,
    wanLowNoiseModel: modelDefaults.wanLowNoiseModel,
    wanT5EncoderModel: modelDefaults.wanT5EncoderModel,
  };
};

export interface VideoModelSelectionResult {
  settings: VideoSettings;
  clearedLabels: readonly string[];
}

const addClearedLabel = (labels: string[], label: string) => {
  if (!labels.includes(label)) {
    labels.push(label);
  }
};

/**
 * Canonical transition for every Video model-selection entry point: reconciles
 * conditioning media against the new model's modes, snaps frames/fps/presets
 * onto its constraints, and drops incompatible LoRAs and components — reporting
 * what was cleared so the UI can say so.
 */
export const getVideoModelSelectionResult = ({
  currentSettings,
  model,
  models,
}: {
  currentSettings: VideoSettings;
  model: MainModelConfig;
  models: readonly ModelConfig[];
}): VideoModelSelectionResult => {
  const config = getVideoConfig(model);
  // A record without a modelKey was healed from a store the panel never
  // seeded (a fresh project, or a pre-open "Send to Video" payload): its
  // sampling values are the model-agnostic healing fallbacks, not user
  // choices. Bootstrap the picked model's own defaults — accelerator
  // included — instead of preserving fallbacks, then reconcile any seeded
  // media below exactly like a normal selection.
  const start = currentSettings.modelKey
    ? currentSettings
    : getVideoSettingsWithModelDefaults(currentSettings, model, models);
  const next: VideoSettings = { ...start, modelKey: model.key };
  const clearedLabels: string[] = [];
  const modes = config.modes;

  if (next.references.length > 0 && !modes.includes('reference')) {
    next.references = [];
    addClearedLabel(clearedLabels, 'References');
  }

  if (next.sourceVideo && !modes.includes('extend') && !config.references?.extend) {
    next.sourceVideo = null;
    addClearedLabel(clearedLabels, 'Initial video');
  }

  // The frame count is snapped BEFORE the tail reference is derived: the window
  // is budgeted against it, and deriving first left a Wan panel's count (as low
  // as 5) sizing a window for a 90-frame H3 generation — under the 13 frames
  // text conditioning needs, so Generate failed outright.
  const snappedFrames = snapVideoNumFrames(model, next.numFrames);
  const framesChanged = snappedFrames !== next.numFrames;

  if (framesChanged) {
    next.numFrames = snappedFrames;
    addClearedLabel(clearedLabels, 'Frames');
  }

  // Reference-extend: a surviving Initial Video (e.g. carried over from an
  // FL2VA extend setup) gets its linked tail reference derived, so the switch
  // lands on a generatable panel. Only when none exists yet: the transition
  // also runs on task-neutral edits (a same-model re-selection, a component
  // change), and re-deriving there would reset a hand-tuned trim the help
  // text only promises to reset on cutpoint changes.
  if (
    config.references?.extend &&
    next.sourceVideo &&
    !next.references.some((entry) => entry.kind === 'video' && entry.fromSourceVideo === true)
  ) {
    next.references = applyReferenceExtendSourceVideo(
      next.references,
      next.sourceVideo,
      config.references.maxVideos,
      next.numFrames
    );
  }

  // A tail reference carried in from another model keeps a window budgeted for
  // that model's frame count. Only when the count actually moved: otherwise a
  // task-neutral re-selection would reset a hand-tuned trim.
  if (config.references?.extend && framesChanged) {
    next.references = applyReferenceExtendNumFrames(next.references, next.numFrames);
  }

  if (next.firstFrameImage && !modes.includes('first-frame') && !modes.includes('first-last')) {
    next.firstFrameImage = null;
    addClearedLabel(clearedLabels, 'First frame');
  }

  if (next.lastFrameImage) {
    // The end-frame anchor rides the FLF2V channel whether its partner is a
    // first frame or a source video; alone it needs a dedicated last-frame mode.
    const lastFrameSupported =
      next.firstFrameImage || next.sourceVideo ? modes.includes('first-last') : modes.includes('last-frame');

    if (!lastFrameSupported) {
      next.lastFrameImage = null;
      addClearedLabel(clearedLabels, 'Last frame');
    }
  }

  if (!config.targetResolutions.some((option) => option.id === next.targetResolution)) {
    next.targetResolution = config.defaults.targetResolution;
    addClearedLabel(clearedLabels, 'Target resolution');
  }

  const clampedFps =
    config.fps.editable && Number.isFinite(next.fps)
      ? Math.min(config.fps.max, Math.max(config.fps.min, Math.round(next.fps)))
      : config.fps.defaultValue;

  if (clampedFps !== next.fps) {
    next.fps = clampedFps;
    addClearedLabel(clearedLabels, 'FPS');
  }

  if (next.acceleratorEnabled) {
    // Carry the "fast path" intent across model switches: when the LoRAs the
    // user is actually running are still a valid accelerator for the new model,
    // everything they may have tuned (steps, CFG, LoRA weights) is left alone.
    // Only when that set no longer applies (Lightning ↔ Turbo, or a Wan pair
    // aimed at the other expert family) is the toggle re-applied — and when the
    // new model has no accelerator, or its LoRAs are not installed, the fast
    // path turns off, restoring the model's own steps/CFG.
    if (!isRecordedAcceleratorIntact(next, model, models, config)) {
      const targetEntries = config.accelerator ? findAcceleratorLoraEntries(model, models) : null;
      const result = getAcceleratorToggleResult(next, model, models, targetEntries !== null);

      Object.assign(next, result.settings);
      addClearedLabel(clearedLabels, 'Acceleration');
    }
  }

  if (next.cfgScaleLowNoise !== null && !config.cfg.lowNoiseVisible) {
    next.cfgScaleLowNoise = null;
    addClearedLabel(clearedLabels, 'CFG (Low Noise)');
  }

  const compatibleLoras = next.loras.filter((lora) => isLoraCompatibleWithModel(lora.model, model));

  if (compatibleLoras.length !== next.loras.length) {
    next.loras = compatibleLoras;
    addClearedLabel(clearedLabels, 'LoRAs');
  }

  const policy = getVideoComponentSectionPolicy(model, next);
  const slotsByKey = new Map(policy.slots.map((slotPolicy) => [slotPolicy.key, slotPolicy]));

  for (const key of Object.keys(VIDEO_COMPONENT_SETTING_LABELS) as VideoComponentValueKey[]) {
    const value = next[key];

    if (!value) {
      continue;
    }

    const slotPolicy = slotsByKey.get(key);
    const isCompatible =
      slotPolicy &&
      (!slotPolicy.filter || slotPolicy.filter(value as ModelConfig, getVideoComponentPolicyContext(model, next)));

    if (!isCompatible) {
      next[key] = null;
      addClearedLabel(clearedLabels, VIDEO_COMPONENT_SETTING_LABELS[key]);
    }
  }

  // A single-file H3 main is un-invokable without a component source; fill an
  // empty slot from the catalog — including one the loop above just cleared
  // (and reported) as incompatible. An explicit compatible pick is never
  // overwritten.
  if (model.base === 'minimax-h3' && model.format === 'checkpoint' && !next.componentSourceModel) {
    next.componentSourceModel = findH3ComponentSource(models);
  }

  return { clearedLabels, settings: next };
};

// ---------------------------------------------------------------------------
// Validation

const VIDEO_MODE_DESCRIPTIONS: Record<VideoGenerationMode, string> = {
  extend: 'extending a video',
  'first-frame': 'starting from a first frame',
  'first-last': 'first-to-last-frame interpolation',
  'last-frame': 'ending on a last frame',
  reference: 'reference-conditioned generation',
  txt2vid: 'text-to-video',
};

const hasModelKey = (models: readonly ModelConfig[], key: string, type?: string): boolean =>
  models.some((model) => model.key === key && (!type || model.type === type));

export const getVideoModelAvailabilityReasons = (
  model: MainModelConfig,
  settings: VideoSettings,
  models: readonly ModelConfig[]
): string[] => {
  const reasons: string[] = [];

  if (!hasModelKey(models, model.key, model.type)) {
    reasons.push(`Selected model "${model.name}" is no longer installed.`);
  }

  for (const key of Object.keys(VIDEO_COMPONENT_SETTING_LABELS) as VideoComponentValueKey[]) {
    const value = settings[key];

    if (value && !hasModelKey(models, value.key, value.type)) {
      reasons.push(`${VIDEO_COMPONENT_SETTING_LABELS[key]} "${value.name}" is no longer installed.`);
    }
  }

  for (const lora of settings.loras) {
    if (!hasModelKey(models, lora.model.key, 'lora')) {
      reasons.push(`LoRA "${lora.model.name}" is no longer installed.`);
    }
  }

  return reasons;
};

export const getVideoValidationReasons = (model: MainModelConfig, settings: VideoSettings): string[] => {
  if (!isSupportedVideoModel(model)) {
    return ['Video needs a supported video model before it can be invoked.'];
  }

  // Supported-but-not-selectable H3 shapes can reach the model slot as stored
  // or recalled state; name the actual fix instead of failing downstream.
  if (isComponentsOnlyH3Main(model)) {
    return [
      `${model.name} is a components-only install. Select a single-file MiniMax H3 transformer as the model; this install then provides its components.`,
    ];
  }
  if (model.base === 'minimax-h3' && model.format === 'diffusers' && model.variant === 'ref2va') {
    return [
      `${model.name} is a Ref2VA folder install, whose transformer weights cannot be folder-loaded. Select a single-file Ref2VA transformer as the model; this install can serve as its Model Components.`,
    ];
  }

  const config = getVideoConfig(model);
  const reasons: string[] = [];
  const mode = resolveVideoMode(settings);
  const referenceOnly = config.modes.length === 1 && config.modes[0] === 'reference';

  if (settings.firstFrameImage && settings.sourceVideo) {
    reasons.push('A first frame and an initial video cannot be combined. Clear one of them.');
  }

  if (settings.references.length > 0 && (settings.firstFrameImage || settings.lastFrameImage)) {
    reasons.push('References cannot be combined with first/last frames. Clear one side.');
  }

  if (settings.references.length > 0 && settings.sourceVideo && !config.references?.extend) {
    reasons.push('References cannot be combined with an initial video on this model. Clear one side.');
  }

  if (!config.modes.includes(mode)) {
    if (referenceOnly && settings.references.length === 0) {
      // The generic message would say "does not support text-to-video", which reads as a
      // model defect; the actual fix is to add a reference.
      reasons.push('Reference-to-video needs at least one image or video reference.');
    } else {
      reasons.push(`${model.name} does not support ${VIDEO_MODE_DESCRIPTIONS[mode]}.`);
    }
  } else if (mode === 'extend' && settings.lastFrameImage && !config.modes.includes('first-last')) {
    reasons.push(`${model.name} cannot target a destination image while extending a video.`);
  }

  if (mode === 'reference') {
    const caps = config.references;
    const videoCount = settings.references.filter((reference) => reference.kind === 'video').length;
    const imageCount = settings.references.length - videoCount;
    const allAudioOnly =
      settings.references.length > 0 &&
      settings.references.every((reference) => reference.kind === 'video' && reference.conditioning === 'audio');

    if (allAudioOnly) {
      reasons.push(
        'At least one reference must contribute visuals — add an image, or set a video reference to include video.'
      );
    }
    if (caps && videoCount > caps.maxVideos) {
      reasons.push(`At most ${caps.maxVideos} video references are supported.`);
    }
    if (caps && imageCount > caps.maxImages) {
      reasons.push(`At most ${caps.maxImages} image references are supported.`);
    }
    for (const reference of settings.references) {
      if (reference.kind !== 'video') {
        continue;
      }
      if (!Number.isInteger(reference.clip.startFrame) || !Number.isInteger(reference.clip.endFrame)) {
        reasons.push('Reference video trim bounds must be whole frame numbers.');
        break;
      }
      if (
        reference.clip.startFrame < 0 ||
        reference.clip.endFrame > reference.clip.numFrames - 1 ||
        reference.clip.endFrame < reference.clip.startFrame
      ) {
        reasons.push('A reference video trim is outside its clip.');
        break;
      }
    }
  }

  if (!isValidVideoNumFrames(model, settings.numFrames)) {
    reasons.push(
      config.frames.kind === 'grid'
        ? `Frame count must be between ${config.frames.min} and ${config.frames.max} in steps of ${config.frames.step} (4·n + 1).`
        : `Frame count must be one of the ${model.name} grid values (17·n + 5, ${config.frames.choices[0]}–${config.frames.choices[config.frames.choices.length - 1]}).`
    );
  }

  // fps and steps are integer fields on the backend nodes; a fractional value
  // would fail pydantic coercion at enqueue, so reject it here instead.
  if (!Number.isInteger(settings.fps) || settings.fps < config.fps.min || settings.fps > config.fps.max) {
    reasons.push(
      config.fps.editable
        ? `FPS must be a whole number between ${config.fps.min} and ${config.fps.max}.`
        : `${model.name} generates at a fixed ${config.fps.defaultValue} FPS.`
    );
  }

  if (!Number.isInteger(settings.steps) || settings.steps < config.minSteps) {
    reasons.push(`Steps must be a whole number of at least ${config.minSteps}.`);
  }

  if (config.cfg.visible && (!Number.isFinite(settings.cfgScale) || settings.cfgScale < 1)) {
    reasons.push('CFG must be at least 1.');
  }

  if (config.cfg.lowNoiseVisible && settings.cfgScaleLowNoise !== null && settings.cfgScaleLowNoise < 0) {
    reasons.push('CFG (Low Noise) must be at least 0.');
  }

  if (settings.acceleratorEnabled && !config.accelerator) {
    reasons.push(`${model.name} has no distillation fast path. Turn the accelerator off to generate with it.`);
  }

  // The trim bounds are integer fields on extract_video_range; a fractional
  // persisted value would fail pydantic coercion at enqueue.
  if (
    settings.sourceVideo &&
    (!Number.isInteger(settings.sourceVideo.startFrame) || !Number.isInteger(settings.sourceVideo.endFrame))
  ) {
    reasons.push('The initial video trim bounds must be whole frame numbers.');
  } else if (settings.sourceVideo) {
    const { endFrame, numFrames, startFrame } = settings.sourceVideo;

    // The crossfade join consumes a 2-frame tail from the trimmed source, so a
    // 1-frame trim fails mid-encode; catch it (and out-of-range bounds) here.
    if (startFrame < 0 || endFrame > numFrames - 1 || endFrame - startFrame + 1 < MIN_VIDEO_TRIM_FRAMES) {
      reasons.push('The initial video trim must keep at least two frames within the clip.');
    }

    if (numFrames < MIN_VIDEO_TRIM_FRAMES) {
      reasons.push('The initial video is too short to extend.');
    }

    // A Wan extension inherits the source clip's frame rate, and the backend's
    // wan_l2v/video_concat nodes accept 1-120 fps. An out-of-range clip (a
    // 240 fps slow-mo, an unprobeable sub-1 fps rate) would enqueue, run the
    // whole denoise, then die assigning the fps — so block it here instead.
    if (model.base === 'wan') {
      const inheritedFps = Math.round(settings.sourceVideo.fps);

      if (inheritedFps < 1 || inheritedFps > 120) {
        reasons.push(
          `The initial video's frame rate (${settings.sourceVideo.fps} fps) is outside the 1-120 fps range Wan extension supports.`
        );
      }
    }
  }

  if (!getVideoDimensions(model, settings)) {
    reasons.push(
      model.base === 'minimax-h3'
        ? 'MiniMax H3 supports aspect ratios from 1:4 to 4:1. The conditioning media is outside that range.'
        : 'The conditioning media is too small or degenerate to derive video dimensions from.'
    );
  }

  if (model.base === 'wan') {
    // A14B and 5B Wan LoRAs are not interchangeable — the layer patcher fails
    // on a tensor-shape mismatch — so say so instead of silently dropping them.
    for (const lora of settings.loras) {
      if (lora.isEnabled && !isWanLoraTargetingMain(lora.model.variant, model.variant)) {
        reasons.push(`${lora.model.name} targets a different Wan model family than ${model.name}.`);
      }
    }
  }

  const componentPolicy = getVideoComponentSectionPolicy(model, settings);
  reasons.push(...componentPolicy.validate(getVideoComponentPolicyContext(model, settings)));

  return reasons;
};
