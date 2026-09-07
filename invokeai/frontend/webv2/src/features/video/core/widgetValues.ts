import type {
  GenerationModelCatalogItem as ModelConfig,
  MainModelConfig,
  ModelIdentifierConfig,
} from '@features/generation/contracts';

import { isLoraCompatibleWithModel, isLoraModelConfig, SEED_MAX } from '@features/generation/settings';

import type { VideoWidgetValues } from './types';

import {
  getAcceleratorLoraChangeResult,
  getDefaultVideoSettings,
  getVideoComponentSectionPolicy,
  getVideoModelAvailabilityReasons,
  getVideoModelSelectionResult,
  getVideoModes,
  getVideoValidationReasons,
  isSupportedVideoModel,
  isVideoModelSelectable,
  type VideoComponentPolicyContext,
  type VideoComponentValueKey,
} from './videoPolicies';

/**
 * The panel-facing layer over the pure settings: default values seeded from
 * the installed catalog, catalog reconciliation (upscale-style: render-time,
 * mount write-back, and compile all reuse this one function), the aggregate
 * validation the invoke route consumes, and seed resolution at submit.
 */

// Shared empty array, so clearing already-clear keys keeps its identity.
const EMPTY_ACCELERATOR_LORA_KEYS: string[] = [];

export const createDefaultVideoWidgetValues = (models: readonly ModelConfig[] = []): VideoWidgetValues => {
  const model = (models.find((candidate) => isVideoModelSelectable(candidate)) as MainModelConfig | undefined) ?? null;

  return { ...getDefaultVideoSettings(model ?? undefined, models), model };
};

/**
 * Re-resolves every model reference against the live catalog. MUST return the
 * same object when nothing changes — the mount-time reconciler and render
 * memoization rely on that identity guarantee to avoid write-back loops.
 */
