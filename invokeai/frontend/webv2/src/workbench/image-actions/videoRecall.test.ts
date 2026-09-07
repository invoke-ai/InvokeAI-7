import type { GenerationModelCatalogItem, MainModelConfig } from '@features/generation/contracts';

import { createDefaultVideoWidgetValues } from '@features/video';
import { describe, expect, it } from 'vitest';

import {
  buildVideoRecallSettings,
  deriveAcceleratorRecallState,
  EMPTY_VIDEO_RECALL_CAPABILITIES,
  getRecallableMediaNames,
  getVideoRecallCapabilities,
  getVideoSizeRecall,
  isVideoGenerationMetadata,
} from './videoRecall';

const wanModel = (variant: string, format = 'diffusers', key = `wan-${variant}-${format}`): MainModelConfig => ({
  base: 'wan',
  format,
  key,
  name: `Wan 2.2 ${variant}`,
  type: 'main',
  variant,
});

const h3Model = (key = 'h3-main'): MainModelConfig => ({
  base: 'minimax-h3',
  format: 'diffusers',
  key,
  name: 'MiniMax H3',
  type: 'main',
  variant: 'fl2va',
});

const lora = (name: string, base = 'wan', variant: string | null = 'a14b'): GenerationModelCatalogItem => ({
  base,
  key: `lora-${name}`,
  name,
  type: 'lora',
  variant,
});

const LIGHTNING_HIGH = lora('Wan 2.2 T2V Lightning High Noise (4-step)');
const LIGHTNING_LOW = lora('Wan 2.2 T2V Lightning Low Noise (4-step)');

const WAN_T2V = wanModel('t2v_a14b');
const WAN_I2V = wanModel('i2v_a14b');

const wanMetadata = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  cfg_scale: 1,
  generation_mode: 'wan_t2v',
  height: 720,
  model: { base: 'wan', key: WAN_T2V.key, name: WAN_T2V.name, type: 'main' },
  negative_prompt: 'blurry',
  num_frames: 81,
  positive_prompt: 'a red fox running',
  seed: 1234,
  steps: 4,
  width: 1280,
  ...extra,
});

describe('isVideoGenerationMetadata', () => {
  it('accepts only the video generation modes', () => {
    expect(isVideoGenerationMetadata(wanMetadata())).toBe(true);
    expect(isVideoGenerationMetadata({ generation_mode: 'minimax_h3_flf2v' })).toBe(true);
    // Image metadata — including Wan still-image modes — is not video metadata.
    expect(isVideoGenerationMetadata({ generation_mode: 'wan_txt2img' })).toBe(false);
    expect(isVideoGenerationMetadata({ generation_mode: 'sdxl_txt2img' })).toBe(false);
    expect(isVideoGenerationMetadata({})).toBe(false);
    expect(isVideoGenerationMetadata(null)).toBe(false);
  });
});

describe('getVideoRecallCapabilities', () => {
  it('is empty for non-video metadata', () => {
    expect(getVideoRecallCapabilities({ generation_mode: 'sdxl_txt2img', seed: 5 })).toEqual(
      EMPTY_VIDEO_RECALL_CAPABILITIES
    );
  });

  it('derives per-verb availability from what the metadata contains', () => {
    expect(getVideoRecallCapabilities(wanMetadata())).toEqual({ all: true, prompts: true, remix: true, seed: true });
    expect(getVideoRecallCapabilities({ generation_mode: 'wan_t2v', seed: 7 })).toEqual({
      all: true,
      prompts: false,
      remix: false,
      seed: true,
    });
  });
});

describe('getRecallableMediaNames', () => {
  it('suppresses the extracted first frame in extend mode', () => {
    const names = getRecallableMediaNames({
      first_frame_image: { image_name: 'extracted.png' },
      generation_mode: 'wan_extend_video',
      last_frame_image: { image_name: 'destination.png' },
      source_video: { video_name: 'clip.mp4' },
    });

    expect(names).toEqual({ firstFrameName: null, lastFrameName: 'destination.png', sourceVideoName: 'clip.mp4' });
  });

  it('keeps user keyframes when no source video was recorded', () => {
    expect(
      getRecallableMediaNames({ first_frame_image: { image_name: 'first.png' }, generation_mode: 'wan_i2v' })
    ).toEqual({ firstFrameName: 'first.png', lastFrameName: null, sourceVideoName: null });
  });
});

