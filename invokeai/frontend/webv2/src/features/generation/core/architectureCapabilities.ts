/**
 * What the backend says each architecture supports, and how it reaches generation policy.
 *
 * `GET /api/v2/models/capabilities` serves one row per architecture plus a row per variant that
 * answers differently -- the same table `invokeai/backend/architectures/defs/<base>.py` declares.
 * Adding an architecture to the backend should not mean editing a table here too.
 *
 * webv2 has no generated OpenAPI types, so the wire shape below is hand-written and unguarded by
 * the compiler. `tests/backend/architectures/test_capabilities_fixture.py` is what guards it: it
 * pins `__fixtures__/architectureCapabilities.json` against what the backend actually renders, and
 * that same fixture feeds these tests and the mock backend.
 *
 * This module is deliberately push-based. `feature-core-purity` forbids `core/` from importing
 * `data/` or transport, so the store calls `setArchitectureCapabilities` rather than being read
 * from here -- the same shape `configureHttpAuth` uses in `platform/transport/http.ts`.
 */

import type { BaseGenerationConfig, GuidanceLabel, NegativePromptUsage, SchedulerSetId } from './generationConfig';

/** A capabilities row exactly as the backend serialises it. snake_case, unions kept open. */
export interface ArchitectureCapabilitiesRow {
  base: string;
  /** Null for the architecture's own row. A variant row overrides it. */
  variant: string | null;
  modality: {
    modes: string[];
    metadata_slug: string | null;
  };
  features: {
    negative_prompt: { visible: boolean; usage: NegativePromptUsage };
    dimension_grid: number;
    spatial_compression: number;
    guidance_label: GuidanceLabel | (string & {});
    /** No `flow-no-lcm` here: that set is reached by a frontend-only variant rule, see below. */
    scheduler_set: SchedulerSetId | null;
    scheduler_applies_to_graph: boolean;
    control_kinds: string[];
    max_reference_images: number;
    reference_images_require_variant: string | null;
    supports_regional_guidance: boolean;
    regional_negative: boolean;
    clip_skip_max: number | null;
    supports_seamless: boolean;
    supports_cfg_rescale: boolean;
    sd_vae_override: boolean;
    color_compensation: boolean;
    vae_precision: boolean;
  };
  defaults: {
    vae: string | null;
    vae_precision: 'fp16' | 'fp32' | null;
    scheduler: string | null;
    steps: number | null;
    cfg_scale: number | null;
    cfg_rescale_multiplier: number | null;
    width: number | null;
    height: number | null;
    guidance: number | null;
    cpu_only: boolean | null;
    fp8_storage: boolean | null;
  } | null;
}

const FALLBACK_STEPS = 30;
const FALLBACK_CFG_SCALE = 7;
const FALLBACK_SCHEDULER = 'euler_a';
const FALLBACK_OPTIMAL_SIDE = 1024;

/**
 * The value the single guidance slider takes.
 *
 * There is one control, labelled from `guidance_label`, and two fields behind it. A
 * guidance-distilled architecture records `cfg_scale: 1.0` meaning "CFG off" *and* the guidance it
 * samples with, so reading `cfg_scale` first would present the off-switch as the setting.
 */
const guidanceValue = (defaults: NonNullable<ArchitectureCapabilitiesRow['defaults']>, label: GuidanceLabel): number =>
  (label === 'Guidance' ? (defaults.guidance ?? defaults.cfg_scale) : (defaults.cfg_scale ?? defaults.guidance)) ??
  FALLBACK_CFG_SCALE;

/**
 * The optimal canvas as a side length.
 *
 * `optimalSide` is squared back into an area by its consumers (`importGalleryImages` passes
 * `optimal ** 2` to `calculateNewSize`), so deriving it from the area rather than from `width`
 * alone survives an architecture whose default canvas is not square. Every architecture webv2
 * generates images with is square today; MiniMax H3 is 1344x768, which is why this is not just
 * `width`.
 */
