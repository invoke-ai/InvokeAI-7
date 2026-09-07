import type { GenerationModelCatalogItem, MainModelConfig } from '@features/generation/contracts';

import { describe, expect, it } from 'vitest';

import type { VideoSettings } from './types';

import {
  findMiniMaxH3TurboLora,
  findWanLightningLoraPair,
  getAcceleratorLoraChangeResult,
  getDefaultVideoSettings,
  getAcceleratorToggleResult,
  getVideoComponentSectionPolicy,
  getVideoDimensions,
  getVideoModelAvailabilityReasons,
  getVideoModelPolicy,
  getVideoModelSelectionResult,
  getVideoModes,
  getVideoPromptPolicy,
  getVideoValidationReasons,
  getWanExpertWiringWarning,
  isSupportedVideoModel,
  isVideoModelSelectable,
  isValidVideoNumFrames,
  snapVideoNumFrames,
  WAN_LIGHTNING_ACCELERATOR,
} from './videoPolicies';

const wanModel = (variant: string, format = 'gguf_quantized', key = `wan-${variant}-${format}`): MainModelConfig => ({
  base: 'wan',
  format,
  key,
  name: `Wan 2.2 ${variant}`,
  type: 'main',
  variant,
});

const h3Model = (format = 'diffusers', key = `h3-${format}`): MainModelConfig => ({
  base: 'minimax-h3',
  format,
  key,
  name: 'MiniMax H3',
  type: 'main',
  variant: 'fl2va',
});

const lora = (name: string, variant: string | null = 'a14b', key = `lora-${name}`): GenerationModelCatalogItem => ({
  base: 'wan',
  key,
  name,
  type: 'lora',
  variant,
});

const LIGHTNING_T2V_HIGH = lora('Wan 2.2 T2V Lightning High Noise (4-step)');
const LIGHTNING_T2V_LOW = lora('Wan 2.2 T2V Lightning Low Noise (4-step)');
const LIGHTNING_I2V_HIGH = lora('Wan 2.2 I2V Lightning High Noise (4-step)');
const LIGHTNING_I2V_LOW = lora('Wan 2.2 I2V Lightning Low Noise (4-step)');

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

const settingsFor = (model?: MainModelConfig, overrides: Partial<VideoSettings> = {}): VideoSettings => ({
  ...getDefaultVideoSettings(model),
  ...overrides,
});

describe('isSupportedVideoModel', () => {
  it('accepts Wan mains in any format', () => {
    expect(isSupportedVideoModel(wanModel('t2v_a14b', 'gguf_quantized'))).toBe(true);
    expect(isSupportedVideoModel(wanModel('i2v_a14b', 'diffusers'))).toBe(true);
    expect(isSupportedVideoModel(wanModel('ti2v_5b', 'checkpoint'))).toBe(true);
  });

  it('accepts MiniMax H3 mains in Diffusers and single-file checkpoint formats', () => {
    expect(isSupportedVideoModel(h3Model('diffusers'))).toBe(true);
    // The single-file transformer checkpoint IS the model identity now.
    expect(isSupportedVideoModel(h3Model('checkpoint'))).toBe(true);
    expect(isSupportedVideoModel({ ...h3Model('gguf_quantized'), format: 'gguf_quantized' })).toBe(false);
  });

  it('offers only runnable identity-bearing H3 models in the top selector', () => {
    // Checkpoints of either task variant and full FL2VA Diffusers installs are
    // selectable; a components-only folder belongs in the Model Components
    // slot, and a Ref2VA folder's transformer weights are not folder-loadable.
    expect(isVideoModelSelectable(h3Model('checkpoint'))).toBe(true);
    expect(isVideoModelSelectable({ ...h3Model('checkpoint'), variant: 'ref2va' })).toBe(true);
    expect(isVideoModelSelectable(h3Model('diffusers'))).toBe(true);
    expect(isVideoModelSelectable({ ...h3Model('diffusers'), components_only: true })).toBe(false);
    expect(isVideoModelSelectable({ ...h3Model('diffusers'), variant: 'ref2va' })).toBe(false);
    expect(isVideoModelSelectable(wanModel('ti2v_5b', 'checkpoint'))).toBe(true);
  });

  it('rejects non-video bases and non-main types', () => {
    expect(isSupportedVideoModel({ base: 'sdxl', format: 'checkpoint', type: 'main' })).toBe(false);
    expect(isSupportedVideoModel({ base: 'wan', format: 'checkpoint', type: 'lora' })).toBe(false);
  });
});

describe('capabilities matrix', () => {
  it('gates conditioning modes per Wan variant', () => {
    expect(getVideoModes(wanModel('t2v_a14b'))).toEqual(['txt2vid']);
    expect(getVideoModes(wanModel('i2v_a14b'))).toEqual(['first-frame', 'first-last', 'extend']);
    expect(getVideoModes(wanModel('ti2v_5b'))).toEqual(['txt2vid', 'first-frame', 'extend']);
  });

  it('gives MiniMax H3 every mode including last-frame-only', () => {
    expect(getVideoModes(h3Model())).toEqual(['txt2vid', 'first-frame', 'last-frame', 'first-last', 'extend']);
  });

  it('grants unknown Wan variants permissive A14B capabilities', () => {
    const unknown = wanModel('some_future_variant');

    expect(getVideoModes(unknown)).toContain('txt2vid');
    expect(getVideoModes(unknown)).toContain('extend');
  });

  it('shapes the sampling UI per family', () => {
    const a14b = getVideoModelPolicy(wanModel('i2v_a14b'), settingsFor(wanModel('i2v_a14b')));
    const ti2v = getVideoModelPolicy(wanModel('ti2v_5b'), settingsFor(wanModel('ti2v_5b')));
    const h3 = getVideoModelPolicy(h3Model(), settingsFor(h3Model()));

    expect(a14b.ui).toMatchObject({ cfgLowNoiseVisible: true, cfgVisible: true, fpsVisible: true });
    expect(a14b.ui.accelerator).toMatchObject({ label: 'Lightning', steps: 4 });
    expect(a14b.frames).toMatchObject({ defaultValue: 81, kind: 'grid', step: 4 });

    expect(ti2v.ui).toMatchObject({ accelerator: null, cfgLowNoiseVisible: false, cfgVisible: true });

    expect(h3.ui).toMatchObject({
      audioOutput: true,
      cfgLowNoiseVisible: false,
      cfgVisible: false,
      fpsVisible: false,
    });
    expect(h3.ui.accelerator).toMatchObject({ label: 'Turbo', steps: 6 });
    expect(h3.frames.kind).toBe('choices');
    expect(h3.fps).toMatchObject({ defaultValue: 24, editable: false });
    expect(h3.defaults.steps).toBe(50);
  });
});

describe('frame snapping per model', () => {
  it('snaps to the Wan 4n + 1 grid and the H3 choice list respectively', () => {
    expect(snapVideoNumFrames(wanModel('t2v_a14b'), 80)).toBe(81);
    expect(snapVideoNumFrames(h3Model(), 81)).toBe(90);
    expect(isValidVideoNumFrames(wanModel('t2v_a14b'), 81)).toBe(true);
    expect(isValidVideoNumFrames(h3Model(), 81)).toBe(false);
    expect(isValidVideoNumFrames(h3Model(), 124)).toBe(true);
  });
});