describe('getVideoSizeRecall', () => {
  it('inverts a preset-derived canvas exactly', () => {
    expect(getVideoSizeRecall(WAN_T2V, 1280, 720)).toEqual({ aspectRatioId: '16:9', targetResolution: '720p' });
    expect(getVideoSizeRecall(h3Model(), 1344, 768)).toEqual({
      aspectRatioId: '16:9',
      targetResolution: '768 highres',
    });
  });

  it('rejects sizes that came from conditioning media rather than a preset', () => {
    // 1920x1080-shaped media at some odd snap no preset reproduces.
    expect(getVideoSizeRecall(WAN_T2V, 848, 464)).toBeNull();
  });
});

describe('deriveAcceleratorRecallState', () => {
  const settings = createDefaultVideoWidgetValues([WAN_T2V]);
  const pairEntries = [
    { isEnabled: true, model: LIGHTNING_HIGH as never, weight: 1 },
    { isEnabled: true, model: LIGHTNING_LOW as never, weight: 1 },
  ];

  it('re-enables the fast path when the recalled LoRAs are exactly the accelerator set at its steps', () => {
    expect(deriveAcceleratorRecallState(WAN_T2V, pairEntries, 4, settings)).toEqual({
      acceleratorEnabled: true,
      acceleratorLoraKeys: [LIGHTNING_HIGH.key, LIGHTNING_LOW.key],
    });
  });

  it('reads the step count off the recalled LoRAs, not off what the panel is running', () => {
    // A panel already running an 8-step Turbo LoRA must not shift the step
    // count a 6-step one is checked against.
    const turbo = { base: 'minimax-h3', key: 'turbo', name: 'MiniMax H3 Turbo LoRA', type: 'lora' as const };
    const lightx2v = {
      base: 'minimax-h3',
      key: 'lightx2v',
      name: 'MiniMax H3 LightX2V Turbo LoRA',
      type: 'lora' as const,
    };
    const model = h3Model();
    const running = {
      ...createDefaultVideoWidgetValues([model, lightx2v as never]),
      acceleratorEnabled: true,
      acceleratorLoraKeys: [lightx2v.key],
      loras: [{ isEnabled: true, model: lightx2v as never, weight: 1 }],
      steps: 8,
    };
    const recalled = [{ isEnabled: true, model: turbo as never, weight: 1 }];

    expect(deriveAcceleratorRecallState(model, recalled, 6, running)).toEqual({
      acceleratorEnabled: true,
      acceleratorLoraKeys: [turbo.key],
    });
  });

  it('stays off at non-accelerator steps or with a partial pair', () => {
    expect(deriveAcceleratorRecallState(WAN_T2V, pairEntries, 40, settings)).toEqual({
      acceleratorEnabled: false,
      acceleratorLoraKeys: [],
    });
    expect(deriveAcceleratorRecallState(WAN_T2V, [pairEntries[0]!], 4, settings)).toEqual({
      acceleratorEnabled: false,
      acceleratorLoraKeys: [],
    });
  });
});