export const syncVideoWidgetValuesWithModels = (
  values: VideoWidgetValues,
  models: readonly ModelConfig[]
): VideoWidgetValues => {
  // Legacy stored shape (pre model-positions): an H3 Diffusers install at top
  // with the single-file transformer in the override slot. The transformer is
  // the model identity now — promote it to the top slot and keep the install
  // as its component source. Runs before anything reads `values.model`, so
  // the whole sync (and its write-back) sees the new shape.
  //
  // Only a transformer that resolves in the live catalog as an H3 checkpoint
  // main is promoted: an uninstalled (or corrupt) override must not evict the
  // still-installed Diffusers main from the top slot — leaving it in place
  // keeps a runnable H3 panel, and the component pass below drops the dead
  // override (no slot offers it any more).
  if (values.model?.base === 'minimax-h3' && values.model.format === 'diffusers' && values.h3TransformerModel) {
    const installedTransformer = models.find((candidate) => candidate.key === values.h3TransformerModel?.key);

    if (
      installedTransformer &&
      installedTransformer.type === 'main' &&
      installedTransformer.base === 'minimax-h3' &&
      installedTransformer.format === 'checkpoint'
    ) {
      values = {
        ...values,
        componentSourceModel: values.model,
        h3TransformerModel: null,
        model: installedTransformer as MainModelConfig,
        modelKey: installedTransformer.key,
      };
    }
  }

  const modelsByKey = new Map(models.map((model) => [model.key, model]));
  const storedMain = values.model ? modelsByKey.get(values.model.key) : undefined;
  // The stored main survives on the looser `isSupportedVideoModel` check: a
  // legacy non-selectable shape (components-only install at top with no
  // transformer to promote) keeps its slot and shows validation guidance
  // instead of being silently swapped for another model. Auto-picks use the
  // stricter selectable filter.
  const model: MainModelConfig | null =
    storedMain && isSupportedVideoModel(storedMain)
      ? storedMain
      : ((models.find((candidate) => isVideoModelSelectable(candidate)) as MainModelConfig | undefined) ?? null);

  // The main changed identity under us (nothing stored, or the stored model was
  // uninstalled and another family got auto-picked): run the canonical
  // selection transition first, or the new family would inherit the old one's
  // frames/fps/resolution — an H3 main stuck at Wan's fps 16 has no working
  // FPS control to fix it with.
  const base: VideoWidgetValues =
    model && model.key !== values.model?.key
      ? { ...getVideoModelSelectionResult({ currentSettings: values, model, models }).settings, model }
      : values;

  const componentPolicy = model ? getVideoComponentSectionPolicy(model, base) : null;
  const slotsByKey = new Map(componentPolicy?.slots.map((slot) => [slot.key, slot]) ?? []);
  const componentContext: VideoComponentPolicyContext | null = model
    ? { model, selectedComponents: base, settings: base }
    : null;

  const syncComponent = <T extends ModelIdentifierConfig | MainModelConfig>(
    key: VideoComponentValueKey,
    value: T | null
  ): T | null => {
    if (!value) {
      return null;
    }

    const installed = modelsByKey.get(value.key);
    const slot = slotsByKey.get(key);

    if (!installed || !slot || !componentContext) {
      return null;
    }

    return !slot.filter || slot.filter(installed, componentContext) ? (installed as T) : null;
  };

  const loras = model
    ? base.loras.flatMap((lora) => {
        const installed = modelsByKey.get(lora.model.key);

        return installed && isLoraModelConfig(installed) && isLoraCompatibleWithModel(installed, model)
          ? [{ ...lora, model: installed }]
          : [];
      })
    : [];
  // Losing an accelerator LoRA through the catalog (uninstalled, dropped as
  // incompatible) goes through the same reconcile the Concepts setter uses:
  // another complete accelerator set still enabled in the list takes over,
  // otherwise the flag goes off AND the model's own sampling defaults come
  // back. Clearing only the flag would leave steps 4 / CFG 1 with no
  // distillation LoRA — a silent run that reads as a broken model.
  //
  // The reconcile only ever repairs a fast path that is already on, so a sync
  // running on every render cannot arm one behind the user's back.
  //
  // Reuse the stored values whenever nothing changed — the identity guarantee
  // below depends on `acceleratorLoraKeys` keeping its array.
  const unchangedAccelerator = {
    acceleratorEnabled: base.acceleratorEnabled,
    acceleratorLoraKeys: base.acceleratorLoraKeys,
    cfgScale: base.cfgScale,
    cfgScaleLowNoise: base.cfgScaleLowNoise,
    steps: base.steps,
  };
  const acceleratorSync = model ? getAcceleratorLoraChangeResult(base, model, models, loras) : null;
  let accelerator = unchangedAccelerator;

  if (!model) {
    // No video main at all: `loras` above is empty, so a surviving flag would
    // name keys that are not in the list — a record `isVideoSettings` rejects
    // on reload. There is no model to take sampling defaults from.
    if (base.acceleratorEnabled || base.acceleratorLoraKeys.length > 0) {
      accelerator = {
        ...unchangedAccelerator,
        acceleratorEnabled: false,
        acceleratorLoraKeys: EMPTY_ACCELERATOR_LORA_KEYS,
      };
    }
  } else if (acceleratorSync && acceleratorSync.outcome !== 'unchanged') {
    accelerator = {
      acceleratorEnabled: acceleratorSync.settings.acceleratorEnabled,
      acceleratorLoraKeys: acceleratorSync.settings.acceleratorLoraKeys,
      cfgScale: acceleratorSync.settings.cfgScale,
      cfgScaleLowNoise: acceleratorSync.settings.cfgScaleLowNoise,
      steps: acceleratorSync.settings.steps,
    };
  }

  const next: VideoWidgetValues = {
    ...base,
    ...accelerator,
    componentSourceModel: syncComponent('componentSourceModel', base.componentSourceModel),
    h3TextEncoderModel: syncComponent('h3TextEncoderModel', base.h3TextEncoderModel),
    h3TransformerModel: syncComponent('h3TransformerModel', base.h3TransformerModel),
    loras,
    model,
    modelKey: model?.key ?? base.modelKey,
    vae: syncComponent('vae', base.vae),
    wanLowNoiseModel: syncComponent('wanLowNoiseModel', base.wanLowNoiseModel),
    wanT5EncoderModel: syncComponent('wanT5EncoderModel', base.wanT5EncoderModel),
  };

  // The model decides the task: if the Ref2VA transformer was uninstalled and
  // another model got auto-picked, the stored references are orphaned — the
  // policy no longer has a reference mode — so drop them, identity-preserving.
  if (next.references.length > 0 && model && !getVideoModes(model).includes('reference')) {
    next.references = [];
  }

  const isUnchanged =
    base === values &&
    next.model === values.model &&
    next.modelKey === values.modelKey &&
    next.acceleratorEnabled === values.acceleratorEnabled &&
    next.acceleratorLoraKeys === values.acceleratorLoraKeys &&
    next.vae === values.vae &&
    next.wanT5EncoderModel === values.wanT5EncoderModel &&
    next.wanLowNoiseModel === values.wanLowNoiseModel &&
    next.componentSourceModel === values.componentSourceModel &&
    next.h3TransformerModel === values.h3TransformerModel &&
    next.h3TextEncoderModel === values.h3TextEncoderModel &&
    next.references === values.references &&
    next.loras.length === values.loras.length &&
    next.loras.every((lora, index) => lora.model === values.loras[index]?.model);

  return isUnchanged ? values : next;
};

/** The aggregate readiness check the invoke route and the compiler share. */
export const getVideoWidgetValidationReasons = (
  values: VideoWidgetValues,
  models?: readonly ModelConfig[]
): string[] => {
  if (!values.model) {
    return ['Video needs a Wan 2.2 or MiniMax H3 main model.'];
  }

  const reasons = getVideoValidationReasons(values.model, values);

  if (models) {
    reasons.push(...getVideoModelAvailabilityReasons(values.model, values, models));
  }

  return reasons;
};

export const resolveVideoSeed = (values: Pick<VideoWidgetValues, 'seed' | 'shouldRandomizeSeed'>): number =>
  values.shouldRandomizeSeed ? Math.floor(Math.random() * SEED_MAX) : values.seed;