describe('getVideoDimensions', () => {
  it('derives from the aspect-ratio preset in text-to-video', () => {
    const model = wanModel('t2v_a14b');

    expect(getVideoDimensions(model, settingsFor(model, { aspectRatioId: '16:9', targetResolution: '480p' }))).toEqual({
      height: 480,
      source: 'aspect-ratio',
      width: 848,
    });
  });

  it('derives from conditioning media once it is set, ignoring the preset ratio', () => {
    const model = wanModel('i2v_a14b');
    const settings = settingsFor(model, {
      aspectRatioId: '1:1',
      firstFrameImage: FIRST_FRAME,
      targetResolution: '720p',
    });

    expect(getVideoDimensions(model, settings)).toEqual({ height: 720, source: 'first-frame', width: 1280 });
  });

  it('prefers the source video over frame images, and last frame over the preset', () => {
    const model = h3Model();

    expect(
      getVideoDimensions(model, settingsFor(model, { lastFrameImage: LAST_FRAME, sourceVideo: SOURCE_VIDEO }))?.source
    ).toBe('source-video');
    expect(getVideoDimensions(model, settingsFor(model, { lastFrameImage: LAST_FRAME }))?.source).toBe('last-frame');
  });

  it('applies the H3 canvas policy including the area cap', () => {
    const model = h3Model();

    expect(getVideoDimensions(model, settingsFor(model, { aspectRatioId: '16:9' }))).toEqual({
      height: 768,
      source: 'aspect-ratio',
      width: 1344,
    });
  });

  it('coerces a stale target resolution from another family before resolving', () => {
    const model = h3Model();
    const settings = settingsFor(model, { targetResolution: '480p' });

    expect(getVideoDimensions(model, settings)).toEqual({ height: 768, source: 'aspect-ratio', width: 1344 });
  });

  it('returns null for media outside the H3 aspect range', () => {
    const model = h3Model();
    const settings = settingsFor(model, {
      firstFrameImage: { height: 100, image_name: 'strip.png', width: 500 },
    });

    expect(getVideoDimensions(model, settings)).toBeNull();
  });
});

describe('getVideoPromptPolicy', () => {
  const promptSettings = (overrides: Partial<Parameters<typeof getVideoPromptPolicy>[1]> = {}) => ({
    cfgScale: 5,
    cfgScaleLowNoise: null,
    negativePromptEnabled: true,
    wanLowNoiseModel: null,
    ...overrides,
  });

  it('is cfg-gated for Wan', () => {
    const model = wanModel('t2v_a14b');

    const atCfg5 = getVideoPromptPolicy(model, promptSettings());
    const atCfg1 = getVideoPromptPolicy(model, promptSettings({ cfgScale: 1 }));

    expect(atCfg5).toMatchObject({ negativeUsedInGraph: true, negativeVisible: true });
    expect(atCfg1).toMatchObject({ negativeUsedInGraph: false, negativeVisible: true });
    expect(atCfg1.negativeHelpText).toMatch(/CFG/);
  });

  it('counts low-noise CFG > 1 as CFG in use, matching wan_video_denoise do_cfg', () => {
    const singleFileMain = wanModel('i2v_a14b', 'gguf_quantized');
    const lowExpert = wanModel('i2v_a14b', 'checkpoint', 'low-expert');
    const base = promptSettings({ cfgScale: 1, cfgScaleLowNoise: 4 });

    // Low expert wired → the low-noise half runs CFG and consumes the negative prompt.
    expect(getVideoPromptPolicy(singleFileMain, { ...base, wanLowNoiseModel: lowExpert }).negativeUsedInGraph).toBe(
      true
    );
    // Diffusers A14B mains bundle transformer_2, so the low half exists without a wired expert.
    expect(getVideoPromptPolicy(wanModel('i2v_a14b', 'diffusers'), base).negativeUsedInGraph).toBe(true);
    // No second expert at all → the low CFG value never runs.
    expect(getVideoPromptPolicy(singleFileMain, base).negativeUsedInGraph).toBe(false);
    // TI2V-5B has no low-noise half regardless of the stale value.
    expect(getVideoPromptPolicy(wanModel('ti2v_5b', 'diffusers'), base).negativeUsedInGraph).toBe(false);
  });

  it('never shows a negative prompt for MiniMax H3', () => {
    expect(getVideoPromptPolicy(h3Model(), promptSettings())).toMatchObject({
      negativeUsedInGraph: false,
      negativeVisible: false,
    });
  });
});

describe('Lightning', () => {
  const model = wanModel('t2v_a14b');
  const catalog = [LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW, LIGHTNING_I2V_HIGH, LIGHTNING_I2V_LOW, lora('Style LoRA')];

  it('finds the installed pair, preferring the main model’s family', () => {
    expect(findWanLightningLoraPair(catalog, 't2v_a14b')).toMatchObject({
      high: { key: LIGHTNING_T2V_HIGH.key },
      low: { key: LIGHTNING_T2V_LOW.key },
    });
    expect(findWanLightningLoraPair(catalog, 'i2v_a14b')).toMatchObject({
      high: { key: LIGHTNING_I2V_HIGH.key },
      low: { key: LIGHTNING_I2V_LOW.key },
    });
  });

  it('falls back across families and rejects incomplete pairs', () => {
    expect(findWanLightningLoraPair([LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW], 'i2v_a14b')).not.toBeNull();
    expect(findWanLightningLoraPair([LIGHTNING_T2V_HIGH], 't2v_a14b')).toBeNull();
    // 5B mains never match the A14B Lightning LoRAs.
    expect(findWanLightningLoraPair(catalog, 'ti2v_5b')).toBeNull();
  });

  it('matches high/low only as delimited tokens, not inside ordinary words', () => {
    // "Slow" must not read as a low-noise expert; the pair is incomplete.
    expect(findWanLightningLoraPair([LIGHTNING_T2V_HIGH, lora('Wan Slow Motion Lightning')], 't2v_a14b')).toBeNull();
    expect(findWanLightningLoraPair([lora('Thigh-Focus Lightning'), LIGHTNING_T2V_LOW], 't2v_a14b')).toBeNull();
    // Underscore-delimited release filenames still match.
    expect(
      findWanLightningLoraPair(
        [lora('Wan2.2-Lightning_high_noise_model'), lora('Wan2.2-Lightning_low_noise_model')],
        't2v_a14b'
      )
    ).not.toBeNull();
  });

  it("does not let 'i2v' score inside 'TI2V' when preferring a family", () => {
    // A mistagged (variant-less) TI2V-named pair listed first must not outrank
    // the true I2V pair for an I2V main.
    const ti2vHigh = lora('Wan Lightning TI2V-5B High Noise', null);
    const ti2vLow = lora('Wan Lightning TI2V-5B Low Noise', null);

    expect(
      findWanLightningLoraPair([ti2vHigh, ti2vLow, LIGHTNING_I2V_HIGH, LIGHTNING_I2V_LOW], 'i2v_a14b')
    ).toMatchObject({
      high: { key: LIGHTNING_I2V_HIGH.key },
      low: { key: LIGHTNING_I2V_LOW.key },
    });
  });

  it('toggling on patches sampling and adds the pair to the visible LoRA list', () => {
    const base = settingsFor(model, {
      cfgScale: 5,
      cfgScaleLowNoise: 4,
      acceleratorEnabled: false,
      loras: [],
      steps: 40,
    });
    const result = getAcceleratorToggleResult(base, model, catalog, true);

    expect(result.missingLoras).toBe(false);
    expect(result.settings).toMatchObject({ acceleratorEnabled: true, cfgScale: 1, cfgScaleLowNoise: 1, steps: 4 });
    expect(result.settings.loras.map((entry) => entry.model.key)).toEqual([
      LIGHTNING_T2V_HIGH.key,
      LIGHTNING_T2V_LOW.key,
    ]);
  });

  it('toggling off removes only the Lightning LoRAs and restores model defaults', () => {
    const on = getAcceleratorToggleResult(settingsFor(model), model, catalog, true).settings;
    const withStyle = { ...on, loras: [...on.loras, { isEnabled: true, model: lora('Style LoRA'), weight: 0.5 }] };
    const off = getAcceleratorToggleResult(withStyle as VideoSettings, model, catalog, false).settings;

    expect(off.acceleratorEnabled).toBe(false);
    expect(off).toMatchObject({ cfgScale: 5, cfgScaleLowNoise: 4, steps: 40 });
    expect(off.loras.map((entry) => entry.model.name)).toEqual(['Style LoRA']);
  });

  it('reports a missing pair instead of enabling silently', () => {
    const result = getAcceleratorToggleResult(settingsFor(model), model, [], true);

    expect(result.missingLoras).toBe(true);
    expect(result.settings.acceleratorEnabled).toBe(false);
  });

  it('clears a stale enabled flag when the pair has vanished from the catalog', () => {
    const stale = settingsFor(model, { acceleratorEnabled: true, steps: 4 });
    const result = getAcceleratorToggleResult(stale, model, [], true);

    expect(result.missingLoras).toBe(true);
    expect(result.settings.acceleratorEnabled).toBe(false);
  });

  it('defaults Lightning on for A14B when the pair is installed, off otherwise', () => {
    const withPair = getDefaultVideoSettings(model, catalog);
    const withoutPair = getDefaultVideoSettings(model, []);
    const h3Defaults = getDefaultVideoSettings(h3Model(), catalog);

    expect(withPair.acceleratorEnabled).toBe(true);
    expect(withPair.steps).toBe(WAN_LIGHTNING_ACCELERATOR.steps);
    expect(withoutPair).toMatchObject({ cfgScale: 5, acceleratorEnabled: false, steps: 40 });
    // The catalog holds no H3 Turbo LoRA, so H3 falls back to its slow defaults.
    expect(h3Defaults).toMatchObject({ fps: 24, acceleratorEnabled: false, numFrames: 124, steps: 50 });
  });
});

