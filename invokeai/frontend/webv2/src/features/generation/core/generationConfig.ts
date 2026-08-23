/**
 * The shape generation policy speaks about an architecture.
 *
 * Split out of `baseGenerationPolicies.ts` so that `architectureCapabilities.ts` -- which maps the
 * backend's wire rows onto this shape -- and the policy accessors that consume it can both refer to
 * it without importing each other.
 */

export type SchedulerSetId = 'standard' | 'flow' | 'flow-no-lcm' | 'anima';

export type NegativePromptUsage = 'always' | 'cfg-gated' | 'never';

export type GuidanceLabel = 'CFG' | 'Guidance';

export interface BaseGenerationConfig {
  dimensions: {
    grid: number;
    /**
     * The side of the model's optimal square canvas. Consumers square it back into an area
     * (`importGalleryImages` passes `optimal ** 2` to `calculateNewSize`), so it is derived from
     * the declared area rather than from width alone.
     */
    optimalSide: number;
  };
  defaults: {
    steps: number;
    /** Whatever the single guidance slider shows -- CFG or distilled guidance, per `guidanceLabel`. */
    cfgScale: number;
    scheduler: string;
  };
  schedulerSet: SchedulerSetId;
  schedulerAppliesToGraph: boolean;
  guidanceLabel: GuidanceLabel;
  negativePrompt: {
    visible: boolean;
    usage: NegativePromptUsage;
  };
  ui: {
    sdVaeOverride: boolean;
    colorCompensation: boolean;
    vaePrecision: boolean;
    seamless: boolean;
    cfgRescale: boolean;
    clipSkipMax?: number;
  };
}