describe('buildVideoRecallSettings', () => {
  const catalog = [WAN_T2V, WAN_I2V, h3Model(), LIGHTNING_HIGH, LIGHTNING_LOW];
  const currentValues = { ...createDefaultVideoWidgetValues([h3Model()]) };

  it('recalls prompts into the video widget values, leaving everything else alone', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'prompts',
      metadata: wanMetadata(),
      models: catalog,
    });

    expect(result?.fields).toEqual(['prompts']);
    expect(result?.values).toEqual({
      ...currentValues,
      negativePrompt: 'blurry',
      negativePromptEnabled: true,
      positivePrompt: 'a red fox running',
    });
  });

  it('recalls only the seed for the seed verb', () => {
    const result = buildVideoRecallSettings({ currentValues, kind: 'seed', metadata: wanMetadata(), models: catalog });

    expect(result?.fields).toEqual(['seed']);
    expect(result?.values).toMatchObject({ seed: 1234, shouldRandomizeSeed: false });
  });

  it('remix recalls everything except the seed', () => {
    const result = buildVideoRecallSettings({ currentValues, kind: 'remix', metadata: wanMetadata(), models: catalog });

    expect(result?.fields).not.toContain('seed');
    expect(result?.values.shouldRandomizeSeed).toBe(currentValues.shouldRandomizeSeed);
    expect(result?.fields).toEqual(expect.arrayContaining(['model', 'frames', 'steps', 'cfg', 'size']));
  });

  it('resolves the model by key and snaps cross-family constraints before applying values', () => {
    // Current panel is H3 (frames 124, fps 24); metadata is a Wan t2v run.
    const result = buildVideoRecallSettings({ currentValues, kind: 'all', metadata: wanMetadata(), models: catalog });

    expect(result?.values.model?.key).toBe(WAN_T2V.key);
    expect(result?.values).toMatchObject({
      aspectRatioId: '16:9',
      cfgScale: 1,
      numFrames: 81,
      seed: 1234,
      steps: 4,
      targetResolution: '720p',
    });
  });

  it('skips the model (and validates against the current one) when it is not installed', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: wanMetadata({ model: { key: 'gone' }, num_frames: 81 }),
      models: [h3Model()],
    });

    expect(result?.fields).not.toContain('model');
    expect(result?.values.model?.base).toBe('minimax-h3');
    // 81 is off the H3 grid; it snaps rather than landing invalid.
    expect(result?.values.numFrames).toBe(90);
  });

  it('recalls LoRAs by key and restores the accelerator state that produced the video', () => {
    const metadata = wanMetadata({
      loras: [
        { model: { key: LIGHTNING_HIGH.key }, weight: 1 },
        { model: { key: LIGHTNING_LOW.key }, weight: 1 },
      ],
    });
    const result = buildVideoRecallSettings({ currentValues, kind: 'all', metadata, models: catalog });

    expect(result?.fields).toContain('loras');
    expect(result?.values.loras.map((entry) => entry.model.key)).toEqual([LIGHTNING_HIGH.key, LIGHTNING_LOW.key]);
    expect(result?.values).toMatchObject({ acceleratorEnabled: true });
  });

  it('clears existing LoRAs when the video ran without any', () => {
    const withLora = {
      ...currentValues,
      loras: [{ isEnabled: true, model: LIGHTNING_HIGH as never, weight: 1 }],
    };
    const result = buildVideoRecallSettings({
      currentValues: withLora,
      kind: 'all',
      metadata: wanMetadata(),
      models: catalog,
    });

    expect(result?.fields).toContain('loras');
    expect(result?.values.loras).toEqual([]);
    expect(result?.values.acceleratorEnabled).toBe(false);
  });

  it('reports recallable media names but leaves hydration to the executor', () => {
    const metadata = wanMetadata({
      first_frame_image: { image_name: 'first.png' },
      generation_mode: 'wan_i2v',
      model: { key: WAN_I2V.key },
    });
    const result = buildVideoRecallSettings({ currentValues, kind: 'all', metadata, models: catalog });

    expect(result?.fields).toContain('media');
    expect(result?.mediaNames).toEqual({
      firstFrameName: 'first.png',
      lastFrameName: null,
      references: [],
      sourceVideoName: null,
      sourceVideoTrim: null,
    });
    expect(result?.values.firstFrameImage).toBeNull();
  });

  it('recalls the recorded Wan fps and carries the source-clip trim bounds for the executor', () => {
    const withFps = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: wanMetadata({ fps: 24 }),
      models: catalog,
    });

    expect(withFps?.fields).toContain('fps');
    expect(withFps?.values.fps).toBe(24);

    const extend = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: wanMetadata({
        generation_mode: 'wan_extend_video',
        model: { key: WAN_I2V.key },
        source_video: { video_name: 'clip.mp4' },
        source_video_end_frame: 50,
        source_video_start_frame: 10,
      }),
      models: catalog,
    });

    expect(extend?.mediaNames.sourceVideoName).toBe('clip.mp4');
    expect(extend?.mediaNames.sourceVideoTrim).toEqual({ endFrame: 50, startFrame: 10 });
  });

  it('restores reuse-primary semantics when the low-noise CFG key is absent', () => {
    const withLow = { ...createDefaultVideoWidgetValues([WAN_T2V]), cfgScaleLowNoise: 2 };
    // wan_t2v metadata without guidance_scale_low_noise: the run reused the
    // primary CFG, so the recalled state must too.
    const result = buildVideoRecallSettings({
      currentValues: withLow,
      kind: 'all',
      metadata: wanMetadata(),
      models: catalog,
    });

    expect(result?.values.cfgScaleLowNoise).toBeNull();

    const withKey = buildVideoRecallSettings({
      currentValues: withLow,
      kind: 'all',
      metadata: wanMetadata({ guidance_scale_low_noise: 3 }),
      models: catalog,
    });

    expect(withKey?.values.cfgScaleLowNoise).toBe(3);
  });

  it('clears held conditioning media when the recorded run had none — mode is part of the recall', () => {
    const withFrame = {
      ...createDefaultVideoWidgetValues([WAN_I2V]),
      firstFrameImage: { height: 720, image_name: 'held.png', width: 1280 },
    };
    const result = buildVideoRecallSettings({
      currentValues: withFrame,
      kind: 'all',
      metadata: wanMetadata(),
      models: catalog,
    });

    expect(result?.fields).toContain('media');
    expect(result?.values.firstFrameImage).toBeNull();
    expect(result?.values.sourceVideo).toBeNull();
  });

  it('does not flip the negative toggle on for an empty recorded negative', () => {
    const empty = buildVideoRecallSettings({
      currentValues,
      kind: 'prompts',
      metadata: wanMetadata({ negative_prompt: '' }),
      models: catalog,
    });

    expect(empty?.values).toEqual({ ...currentValues, positivePrompt: 'a red fox running' });

    const explicitNull = buildVideoRecallSettings({
      currentValues,
      kind: 'prompts',
      metadata: wanMetadata({ negative_prompt: null }),
      models: catalog,
    });

    expect(explicitNull?.values).toMatchObject({ negativePrompt: '', negativePromptEnabled: false });
  });

  it('clears current LoRAs when the recorded ones are no longer installed', () => {
    const withLora = {
      ...currentValues,
      loras: [{ isEnabled: true, model: LIGHTNING_HIGH as never, weight: 1 }],
    };
    const result = buildVideoRecallSettings({
      currentValues: withLora,
      kind: 'all',
      metadata: wanMetadata({ loras: [{ model: { key: 'uninstalled' }, weight: 1 }] }),
      models: [WAN_T2V, LIGHTNING_HIGH],
    });

    expect(result?.values.loras).toEqual([]);
    expect(result?.fields).toContain('loras');
  });

  it('returns null for non-video metadata', () => {
    expect(
      buildVideoRecallSettings({
        currentValues,
        kind: 'all',
        metadata: { generation_mode: 'sdxl_txt2img', seed: 3 },
        models: catalog,
      })
    ).toBeNull();
  });
});