describe('MiniMax H3 Turbo', () => {
  const TURBO = { base: 'minimax-h3', key: 'turbo', name: 'MiniMax H3 Turbo LoRA', type: 'lora' as const };
  // The second installed Turbo LoRA: same family, a different step schedule,
  // and nothing but the org name in it to say so.
  const LIGHTX2V = {
    base: 'minimax-h3',
    key: 'lightx2v',
    name: 'MiniMax H3 LightX2V Turbo LoRA',
    type: 'lora' as const,
  };
  const H3_CATALOG = [TURBO, LIGHTX2V];

  it('finds the installed Turbo LoRA by name, ignoring Wan Lightning models', () => {
    expect(findMiniMaxH3TurboLora([LIGHTNING_T2V_HIGH, TURBO])).toMatchObject({ key: 'turbo' });
    expect(findMiniMaxH3TurboLora([LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW])).toBeNull();
  });

  it('defaults Turbo on for H3 when installed, matching the bundled templates (steps 6)', () => {
    const defaults = getDefaultVideoSettings(h3Model(), [TURBO]);

    expect(defaults).toMatchObject({ acceleratorEnabled: true, steps: 6 });
    expect(defaults.loras.map((entry) => entry.model.key)).toEqual(['turbo']);
  });

  it('toggling off restores the slow 50-step default and removes the Turbo LoRA', () => {
    const on = getDefaultVideoSettings(h3Model(), [TURBO]);
    const off = getAcceleratorToggleResult(on, h3Model(), [TURBO], false).settings;

    expect(off).toMatchObject({ acceleratorEnabled: false, steps: 50 });
    expect(off.loras).toEqual([]);
  });

  it('prefers the family-named Turbo repack over a look-alike, deterministically', () => {
    const turboRider = { base: 'minimax-h3', key: 'rider', name: 'Turbo Rider', type: 'lora' as const };

    expect(findMiniMaxH3TurboLora([turboRider, TURBO])).toMatchObject({ key: 'turbo' });
    expect(findMiniMaxH3TurboLora([TURBO, turboRider])).toMatchObject({ key: 'turbo' });
  });

  it('never auto-picks a Ref2VA-trained turbo LoRA for FL2VA generation', () => {
    // The Ref2V Turbo repack is trained against the Ref2VA transformer only; despite sorting
    // before "MiniMax H3 Turbo LoRA" and matching the family+turbo patterns, it must lose.
    const ref2vTurbo = { base: 'minimax-h3', key: 'ref2v', name: 'MiniMax H3 Ref2V Turbo LoRA', type: 'lora' as const };
    const ref2vFile = {
      base: 'minimax-h3',
      key: 'ref2v-file',
      name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16',
      type: 'lora' as const,
    };

    expect(findMiniMaxH3TurboLora([ref2vTurbo, TURBO])).toMatchObject({ key: 'turbo' });
    expect(findMiniMaxH3TurboLora([ref2vTurbo])).toBeNull();
    expect(findMiniMaxH3TurboLora([ref2vFile])).toBeNull();
  });

  it('never strips a user LoRA that merely shares an accelerator-style name', () => {
    const turboRider = { base: 'minimax-h3', key: 'rider', name: 'Turbo Rider', type: 'lora' as const };
    const model = h3Model();
    const catalog = [TURBO, turboRider];
    const on = getAcceleratorToggleResult(settingsFor(model), model, catalog, true).settings;
    const withRider = {
      ...on,
      loras: [...on.loras, { isEnabled: true, model: turboRider as never, weight: 0.8 }],
    };
    const off = getAcceleratorToggleResult(withRider as VideoSettings, model, catalog, false).settings;

    // Only the recorded Turbo entry is removed; "Turbo Rider" is the user's.
    expect(off.loras.map((entry) => entry.model.key)).toEqual(['rider']);
    expect(off.acceleratorLoraKeys).toEqual([]);
  });

  it('runs the LightX2V release at the 8 steps it was distilled for, not the repack default of 6', () => {
    const model = h3Model();
    const on = getAcceleratorToggleResult(settingsFor(model), model, [LIGHTX2V], true).settings;

    expect(on).toMatchObject({ acceleratorEnabled: true, steps: 8 });
    expect(on.acceleratorLoraKeys).toEqual([LIGHTX2V.key]);
    // The help text quotes the running LoRA's count; `ui.accelerator` stays the
    // family config, so callers can still resolve other counts against it.
    expect(getVideoModelPolicy(model, on).ui).toMatchObject({ acceleratorSteps: 8 });
    expect(getVideoModelPolicy(model, on).ui.accelerator).toMatchObject({ label: 'Turbo', steps: 6 });
  });

  it('re-anchors the fast path on the other Turbo LoRA instead of tearing it down', () => {
    const model = h3Model();
    // Both are installed, so the toggle picks one; the user then swaps in the
    // other by enabling it and switching the first off.
    const on = getAcceleratorToggleResult(settingsFor(model), model, H3_CATALOG, true).settings;

    expect(on.acceleratorLoraKeys).toEqual([LIGHTX2V.key]);

    const swapped = getAcceleratorLoraChangeResult(on, model, H3_CATALOG, [
      { isEnabled: false, model: LIGHTX2V as never, weight: 1 },
      { isEnabled: true, model: TURBO as never, weight: 1 },
    ]);

    expect(swapped.outcome).toBe('switched');
    expect(swapped.settings).toMatchObject({ acceleratorEnabled: true, cfgScale: 1, steps: 6 });
    expect(swapped.settings.acceleratorLoraKeys).toEqual([TURBO.key]);
    expect(swapped.acceleratorLoras?.map((entry) => entry.key)).toEqual([TURBO.key]);
  });

  it('never arms an off fast path from a list edit, whatever lands in the list', () => {
    const model = h3Model();
    const turboRider = { base: 'minimax-h3', key: 'rider', name: 'Turbo Rider', type: 'lora' as const };
    // A user's own H3 LoRA satisfies the family-name test as readily as a real
    // repack does, and a hand-tuned step count must survive an unrelated edit.
    const own = { base: 'minimax-h3', key: 'mine', name: 'My H3 Turbo Sharpener', type: 'lora' as const };
    const off = settingsFor(model, { steps: 12 });

    for (const candidate of [TURBO, LIGHTX2V, turboRider, own]) {
      const result = getAcceleratorLoraChangeResult(off, model, H3_CATALOG, [
        { isEnabled: true, model: candidate as never, weight: 1 },
      ]);

      expect(result.outcome).toBe('unchanged');
      expect(result.settings).toMatchObject({ acceleratorEnabled: false, steps: 12 });
    }
  });

  it('installs the catalog Turbo LoRA on toggle-on, never a user LoRA that is merely H3-named', () => {
    const model = h3Model();
    const own = { base: 'minimax-h3', key: 'mine', name: 'My H3 Turbo Sharpener', type: 'lora' as const };
    const withOwn = settingsFor(model, { loras: [{ isEnabled: true, model: own as never, weight: 0.4 }] });
    const on = getAcceleratorToggleResult(withOwn, model, [TURBO, own], true).settings;

    expect(on.acceleratorLoraKeys).toEqual([TURBO.key]);
    expect(on.steps).toBe(6);
    // ...and the user's own entry keeps its weight rather than being co-opted.
    expect(on.loras.find((entry) => entry.model.key === 'mine')?.weight).toBe(0.4);
  });

  it('keeps an oddly named Turbo LoRA running while it is the only one installed', () => {
    const model = h3Model();
    const turboRider = { base: 'minimax-h3', key: 'rider', name: 'Turbo Rider', type: 'lora' as const };
    const on = getDefaultVideoSettings(model, [turboRider]);

    expect(on.acceleratorLoraKeys).toEqual(['rider']);

    // An unrelated list edit must not tear down a fast path that is still on.
    const result = getAcceleratorLoraChangeResult(
      on,
      model,
      [turboRider],
      [...on.loras, { isEnabled: true, model: lora('Style LoRA') as never, weight: 0.5 }]
    );

    expect(result.outcome).toBe('unchanged');
    expect(result.settings.acceleratorEnabled).toBe(true);
  });

  it('turns the fast path off with the model defaults when no Turbo LoRA is left enabled', () => {
    const model = h3Model();
    const on = getDefaultVideoSettings(model, [TURBO]);
    const result = getAcceleratorLoraChangeResult(on, model, H3_CATALOG, []);

    expect(result.outcome).toBe('disabled');
    expect(result.settings).toMatchObject({ acceleratorEnabled: false, steps: 50 });
  });

  it('leaves user-tuned steps alone while its own LoRA is still enabled', () => {
    const model = h3Model();
    const on = { ...getDefaultVideoSettings(model, [TURBO]), steps: 9 };
    const result = getAcceleratorLoraChangeResult(on, model, H3_CATALOG, [
      ...on.loras,
      { isEnabled: true, model: lora('Style LoRA') as never, weight: 0.5 },
    ]);

    expect(result.outcome).toBe('unchanged');
    expect(result.settings).toMatchObject({ acceleratorEnabled: true, steps: 9 });
  });

  it('stays intact through a duplicated LoRA entry, so an unchanged value reconciles to itself', () => {
    const model = h3Model();
    const on = getDefaultVideoSettings(model, [TURBO]);
    // A hand-edited project file (or metadata whose graph listed one twice)
    // can hold the same key twice; the flag must not read as broken.
    const duplicated = [...on.loras, ...on.loras];
    const once = getAcceleratorLoraChangeResult(on, model, [TURBO], duplicated);
    const twice = getAcceleratorLoraChangeResult(once.settings, model, [TURBO], duplicated);

    expect(once.outcome).toBe('unchanged');
    expect(twice.outcome).toBe('unchanged');
    expect(twice.settings.acceleratorLoraKeys).toBe(on.acceleratorLoraKeys);
  });

  it('rejects a Lightning pair that does not name the family, even with no family token to check', () => {
    // The fallback variant has no variant string, so there is no token to
    // demand — the list-scoped lookup must fail closed rather than accept any
    // Lightning-named pair the user happens to hold.
    const fallbackMain = wanModel('', 'gguf_quantized', 'wan-unprobed');
    const mine = [
      lora('Personal Lightning High Detail', null, 'myh'),
      lora('Personal Lightning Low Detail', null, 'myl'),
    ];

    expect(findWanLightningLoraPair(mine, fallbackMain.variant, { requireFamilyName: true })).toBeNull();
    // Unrestricted (the catalog question) it still resolves, as before.
    expect(findWanLightningLoraPair(mine, fallbackMain.variant)).toMatchObject({ high: { key: 'myh' } });
  });

  it('swaps a T2V Lightning pair for the I2V one when the main changes family', () => {
    const catalog = [LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW, LIGHTNING_I2V_HIGH, LIGHTNING_I2V_LOW];
    const t2v = wanModel('t2v_a14b');
    const on = getAcceleratorToggleResult(settingsFor(t2v), t2v, catalog, true).settings;
    const result = getVideoModelSelectionResult({
      currentSettings: on,
      model: wanModel('i2v_a14b'),
      models: catalog,
    });

    expect(result.settings.acceleratorLoraKeys).toEqual([LIGHTNING_I2V_HIGH.key, LIGHTNING_I2V_LOW.key]);
    expect(result.clearedLabels).toContain('Acceleration');
  });

  it('carries the fast-path intent across a family switch (Lightning → Turbo)', () => {
    const wan = wanModel('t2v_a14b');
    const catalog = [LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW, TURBO];
    const lightningOn = getAcceleratorToggleResult(settingsFor(wan), wan, catalog, true).settings;
    const result = getVideoModelSelectionResult({ currentSettings: lightningOn, model: h3Model(), models: catalog });

    expect(result.settings.acceleratorEnabled).toBe(true);
    expect(result.settings.steps).toBe(6);
    expect(result.settings.loras.map((entry) => entry.model.key)).toEqual(['turbo']);
    expect(result.clearedLabels).toContain('Acceleration');
  });
});

