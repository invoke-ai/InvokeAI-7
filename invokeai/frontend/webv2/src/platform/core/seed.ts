/**
 * The seed policy every seeded submission shares: the range, the four modes,
 * and how a submission walks its sequence. Kept pure (no top-level calls, no
 * dependencies) so a graph compiler can import it without becoming
 * side-effectful; rolldown would otherwise materialise that compiler's facade
 * and pull the canvas-layer chunk into the settings and palette overlays.
 */

export const SEED_MAX = 4_294_967_295;

export const SEED_MODES = ['random', 'fixed', 'increment', 'decrement'] as const;

export type SeedMode = (typeof SEED_MODES)[number];

/** Direction the seed moves between the entries of one submission's sequence. */
export type SeedStep = -1 | 0 | 1;

export const isSeedMode = (value: unknown): value is SeedMode => SEED_MODES.includes(value as SeedMode);

export const getSeedStep = (mode: SeedMode): SeedStep => (mode === 'fixed' ? 0 : mode === 'decrement' ? -1 : 1);

/** Wraps over the inclusive seed range so decrementing past 0 lands on `SEED_MAX`. */
export const wrapSeed = (seed: number): number => {
  const range = SEED_MAX + 1;

  return ((seed % range) + range) % range;
};

export interface SeedSequenceInput {
  batchCount: number;
  /** Concrete prompts the submission carries; one unless the host expands a prompt into several. */
  promptCount: number;
  seedBehaviour: 'per-image' | 'per-iteration';
  seedMode: SeedMode;
}

/**
 * How many entries of the seed sequence one submission uses. A fixed seed uses
 * its single entry however many images run. Otherwise every iteration takes an
 * entry, and with several prompts sharing disabled every image does.
 */
export const getSeedSequenceLength = ({
  batchCount,
  promptCount,
  seedBehaviour,
  seedMode,
}: SeedSequenceInput): number =>
  seedMode === 'fixed' ? 1 : promptCount > 1 && seedBehaviour === 'per-image' ? promptCount * batchCount : batchCount;

export interface SeedSubmissionPlan {
  /** The last sequence entry the submission uses. */
  lastSeed: number;
  /** What the editable seed becomes once the submission is queued; null when the mode leaves it alone. */
  nextSeed: number | null;
  seedMode: SeedMode;
  sequenceLength: number;
  startSeed: number;
  step: SeedStep;
}

/**
 * The seeds a submission consumes and where the editable seed goes afterwards.
 * Only the stepping modes advance it: random keeps the manual value in reserve,
 * fixed reuses it.
 */
export const planSeedSubmission = ({
  startSeed,
  ...sequence
}: SeedSequenceInput & { startSeed: number }): SeedSubmissionPlan => {
  const step = getSeedStep(sequence.seedMode);
  const sequenceLength = getSeedSequenceLength(sequence);
  const advances = sequence.seedMode === 'increment' || sequence.seedMode === 'decrement';

  return {
    lastSeed: wrapSeed(startSeed + step * (sequenceLength - 1)),
    nextSeed: advances ? wrapSeed(startSeed + step * sequenceLength) : null,
    seedMode: sequence.seedMode,
    sequenceLength,
    startSeed,
    step,
  };
};