describe('ref2va reference recall', () => {
  const catalog = [WAN_T2V, WAN_I2V, h3Model(), LIGHTNING_HIGH, LIGHTNING_LOW];
  const currentValues = { ...createDefaultVideoWidgetValues([h3Model()]) };
  const h3RefMetadata = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    generation_mode: 'minimax_h3_ref2v',
    height: 768,
    minimax_h3_references: [
      { conditioning: 'video_audio', end_frame: 47, kind: 'video', start_frame: 2, video_name: 'ref.mp4' },
      { detail: 'match', image_name: 'ref.png', kind: 'image' },
      { kind: 'video' },
    ],
    model: { base: 'minimax-h3', key: 'h3-main', name: 'MiniMax H3', type: 'main' },
    num_frames: 124,
    positive_prompt: 'a red fox',
    seed: 7,
    steps: 4,
    width: 1344,
    ...extra,
  });

  it('recognizes the ref2v generation mode as video metadata', () => {
    expect(isVideoGenerationMetadata({ generation_mode: 'minimax_h3_ref2v' })).toBe(true);
  });

  it('reports the ordered references, tolerantly skipping malformed entries', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: h3RefMetadata(),
      models: catalog,
    });

    expect(result?.fields).toContain('media');
    expect(result?.mediaNames.references).toEqual([
      { conditioning: 'video_audio', kind: 'video', name: 'ref.mp4', trim: { endFrame: 47, startFrame: 2 } },
      { detail: 'match', kind: 'image', name: 'ref.png' },
    ]);
    // References replace the frame/source slots.
    expect(result?.mediaNames.firstFrameName).toBeNull();
    expect(result?.values.references).toEqual([]);
  });

  it("clears the panel's held media so the executor re-hydrates references on a clean slate", () => {
    const holding = {
      ...currentValues,
      firstFrameImage: { height: 4, image_name: 'held.png', width: 4 },
    };
    const result = buildVideoRecallSettings({
      currentValues: holding,
      kind: 'all',
      metadata: h3RefMetadata(),
      models: catalog,
    });

    expect(result?.values.firstFrameImage).toBeNull();
  });
});