describe('component section policy', () => {
  it('requires VAE and Wan T5 for split Wan models without a component source', () => {
    const model = wanModel('i2v_a14b', 'gguf_quantized');
    const settings = settingsFor(model);
    const policy = getVideoComponentSectionPolicy(model, settings);

    expect(policy.defaultOpen).toBe(true);
    expect(policy.slots.map((slot) => slot.key)).toEqual([
      'componentSourceModel',
      'vae',
      'wanT5EncoderModel',
      'wanLowNoiseModel',
    ]);

    const reasons = getVideoValidationReasons(model, { ...settings, firstFrameImage: FIRST_FRAME });

    expect(reasons).toContain('Video needs a VAE for Wan models.');
    expect(reasons).toContain('Video needs a Wan T5 Encoder for Wan models.');
  });

  it('is satisfied by a Diffusers component source or a Diffusers main', () => {
    const gguf = wanModel('i2v_a14b', 'gguf_quantized');
    const withSource = settingsFor(gguf, {
      componentSourceModel: wanModel('i2v_a14b', 'diffusers'),
      firstFrameImage: FIRST_FRAME,
    });

    expect(getVideoValidationReasons(gguf, withSource)).toEqual([]);

    const diffusers = wanModel('i2v_a14b', 'diffusers');

    expect(getVideoValidationReasons(diffusers, settingsFor(diffusers, { firstFrameImage: FIRST_FRAME }))).toEqual([]);
  });

  it('hides the low-noise expert slot for TI2V-5B and for Diffusers mains', () => {
    const ti2v = wanModel('ti2v_5b', 'checkpoint');

    expect(getVideoComponentSectionPolicy(ti2v, settingsFor(ti2v)).slots.map((slot) => slot.key)).not.toContain(
      'wanLowNoiseModel'
    );

    // A Diffusers A14B main bundles transformer_2; the loader ignores the input.
    const diffusers = wanModel('i2v_a14b', 'diffusers');

    expect(
      getVideoComponentSectionPolicy(diffusers, settingsFor(diffusers)).slots.map((slot) => slot.key)
    ).not.toContain('wanLowNoiseModel');
  });

  it('requires a component source (and a conditional text encoder) for a single-file H3 main', () => {
    // The single-file checkpoint carries only the transformer; the loader
    // sources tokenizer/processor/VAEs from a Diffusers install in the Model
    // Components slot. A components-only source has no text-encoder weights,
    // so the single-file Qwen3-VL encoder becomes required with it.
    const checkpoint = h3Model('checkpoint');
    const bare = settingsFor(checkpoint);
    const componentsOnly = { ...h3Model('diffusers', 'h3-components'), components_only: true };
    const encoder = { base: 'minimax-h3', key: 'h3-te-int8', name: 'H3 Text Encoder', type: 'qwen3_vl_encoder' };

    expect(getVideoComponentSectionPolicy(checkpoint, bare).defaultOpen).toBe(true);
    expect(getVideoComponentSectionPolicy(checkpoint, bare).slots.map((slot) => slot.key)).toEqual([
      'componentSourceModel',
      'h3TextEncoderModel',
    ]);

    expect(getVideoValidationReasons(checkpoint, bare)).toContainEqual(
      expect.stringContaining('select a Diffusers MiniMax H3 install under Model Components')
    );

    // A full Diffusers source alone satisfies both slots.
    expect(getVideoValidationReasons(checkpoint, settingsFor(checkpoint, { componentSourceModel: h3Model() }))).toEqual(
      []
    );

    // A components-only source still needs the single-file encoder.
    expect(
      getVideoValidationReasons(checkpoint, settingsFor(checkpoint, { componentSourceModel: componentsOnly }))
    ).toContainEqual(expect.stringContaining('select a single-file Text encoder'));
    expect(
      getVideoValidationReasons(
        checkpoint,
        settingsFor(checkpoint, { componentSourceModel: componentsOnly, h3TextEncoderModel: encoder })
      )
    ).toEqual([]);

    // The source slot lists only Diffusers H3 installs.
    const slot = getVideoComponentSectionPolicy(checkpoint, bare).slots[0];
    const ctx = { model: checkpoint, selectedComponents: bare, settings: bare };

    expect(slot?.filter?.(h3Model(), ctx)).toBe(true);
    expect(slot?.filter?.(componentsOnly, ctx)).toBe(true);
    expect(slot?.filter?.(h3Model('checkpoint', 'other-ckpt'), ctx)).toBe(false);
    expect(slot?.filter?.(wanModel('i2v_a14b', 'diffusers'), ctx)).toBe(false);

    // A full Diffusers install at top needs nothing.
    const full = h3Model();

    expect(getVideoValidationReasons(full, settingsFor(full))).toEqual([]);
    expect(getVideoComponentSectionPolicy(full, settingsFor(full)).defaultOpen).toBe(false);
  });

  it('steers a legacy components-only H3 main at top toward the checkpoint-as-model shape', () => {
    const componentsOnly = { ...h3Model(), components_only: true };

    expect(getVideoValidationReasons(componentsOnly, settingsFor(componentsOnly))).toEqual([
      expect.stringContaining('Select a single-file MiniMax H3 transformer as the model'),
    ]);
    // The Ref2VA folder install cannot folder-load its transformer weights.
    const ref2vaFolder = { ...h3Model(), variant: 'ref2va' };

    expect(getVideoValidationReasons(ref2vaFolder, settingsFor(ref2vaFolder))).toEqual([
      expect.stringContaining('Select a single-file Ref2VA transformer as the model'),
    ]);
  });

  it('offers the component-source slot only for single-file mains, never listing the main itself', () => {
    const diffusers = wanModel('i2v_a14b', 'diffusers');

    expect(
      getVideoComponentSectionPolicy(diffusers, settingsFor(diffusers)).slots.map((slot) => slot.key)
    ).not.toContain('componentSourceModel');

    const gguf = wanModel('i2v_a14b', 'gguf_quantized');
    const settings = settingsFor(gguf);
    const slot = getVideoComponentSectionPolicy(gguf, settings).slots.find((s) => s.key === 'componentSourceModel');
    const ctx = { model: gguf, selectedComponents: settings, settings };

    expect(slot?.filter?.(wanModel('i2v_a14b', 'diffusers'), ctx)).toBe(true);
    // A (hypothetical) diffusers-format selected main must not list itself.
    expect(slot?.filter?.({ ...gguf, format: 'diffusers' }, { ...ctx, model: { ...gguf, format: 'diffusers' } })).toBe(
      false
    );
  });

  it('constrains the low-noise expert to a different single-file model of the same variant', () => {
    const model = wanModel('i2v_a14b', 'gguf_quantized');
    const settings = settingsFor(model);
    const slot = getVideoComponentSectionPolicy(model, settings).slots.find((s) => s.key === 'wanLowNoiseModel');
    const ctx = { model, selectedComponents: settings, settings };

    expect(slot?.filter?.(wanModel('i2v_a14b', 'checkpoint', 'low'), ctx)).toBe(true);
    // Same model as the main is rejected (loader raises on identical keys).
    expect(slot?.filter?.(model, ctx)).toBe(false);
    // Diffusers-format experts are rejected (loader requires single-file).
    expect(slot?.filter?.(wanModel('i2v_a14b', 'diffusers'), ctx)).toBe(false);
    // Cross-variant experts are rejected (loader requires exact variant equality).
    expect(slot?.filter?.(wanModel('t2v_a14b', 'checkpoint'), ctx)).toBe(false);
    // Unknown variants stay allowed — the backend probe is the authority.
    expect(slot?.filter?.({ ...wanModel('i2v_a14b', 'checkpoint', 'untagged'), variant: null }, ctx)).toBe(true);
  });

  it('matches the standalone VAE to the main variant by latent channels', () => {
    const a14b = wanModel('i2v_a14b', 'gguf_quantized');
    const ti2v = wanModel('ti2v_5b', 'checkpoint');
    const vae16 = { base: 'wan', key: 'vae16', latent_channels: 16, name: 'Wan 2.1 VAE', type: 'vae' };
    const vae48 = { base: 'wan', key: 'vae48', latent_channels: 48, name: 'Wan 2.2 VAE', type: 'vae' };
    const vaeUnknown = { base: 'wan', key: 'vae?', name: 'Mystery Wan VAE', type: 'vae' };

    const slotFor = (model: MainModelConfig) => {
      const settings = settingsFor(model);

      return {
        ctx: { model, selectedComponents: settings, settings },
        slot: getVideoComponentSectionPolicy(model, settings).slots.find((s) => s.key === 'vae'),
      };
    };

    const forA14b = slotFor(a14b);
    const forTi2v = slotFor(ti2v);

    expect(forA14b.slot?.filter?.(vae16, forA14b.ctx)).toBe(true);
    expect(forA14b.slot?.filter?.(vae48, forA14b.ctx)).toBe(false);
    expect(forTi2v.slot?.filter?.(vae48, forTi2v.ctx)).toBe(true);
    expect(forTi2v.slot?.filter?.(vae16, forTi2v.ctx)).toBe(false);
    // Configs without the field (open union) stay allowed on both.
    expect(forA14b.slot?.filter?.(vaeUnknown, forA14b.ctx)).toBe(true);
    expect(forTi2v.slot?.filter?.(vaeUnknown, forTi2v.ctx)).toBe(true);
  });

  it('a cross-family component source covers the encoder but not the VAE', () => {
    // TI2V-5B main with an A14B Diffusers source: UMT5 is shared (encoder
    // satisfied) but the VAE is family-bound, so a VAE is still required.
    const model = wanModel('ti2v_5b', 'checkpoint');
    const settings = settingsFor(model, { componentSourceModel: wanModel('i2v_a14b', 'diffusers') });
    const reasons = getVideoValidationReasons(model, settings);

    expect(reasons).toContain('Video needs a VAE for Wan models.');
    expect(reasons).not.toContain('Video needs a Wan T5 Encoder for Wan models.');
  });

  it('offers only the optional text-encoder override for a full Diffusers H3 main', () => {
    const model = h3Model();
    const policy = getVideoComponentSectionPolicy(model, settingsFor(model));

    expect(policy.defaultOpen).toBe(false);
    expect(policy.slots.map((slot) => slot.key)).toEqual(['h3TextEncoderModel']);
    expect(policy.slots.every((slot) => !slot.required)).toBe(true);
  });
});

