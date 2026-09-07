import type {
  GenerateLora,
  ImageWithDims,
  MainModelConfig,
  ModelIdentifierConfig,
  VaeModelConfig,
} from '@features/generation/contracts';

/**
 * How a video generation is conditioned. There is no explicit mode selector:
 * the mode is inferred from which inputs are filled — see `resolveVideoMode`.
 */
export type VideoGenerationMode = 'txt2vid' | 'first-frame' | 'last-frame' | 'first-last' | 'extend' | 'reference';

/** A gallery video selected as the clip to extend, with the trim range to keep. */
export interface VideoSourceClip {
  video_name: string;
  width: number;
  height: number;
  numFrames: number;
  fps: number;
  /** Inclusive trim bounds forwarded to `extract_video_range`; negative indices count from the end. */
  startFrame: number;
  endFrame: number;
}

/**
 * Which streams a Ref2VA video reference conditions. The graph-literal values of the
 * `minimax_h3_video_reference` node: 'audio' maps to upstream's standalone audio-reference
 * kind, sourced from the video's soundtrack.
 */
export type VideoReferenceConditioning = 'video_audio' | 'video' | 'audio';

/** Ref2VA image-reference sizing: 'max' = 2048px short edge, 'match' = generation's pixel area. */
export type VideoReferenceImageDetail = 'max' | 'match';

/**
 * One ordered Ref2VA reference. Order is part of the request contract — a different order
 * is a different generation — so references live in a single ordered array whatever their
 * kind. A video reference reuses `VideoSourceClip` for its trim bounds.
 */
export type VideoReferenceItem =
  | {
      kind: 'video';
      clip: VideoSourceClip;
      conditioning: VideoReferenceConditioning;
      /**
       * True on the reference the panel derives from the Initial Video in
       * Ref2VA extend mode: it tracks that clip's identity, and its trim
       * defaults re-derive from the cutpoint (up to ~5s of lead-in at 24 fps,
       * capped at the generated frame count so the backend keeps the whole
       * window) whenever the Initial Video trim or the frame count changes.
       * It is an ordinary reference otherwise — reorderable, trimmable,
       * removable — and the flag is panel state only, never in metadata.
       */
      fromSourceVideo?: boolean;
    }
  | { kind: 'image'; image: ImageWithDims; detail: VideoReferenceImageDetail };

export type WanTargetResolution = '480p' | '720p' | '1080p';
export type MiniMaxH3TargetResolution = '768 highres' | '768 lowres';
export type VideoTargetResolution = WanTargetResolution | MiniMaxH3TargetResolution;

/**
 * The preset ratios the video panel offers. No `Free` and no width/height
 * fields: pixel dimensions are always derived — from this ratio plus the
 * target-resolution preset in text-to-video, or from the conditioning media's
 * own ratio once a frame or source video is set.
 */
export type VideoAspectRatioId = '21:9' | '16:9' | '3:2' | '4:3' | '1:1' | '3:4' | '2:3' | '9:16' | '9:21';

/** Project-persisted settings owned by the Video widget. */
export interface VideoSettings {
  batchCount: number;
  modelKey: string;
  positivePrompt: string;
  positivePromptHeightPx: number;
  negativePromptEnabled: boolean;
  negativePrompt: string;
  negativePromptHeightPx: number;
  /** Image-to-video conditioning. Mutually exclusive with `sourceVideo`. */
  firstFrameImage: ImageWithDims | null;
  /**
   * The frame the clip should end on: FLF2V interpolation with a first frame,
   * or the destination image when extending a source video. Combines with
   * either `firstFrameImage` or `sourceVideo`.
   */
  lastFrameImage: ImageWithDims | null;
  /**
   * The clip to extend. Mutually exclusive with `firstFrameImage`. On an
   * FL2VA model this drives extend mode; on a Ref2VA model it coexists with
   * `references` (reference-extend: the new clip is appended to it, and a
   * linked tail reference provides continuity).
   */
  sourceVideo: VideoSourceClip | null;
  /**
   * Ref2VA references, in conditioning order (up to 3 videos and 9 images).
   * Mutually exclusive with `firstFrameImage`/`lastFrameImage`; `sourceVideo`
   * may coexist on a Ref2VA model (reference-extend). Only a Ref2VA
   * transformer consumes them — see `resolveVideoMode` and the `reference` mode.
   */
  references: VideoReferenceItem[];
  aspectRatioId: VideoAspectRatioId;
  targetResolution: VideoTargetResolution;
  numFrames: number;
  fps: number;
  steps: number;
  cfgScale: number;
  /** Guidance for the low-noise half of a Wan A14B schedule; null reuses `cfgScale`. */
  cfgScaleLowNoise: number | null;
  /**
   * The family's distillation fast path: the Lightning LoRA pair at 4 steps /
   * CFG 1 for Wan A14B, the Turbo LoRA at 6 steps for MiniMax H3. Toggling it
   * patches steps/CFG and the `loras` list — see `getAcceleratorToggleResult`
   * — so the flag records intent, not hidden state.
   */
  acceleratorEnabled: boolean;
  /**
   * The keys of the LoRA entries the accelerator toggle added. Turning the
   * fast path off (or switching families) removes exactly these — never a
   * user's own LoRA that happens to be named like one — and the enabled flag
   * cannot outlive them.
   */
  acceleratorLoraKeys: string[];
  seed: number;
  shouldRandomizeSeed: boolean;
  loras: GenerateLora[];
  /** Optional VAE override; null uses the VAE bundled with the main model or component source. */
  vae: VaeModelConfig | null;
  /** Wan 2.2's UMT5-XXL text encoder. */
  wanT5EncoderModel: ModelIdentifierConfig | null;
  /** The low-noise expert of a Wan 2.2 A14B mixture-of-experts pair. */
  wanLowNoiseModel: MainModelConfig | null;
  /**
   * Diffusers main model used as a component source for single-file mains:
   * split/quantized Wan models, and single-file MiniMax H3 transformers
   * (which take tokenizer/processor/VAEs from it).
   */
  componentSourceModel: MainModelConfig | null;
  /**
   * LEGACY — pre model-positions persisted shape only. The single-file H3
   * transformer used to be an override slot; it is the top model selection
   * now. `syncVideoWidgetValuesWithModels` promotes a stored value onto
   * `model` (keeping the old main as `componentSourceModel`); nothing writes
   * this field any more.
   */
  h3TransformerModel: MainModelConfig | null;
  /** Optional single-file MiniMax H3 Qwen3-VL text-encoder override. */
  h3TextEncoderModel: ModelIdentifierConfig | null;
}

export interface VideoWidgetValues extends VideoSettings {
  /** The selected main model; null until the user picks one (or none is installed). */
  model: MainModelConfig | null;
}