describe('model-position recall shapes', () => {
  const install = h3Model();
  const checkpoint: MainModelConfig = {
    base: 'minimax-h3',
    format: 'checkpoint',
    key: 'h3-ref2va-ckpt',
    name: 'MiniMax H3 Ref2VA Transformer (int8, pruned)',
    type: 'main',
    variant: 'ref2va',
  };
  const ref2vTurbo = {
    base: 'minimax-h3',
    key: 'ref2v-turbo',
    name: 'MiniMax H3 Ref2V Turbo LoRA',
    type: 'lora' as const,
  };
  const catalog = [install, checkpoint, ref2vTurbo];
  const currentValues = { ...createDefaultVideoWidgetValues([install]) };

  it('promotes a legacy transformer-override recording onto the model slot before deriving the accelerator', () => {
    // Pre model-positions metadata: the Diffusers install as `model`, the
    // checkpoint as an override extra. The 4-step Ref2V Turbo derivation only
    // succeeds if the promote lands first — it needs the ref2va variant.
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: {
        generation_mode: 'minimax_h3_ref2v',
        loras: [{ model: { key: ref2vTurbo.key }, weight: 1 }],
        minimax_h3_references: [{ detail: 'max', image_name: 'ref.png', kind: 'image' }],
        minimax_h3_transformer_model: { key: checkpoint.key },
        model: { key: install.key },
        num_frames: 124,
        steps: 4,
      },
      models: catalog,
    });

    expect(result?.values.model?.key).toBe(checkpoint.key);
    expect(result?.values.componentSourceModel?.key).toBe(install.key);
    expect(result?.values.h3TransformerModel).toBeNull();
    expect(result?.values.modelKey).toBe(checkpoint.key);
    expect(result?.values).toMatchObject({ acceleratorEnabled: true, acceleratorLoraKeys: [ref2vTurbo.key] });
  });

  it('recalls the recorded component source for a checkpoint-main recording', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: {
        generation_mode: 'minimax_h3_ref2v',
        minimax_h3_component_source: { key: install.key },
        minimax_h3_references: [{ detail: 'max', image_name: 'ref.png', kind: 'image' }],
        model: { key: checkpoint.key },
        num_frames: 124,
      },
      models: catalog,
    });

    expect(result?.fields).toContain('model');
    expect(result?.values.model?.key).toBe(checkpoint.key);
    expect(result?.values.componentSourceModel?.key).toBe(install.key);
  });
  it('promotes the recorded transformer even when the recorded install itself is gone', () => {
    // The transformer defines the run; the panel's current model (a
    // checkpoint) stands in for the missing install and must not suppress the
    // promote — pre-fix the references were dropped as unsupported.
    const panelCheckpoint: MainModelConfig = {
      base: 'minimax-h3',
      format: 'checkpoint',
      key: 'h3-fl2va-ckpt',
      name: 'MiniMax H3 FL2VA Transformer (int8)',
      type: 'main',
      variant: 'fl2va',
    };
    const result = buildVideoRecallSettings({
      currentValues: { ...currentValues, model: panelCheckpoint, modelKey: panelCheckpoint.key },
      kind: 'all',
      metadata: {
        generation_mode: 'minimax_h3_ref2v',
        minimax_h3_references: [{ detail: 'max', image_name: 'ref.png', kind: 'image' }],
        minimax_h3_transformer_model: { key: checkpoint.key },
        model: { key: 'h3-install-gone' },
        num_frames: 124,
      },
      models: [panelCheckpoint, checkpoint],
    });

    expect(result?.values.model?.key).toBe(checkpoint.key);
    expect(result?.fields).toContain('model');
    expect(result?.values.h3TransformerModel).toBeNull();
    expect(result?.mediaNames.references).toHaveLength(1);
  });

  it('drops a corrupt transformer-override recording that names a non-main', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: {
        generation_mode: 'minimax_h3_ref2v',
        minimax_h3_references: [{ detail: 'max', image_name: 'ref.png', kind: 'image' }],
        minimax_h3_transformer_model: { key: ref2vTurbo.key },
        model: { key: install.key },
        num_frames: 124,
      },
      models: catalog,
    });

    expect(result?.values.model?.key).toBe(install.key);
    expect(result?.values.h3TransformerModel).toBeNull();
  });

  it('reports the source video alongside the references for a reference-extend recording', () => {
    const result = buildVideoRecallSettings({
      currentValues,
      kind: 'all',
      metadata: {
        generation_mode: 'minimax_h3_ref2v',
        minimax_h3_component_source: { key: install.key },
        minimax_h3_references: [
          { conditioning: 'video_audio', end_frame: 400, kind: 'video', start_frame: 260, video_name: 'long.mp4' },
        ],
        model: { key: checkpoint.key },
        num_frames: 124,
        source_video: { video_name: 'long.mp4' },
        source_video_end_frame: 400,
        source_video_start_frame: 10,
      },
      models: catalog,
    });

    expect(result?.fields).toContain('media');
    expect(result?.mediaNames.references).toHaveLength(1);
    expect(result?.mediaNames.sourceVideoName).toBe('long.mp4');
    expect(result?.mediaNames.sourceVideoTrim).toEqual({ endFrame: 400, startFrame: 10 });
  });
});