describe('getWanExpertWiringWarning', () => {
  const tagged = (variant: string, expert: 'high' | 'low' | 'none', key: string): MainModelConfig => ({
    ...wanModel(variant, 'gguf_quantized', key),
    expert,
  });

  it('flags swapped, mislabeled, and single-low wirings on single-file A14B mains', () => {
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'low', 'm'), tagged('i2v_a14b', 'high', 'l'))).toEqual({
      kind: 'swapped',
    });
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'none', 'm'), tagged('i2v_a14b', 'high', 'l'))).toEqual({
      kind: 'high-as-low',
    });
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'low', 'm'), tagged('i2v_a14b', 'none', 'l'))).toEqual({
      kind: 'low-as-main',
    });
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'low', 'm'), null)).toEqual({ kind: 'single-low' });
  });

  it('keeps warning after a role exchange of a same-tag pair, so no swap is offered', () => {
    // high+high and low+low pairs re-warn with roles exchanged — the UI uses
    // this simulation to withhold the Swap button rather than loop.
    const highPair = [tagged('i2v_a14b', 'high', 'm'), tagged('i2v_a14b', 'high', 'l')] as const;
    const lowPair = [tagged('i2v_a14b', 'low', 'm'), tagged('i2v_a14b', 'low', 'l')] as const;

    expect(getWanExpertWiringWarning(highPair[0], highPair[1])).toEqual({ kind: 'high-as-low' });
    expect(getWanExpertWiringWarning(highPair[1], highPair[0])).toEqual({ kind: 'high-as-low' });
    expect(getWanExpertWiringWarning(lowPair[0], lowPair[1])).toEqual({ kind: 'low-as-main' });
    expect(getWanExpertWiringWarning(lowPair[1], lowPair[0])).toEqual({ kind: 'low-as-main' });
    // Every swappable kind resolves when roles are exchanged.
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'high', 'l'), tagged('i2v_a14b', 'low', 'm'))).toBeNull();
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'high', 'l'), tagged('i2v_a14b', 'none', 'm'))).toBeNull();
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'none', 'l'), tagged('i2v_a14b', 'low', 'm'))).toBeNull();
  });

  it('stays silent for correct, untagged, Diffusers, TI2V-5B, and non-Wan wirings', () => {
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'high', 'm'), tagged('i2v_a14b', 'low', 'l'))).toBeNull();
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'none', 'm'), tagged('i2v_a14b', 'none', 'l'))).toBeNull();
    expect(getWanExpertWiringWarning(tagged('i2v_a14b', 'high', 'm'), null)).toBeNull();
    expect(getWanExpertWiringWarning(wanModel('i2v_a14b', 'diffusers'), null)).toBeNull();
    expect(getWanExpertWiringWarning(tagged('ti2v_5b', 'low', 'm'), null)).toBeNull();
    expect(getWanExpertWiringWarning(h3Model(), null)).toBeNull();
    expect(getWanExpertWiringWarning(null, null)).toBeNull();
  });
});