const optimalSide = (defaults: NonNullable<ArchitectureCapabilitiesRow['defaults']>): number => {
  const { width, height } = defaults;
  if (width && height) {
    return Math.round(Math.sqrt(width * height));
  }
  return width ?? height ?? FALLBACK_OPTIMAL_SIDE;
};

/** Map one row onto the shape generation policy already speaks. Pure. */
export const toBaseGenerationConfig = (row: ArchitectureCapabilitiesRow): BaseGenerationConfig => {
  const { features } = row;
  const defaults = row.defaults;
  const guidanceLabel: GuidanceLabel = features.guidance_label === 'Guidance' ? 'Guidance' : 'CFG';

  return {
    dimensions: {
      grid: features.dimension_grid,
      optimalSide: defaults ? optimalSide(defaults) : FALLBACK_OPTIMAL_SIDE,
    },
    defaults: {
      steps: defaults?.steps ?? FALLBACK_STEPS,
      cfgScale: defaults ? guidanceValue(defaults, guidanceLabel) : FALLBACK_CFG_SCALE,
      scheduler: defaults?.scheduler ?? FALLBACK_SCHEDULER,
    },
    schedulerSet: features.scheduler_set ?? 'standard',
    schedulerAppliesToGraph: features.scheduler_applies_to_graph,
    guidanceLabel,
    negativePrompt: features.negative_prompt,
    ui: {
      sdVaeOverride: features.sd_vae_override,
      colorCompensation: features.color_compensation,
      vaePrecision: features.vae_precision,
      seamless: features.supports_seamless,
      cfgRescale: features.supports_cfg_rescale,
      // `undefined`, not `null`: consumers branch on falsiness and on presence.
      clipSkipMax: features.clip_skip_max ?? undefined,
    },
  };
};

const key = (base: string, variant: string | null): string => `${base}\u0000${variant ?? ''}`;

let rows: readonly ArchitectureCapabilitiesRow[] | null = null;
let byKey = new Map<string, ArchitectureCapabilitiesRow>();
let configByKey = new Map<string, BaseGenerationConfig>();

/** Called by `data/` once the table has been fetched. */
export const setArchitectureCapabilities = (next: readonly ArchitectureCapabilitiesRow[]): void => {
  rows = next;
  byKey = new Map(next.map((row) => [key(row.base, row.variant), row]));
  // Memoised so policy accessors stay O(1) and hand back referentially stable objects.
  configByKey = new Map(next.map((row) => [key(row.base, row.variant), toBaseGenerationConfig(row)]));
};

/** Drop the table. The store calls this on account change; tests call it to isolate. */
export const resetArchitectureCapabilities = (): void => {
  rows = null;
  byKey = new Map();
  configByKey = new Map();
};

export const hasArchitectureCapabilities = (): boolean => rows !== null;

/** `(base, variant)` if that variant answers differently, else the architecture's own row. */
export const getArchitectureCapabilityRow = (
  base: string,
  variant?: unknown
): ArchitectureCapabilitiesRow | undefined => {
  if (typeof variant === 'string' && variant.length > 0) {
    const exact = byKey.get(key(base, variant));
    if (exact) {
      return exact;
    }
  }
  return byKey.get(key(base, null));
};

export const getArchitectureGenerationConfig = (base: string, variant?: unknown): BaseGenerationConfig | undefined => {
  if (typeof variant === 'string' && variant.length > 0) {
    const exact = configByKey.get(key(base, variant));
    if (exact) {
      return exact;
    }
  }
  return configByKey.get(key(base, null));
};

/**
 * Feature flags for an architecture. Variant-independent by design: the backend copies one
 * `features` block onto every variant row of an architecture, so asking per variant would suggest
 * a precision that is not there.
 */
export const getArchitectureFeatures = (base: string): ArchitectureCapabilitiesRow['features'] | undefined =>
  byKey.get(key(base, null))?.features;