describe('getVideoModelSelectionResult', () => {
  it('clears conditioning media the new model cannot consume', () => {
    const from = settingsFor(wanModel('i2v_a14b'), {
      firstFrameImage: FIRST_FRAME,
      lastFrameImage: LAST_FRAME,
      acceleratorEnabled: false,
    });
    const result = getVideoModelSelectionResult({
      currentSettings: from,
      model: wanModel('t2v_a14b'),
      models: [],
    });

    expect(result.settings.firstFrameImage).toBeNull();
    expect(result.settings.lastFrameImage).toBeNull();
    expect(result.clearedLabels).toContain('First frame');
    expect(result.clearedLabels).toContain('Last frame');
  });

  it('keeps a first+last pair on a model with FLF2V, but drops the last frame on TI2V-5B', () => {
    const from = settingsFor(wanModel('i2v_a14b'), { firstFrameImage: FIRST_FRAME, lastFrameImage: LAST_FRAME });

    const toH3 = getVideoModelSelectionResult({ currentSettings: from, model: h3Model(), models: [] });

    expect(toH3.settings.firstFrameImage).toEqual(FIRST_FRAME);
    expect(toH3.settings.lastFrameImage).toEqual(LAST_FRAME);

    const to5b = getVideoModelSelectionResult({ currentSettings: from, model: wanModel('ti2v_5b'), models: [] });

    expect(to5b.settings.firstFrameImage).toEqual(FIRST_FRAME);
    expect(to5b.settings.lastFrameImage).toBeNull();
  });

  it('drops a destination image for extend when the model lacks the end-frame channel', () => {
    const from = settingsFor(wanModel('i2v_a14b'), { lastFrameImage: LAST_FRAME, sourceVideo: SOURCE_VIDEO });
    const to5b = getVideoModelSelectionResult({ currentSettings: from, model: wanModel('ti2v_5b'), models: [] });

    expect(to5b.settings.sourceVideo).toEqual(SOURCE_VIDEO);
    expect(to5b.settings.lastFrameImage).toBeNull();
  });

  it('re-fits presets, frames, fps, Lightning, and components when crossing families', () => {
    const wan = wanModel('t2v_a14b');
    const catalog = [LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW];
    const lightningOn = getAcceleratorToggleResult(settingsFor(wan), wan, catalog, true).settings;
    const from = settingsFor(wan, {
      ...lightningOn,
      loras: [...lightningOn.loras, { isEnabled: true, model: lora('Style LoRA') as never, weight: 0.5 }],
      targetResolution: '480p',
      vae: { base: 'wan', key: 'wan-vae', name: 'Wan VAE', type: 'vae' },
      wanT5EncoderModel: { base: 'any', key: 'umt5', name: 'UMT5-XXL', type: 'wan_t5_encoder' },
    });
    const result = getVideoModelSelectionResult({ currentSettings: from, model: h3Model(), models: catalog });

    expect(result.settings.targetResolution).toBe('768 highres');
    expect(result.settings.numFrames).toBe(90); // 81 snapped onto the H3 grid
    expect(result.settings.fps).toBe(24);
    expect(result.settings.acceleratorEnabled).toBe(false);
    expect(result.settings.steps).toBe(50);
    expect(result.settings.loras).toEqual([]); // wan LoRAs are incompatible with H3
    expect(result.settings.vae).toBeNull();
    expect(result.settings.wanT5EncoderModel).toBeNull();
    expect(result.clearedLabels).toEqual(
      expect.arrayContaining(['Target resolution', 'Frames', 'FPS', 'Acceleration', 'LoRAs', 'VAE', 'Wan T5 Encoder'])
    );
  });

  it('leaves user-tuned sampling and LoRA weights alone when the accelerator carries over unchanged', () => {
    const wan = wanModel('t2v_a14b');
    const catalog = [LIGHTNING_T2V_HIGH, LIGHTNING_T2V_LOW];
    const on = getAcceleratorToggleResult(settingsFor(wan), wan, catalog, true).settings;
    const tuned = {
      ...on,
      cfgScale: 2,
      loras: [
        { ...on.loras[0]!, weight: 0.5 },
        on.loras[1]!,
        { isEnabled: true, model: lora('Style LoRA') as never, weight: 0.7 },
      ],
      steps: 8,
    };
    const result = getVideoModelSelectionResult({
      currentSettings: tuned,
      model: wanModel('t2v_a14b', 'checkpoint'),
      models: catalog,
    });

    // Same accelerator LoRA set on the new model: nothing is re-applied.
    expect(result.settings).toMatchObject({ acceleratorEnabled: true, cfgScale: 2, steps: 8 });
    expect(result.settings.loras[0]?.weight).toBe(0.5);
    expect(result.settings.loras.map((entry) => entry.model.name)).toContain('Style LoRA');
    expect(result.clearedLabels).toEqual([]);
  });

  it('returns no cleared labels when everything carries over', () => {
    const model = wanModel('i2v_a14b');
    const from = settingsFor(model, { firstFrameImage: FIRST_FRAME, acceleratorEnabled: false });
    const result = getVideoModelSelectionResult({
      currentSettings: from,
      model: wanModel('i2v_a14b', 'diffusers'),
      models: [],
    });

    expect(result.clearedLabels).toEqual([]);
    expect(result.settings.modelKey).toBe(wanModel('i2v_a14b', 'diffusers').key);
  });
});

describe('getVideoValidationReasons', () => {
  it('blocks unsupported models', () => {
    const sdxl = { base: 'sdxl', format: 'checkpoint', key: 'sdxl', name: 'SDXL', type: 'main' } as MainModelConfig;

    expect(getVideoValidationReasons(sdxl, settingsFor())).toEqual([
      'Video needs a supported video model before it can be invoked.',
    ]);
  });

  it('reports unsupported modes in plain language', () => {
    const t2v = wanModel('t2v_a14b', 'diffusers');
    const i2v = wanModel('i2v_a14b', 'diffusers');

    expect(getVideoValidationReasons(t2v, settingsFor(t2v, { firstFrameImage: FIRST_FRAME }))).toEqual([
      expect.stringContaining('does not support starting from a first frame'),
    ]);
    expect(getVideoValidationReasons(i2v, settingsFor(i2v))).toEqual([
      expect.stringContaining('does not support text-to-video'),
    ]);
  });

  it('rejects a destination image while extending on TI2V-5B', () => {
    const model = wanModel('ti2v_5b', 'diffusers');
    const settings = settingsFor(model, { lastFrameImage: LAST_FRAME, sourceVideo: SOURCE_VIDEO });

    expect(getVideoValidationReasons(model, settings)).toEqual([
      expect.stringContaining('cannot target a destination image'),
    ]);
  });

  it('rejects the first-frame + initial-video combination', () => {
    const model = wanModel('i2v_a14b', 'diffusers');
    const settings = settingsFor(model, { firstFrameImage: FIRST_FRAME, sourceVideo: SOURCE_VIDEO });

    expect(getVideoValidationReasons(model, settings)).toContainEqual(expect.stringContaining('cannot be combined'));
  });

  it('rejects a Wan extension whose source clip frame rate falls outside 1-120 fps', () => {
    const model = wanModel('i2v_a14b', 'diffusers');

    // wan_l2v/video_concat accept 1-120; an out-of-range clip would fail only
    // AFTER the denoise. A slow-mo clip and an unprobeable sub-1 fps rate both
    // block up front; an ordinary clip raises nothing.
    expect(
      getVideoValidationReasons(model, settingsFor(model, { sourceVideo: { ...SOURCE_VIDEO, fps: 240 } }))
    ).toContainEqual(expect.stringContaining('1-120 fps'));
    expect(
      getVideoValidationReasons(model, settingsFor(model, { sourceVideo: { ...SOURCE_VIDEO, fps: 0.3 } }))
    ).toContainEqual(expect.stringContaining('1-120 fps'));
    expect(getVideoValidationReasons(model, settingsFor(model, { sourceVideo: SOURCE_VIDEO }))).toEqual([]);
  });

  it('validates frames, fps, and steps against the matrix', () => {
    const wan = wanModel('t2v_a14b', 'diffusers');
    const h3 = h3Model();

    expect(getVideoValidationReasons(wan, settingsFor(wan, { numFrames: 80 }))).toEqual([
      expect.stringContaining('4·n + 1'),
    ]);
    expect(getVideoValidationReasons(h3, settingsFor(h3, { numFrames: 100 }))).toEqual([
      expect.stringContaining('17·n + 5'),
    ]);
    expect(getVideoValidationReasons(h3, settingsFor(h3, { fps: 16 }))).toEqual([
      expect.stringContaining('fixed 24 FPS'),
    ]);
    expect(getVideoValidationReasons(wan, settingsFor(wan, { fps: 0 }))).toEqual([
      expect.stringContaining('FPS must be a whole number between'),
    ]);
    expect(getVideoValidationReasons(h3, settingsFor(h3, { steps: 1 }))).toEqual([
      expect.stringContaining('at least 2'),
    ]);
  });

  it('rejects fractional fps and steps — the backend fields are integers', () => {
    const wan = wanModel('t2v_a14b', 'diffusers');

    expect(getVideoValidationReasons(wan, settingsFor(wan, { fps: 12.5 }))).toEqual([
      expect.stringContaining('whole number'),
    ]);
    expect(getVideoValidationReasons(wan, settingsFor(wan, { steps: 4.5 }))).toEqual([
      expect.stringContaining('whole number'),
    ]);
  });

  it('surfaces Wan LoRA family mismatches instead of silently dropping them', () => {
    const model = wanModel('ti2v_5b', 'diffusers');
    const settings = settingsFor(model, {
      loras: [{ isEnabled: true, model: LIGHTNING_T2V_HIGH as never, weight: 1 }],
    });

    expect(getVideoValidationReasons(model, settings)).toEqual([
      expect.stringContaining('targets a different Wan model family'),
    ]);
  });

  it('accepts a fully valid H3 first-frame setup', () => {
    const model = h3Model();

    expect(getVideoValidationReasons(model, settingsFor(model, { firstFrameImage: FIRST_FRAME }))).toEqual([]);
  });
});

describe('getVideoModelAvailabilityReasons', () => {
  it('reports uninstalled selections by label', () => {
    const model = wanModel('i2v_a14b');
    const settings = settingsFor(model, {
      loras: [{ isEnabled: true, model: LIGHTNING_T2V_HIGH as never, weight: 1 }],
      wanT5EncoderModel: { base: 'any', key: 'umt5', name: 'UMT5-XXL', type: 'wan_t5_encoder' },
    });

    const reasons = getVideoModelAvailabilityReasons(model, settings, []);

    expect(reasons).toContainEqual(expect.stringContaining('is no longer installed'));
    expect(reasons.some((reason) => reason.includes('UMT5-XXL'))).toBe(true);
    expect(reasons.some((reason) => reason.includes('Lightning'))).toBe(true);

    const installed = getVideoModelAvailabilityReasons(model, settingsFor(model), [model]);

    expect(installed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ref2VA: model-borne variant, reference mode, transitions

const ref2vaTransformer = (key = 'h3-ref2va-ckpt'): MainModelConfig => ({
  ...h3Model('checkpoint', key),
  name: 'MiniMax H3 Ref2VA Transformer (int8, pruned)',
  variant: 'ref2va',
});

const fl2vaTransformer = (key = 'h3-fl2va-ckpt'): MainModelConfig => ({
  ...h3Model('checkpoint', key),
  name: 'MiniMax H3 FL2VA Transformer (int8, pruned)',
  variant: 'fl2va',
});

const imageReference = { detail: 'max', image: { height: 4, image_name: 'ref.png', width: 4 }, kind: 'image' } as const;

describe('reference mode policy', () => {
  it('a ref2va transformer at top switches the panel to the reference-only mode set', () => {
    const model = ref2vaTransformer();
    const settings = settingsFor(model);

    expect(getVideoModelPolicy(model, settings).modes).toEqual(['reference']);
    expect(getVideoModelPolicy(model, settings).references).toEqual({ extend: true, maxImages: 9, maxVideos: 3 });
    expect(getVideoModelPolicy(h3Model(), settingsFor(h3Model())).references).toBeNull();
  });

  it('an unknown variant still falls back to fl2va, but ref2va never does', () => {
    const unknown = { ...h3Model(), variant: 'novel_task' };

    expect(getVideoModes(unknown)).toContain('txt2vid');
    expect(getVideoModes({ ...h3Model(), variant: 'ref2va' })).toEqual(['reference']);
  });

  it('validates the reference rules', () => {
    const model = ref2vaTransformer();
    // A full Diffusers source keeps the component slots satisfied, so only
    // the reference rules under test can produce reasons.
    const withRefTransformer = (overrides: Partial<VideoSettings>) =>
      settingsFor(model, { componentSourceModel: h3Model(), ...overrides });

    expect(getVideoValidationReasons(model, withRefTransformer({}))).toContain(
      'Reference-to-video needs at least one image or video reference.'
    );
    expect(
      getVideoValidationReasons(
        model,
        withRefTransformer({
          references: [
            {
              clip: {
                endFrame: 10,
                fps: 24,
                height: 4,
                numFrames: 12,
                startFrame: 0,
                video_name: 'ref.mp4',
                width: 4,
              },
              conditioning: 'audio',
              kind: 'video',
            },
          ],
        })
      )
    ).toContain(
      'At least one reference must contribute visuals — add an image, or set a video reference to include video.'
    );
    expect(getVideoValidationReasons(model, withRefTransformer({ references: [imageReference] }))).toEqual([]);
  });

  it('rejects references on an fl2va panel', () => {
    const model = h3Model();
    const reasons = getVideoValidationReasons(model, settingsFor(model, { references: [imageReference] }));

    expect(reasons.some((reason) => reason.includes('reference-conditioned'))).toBe(true);
  });
});

describe('H3 task switches through the top model selection', () => {
  it('clears frame media when switching to a ref2va transformer, and references on the way back', () => {
    const flModel = h3Model();
    const first = { height: 4, image_name: 'kf.png', width: 4 };
    const toRef = getVideoModelSelectionResult({
      currentSettings: settingsFor(flModel, { firstFrameImage: first, modelKey: flModel.key }),
      model: ref2vaTransformer(),
      models: [flModel],
    });

    expect(toRef.settings.firstFrameImage).toBeNull();
    expect(toRef.clearedLabels).toContain('First frame');

    const backToFl = getVideoModelSelectionResult({
      currentSettings: { ...toRef.settings, references: [imageReference] },
      model: fl2vaTransformer(),
      models: [flModel],
    });

    expect(backToFl.settings.references).toEqual([]);
    expect(backToFl.clearedLabels).toContain('References');
  });

  it('a checkpoint-to-checkpoint switch keeps a compatible component source', () => {
    const source = h3Model();
    const from = settingsFor(fl2vaTransformer(), { componentSourceModel: source, modelKey: fl2vaTransformer().key });
    const result = getVideoModelSelectionResult({
      currentSettings: from,
      model: ref2vaTransformer(),
      models: [source],
    });

    expect(result.settings.componentSourceModel?.key).toBe(source.key);
  });
});

describe('ref2va accelerator auto-pick', () => {
  const REF2V_TURBO = {
    base: 'minimax-h3',
    key: 'ref2v-turbo',
    name: 'MiniMax H3 Ref2V Turbo LoRA',
    type: 'lora' as const,
  };
  const FL2VA_TURBO = { base: 'minimax-h3', key: 'turbo', name: 'MiniMax H3 Turbo LoRA', type: 'lora' as const };

  it('requires the ref2v-token repack for the ref2va variant and excludes it otherwise', () => {
    expect(findMiniMaxH3TurboLora([REF2V_TURBO, FL2VA_TURBO], { variant: 'ref2va' })).toMatchObject({
      key: 'ref2v-turbo',
    });
    expect(findMiniMaxH3TurboLora([REF2V_TURBO, FL2VA_TURBO], { variant: 'fl2va' })).toMatchObject({ key: 'turbo' });
    expect(findMiniMaxH3TurboLora([FL2VA_TURBO], { variant: 'ref2va' })).toBeNull();
  });

  it('the accelerator toggle resolves through the model-borne variant (4-step ref2v turbo)', () => {
    const model = ref2vaTransformer();
    const settings = settingsFor(model);
    const result = getAcceleratorToggleResult(settings, model, [model, REF2V_TURBO, FL2VA_TURBO], true);

    expect(result.missingLoras).toBe(false);
    expect(result.settings.acceleratorLoraKeys).toEqual(['ref2v-turbo']);
    expect(result.settings.steps).toBe(4);
  });
});

describe('H3 component-source seeding', () => {
  it('defaults seed a component source for a checkpoint main, preferring a full install', () => {
    const checkpoint = h3Model('checkpoint');
    const componentsOnly = { ...h3Model('diffusers', 'h3-components'), components_only: true };
    const full = h3Model();

    expect(getDefaultVideoSettings(checkpoint, [componentsOnly, full]).componentSourceModel?.key).toBe(full.key);
    expect(getDefaultVideoSettings(checkpoint, [componentsOnly]).componentSourceModel?.key).toBe(componentsOnly.key);
    expect(getDefaultVideoSettings(checkpoint, []).componentSourceModel).toBeNull();
    // Diffusers mains never get one seeded.
    expect(getDefaultVideoSettings(full, [full]).componentSourceModel).toBeNull();
  });

  it('model selection fills an empty component-source slot but keeps an explicit pick', () => {
    const checkpoint = h3Model('checkpoint');
    const componentsOnly = { ...h3Model('diffusers', 'h3-components'), components_only: true };
    const full = h3Model();
    const fromEmpty = getVideoModelSelectionResult({
      currentSettings: settingsFor(h3Model(), { modelKey: h3Model().key }),
      model: checkpoint,
      models: [full, componentsOnly],
    });

    expect(fromEmpty.settings.componentSourceModel?.key).toBe(full.key);

    const explicit = getVideoModelSelectionResult({
      currentSettings: settingsFor(checkpoint, { componentSourceModel: componentsOnly, modelKey: checkpoint.key }),
      model: checkpoint,
      models: [full, componentsOnly],
    });

    expect(explicit.settings.componentSourceModel?.key).toBe(componentsOnly.key);
  });
});

describe('reference-extend policy', () => {
  const initialVideo = {
    endFrame: 400,
    fps: 24,
    height: 480,
    numFrames: 402,
    startFrame: 0,
    video_name: 'long.mp4',
    width: 832,
  };

  it('accepts references alongside an initial video on ref2va, rejecting the pair elsewhere', () => {
    const ref2va = ref2vaTransformer();
    const combined = settingsFor(ref2va, {
      componentSourceModel: h3Model(),
      references: [imageReference],
      sourceVideo: initialVideo,
    });

    expect(getVideoValidationReasons(ref2va, combined)).toEqual([]);

    // FL2VA (and any non-reference model) still rejects the combination.
    const fl2va = h3Model();
    const reasons = getVideoValidationReasons(
      fl2va,
      settingsFor(fl2va, { references: [imageReference], sourceVideo: initialVideo })
    );

    expect(reasons).toContainEqual(expect.stringContaining('cannot be combined with an initial video on this model'));
  });

  it('a Wan -> Ref2VA switch snaps the frame count BEFORE sizing the tail window', () => {
    // Wan's grid starts at 5 frames. Deriving the window before the snap sized
    // it for that count, and the repair only ever shrank — so the panel landed
    // on a 90-frame H3 generation with a 5-frame anchor, below the 13 frames
    // `sample_text_conditioning_frames` needs. Generate failed outright.
    for (const wanFrames of [5, 9, 21, 81]) {
      const wan = wanModel('i2v-14b');
      const toRef = getVideoModelSelectionResult({
        currentSettings: settingsFor(wan, { modelKey: wan.key, numFrames: wanFrames, sourceVideo: initialVideo }),
        model: ref2vaTransformer(),
        models: [wan],
      });
      const linked = toRef.settings.references.find(
        (entry) => entry.kind === 'video' && entry.fromSourceVideo === true
      );

      expect(toRef.settings.numFrames).toBe(90);
      // 90 frames of 24 fps material off a 24 fps clip, whatever Wan was on.
      expect(linked).toMatchObject({ clip: { endFrame: 400, startFrame: 311 } });
    }
  });

  it('an FL2VA -> Ref2VA switch keeps the initial video and derives its linked tail reference', () => {
    const fl2va = h3Model();
    const toRef = getVideoModelSelectionResult({
      currentSettings: settingsFor(fl2va, { modelKey: fl2va.key, sourceVideo: initialVideo }),
      model: ref2vaTransformer(),
      models: [fl2va],
    });

    expect(toRef.settings.sourceVideo).toEqual(initialVideo);
    expect(toRef.clearedLabels).not.toContain('Initial video');
    // The window is budgeted against the frame count the switch lands on
    // (H3's 124-frame default, snapped AFTER the derivation): a reference
    // longer than the generation is truncated at its seam end.
    expect(toRef.settings.numFrames).toBe(124);
    expect(toRef.settings.references[0]).toMatchObject({
      clip: { endFrame: 400, startFrame: 277, video_name: 'long.mp4' },
      conditioning: 'video_audio',
      fromSourceVideo: true,
      kind: 'video',
    });

    // A task-neutral re-selection of the same model must NOT re-derive a
    // hand-tuned linked trim (only cutpoint changes do, via the setter).
    const tuned = {
      ...toRef.settings,
      references: toRef.settings.references.map((entry, index) =>
        index === 0 && entry.kind === 'video' ? { ...entry, clip: { ...entry.clip, startFrame: 300 } } : entry
      ),
    };
    const reselected = getVideoModelSelectionResult({
      currentSettings: tuned,
      model: ref2vaTransformer(),
      models: [fl2va],
    });

    expect(reselected.settings.references[0]).toMatchObject({ clip: { startFrame: 300 } });

    // And back: the references (linked one included) clear; the clip stays
    // for FL2VA's own extend mode.
    const backToFl = getVideoModelSelectionResult({
      currentSettings: toRef.settings,
      model: fl2va,
      models: [fl2va],
    });

    expect(backToFl.settings.references).toEqual([]);
    expect(backToFl.settings.sourceVideo).toEqual(initialVideo);
  });
});
