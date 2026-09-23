/**
 * Prompts arrive pre-expanded. Backend outer groups form a Cartesian product; entries within each group zip and
 * require equal lengths.
 */

import { SEED_MAX } from '@platform/core/seed';

export const MAX_QUEUE_BATCH_ITEMS = 10_000;

export type QueuePromptSeedBehaviour = 'per-iteration' | 'per-image';

/** Direction between consecutive seeds of one submission; 0 holds the start seed for every image. */
export type QueueSeedStep = -1 | 0 | 1;

export const isQueuePromptSeedBehaviour = (value: unknown): value is QueuePromptSeedBehaviour =>
  value === 'per-iteration' || value === 'per-image';

export const isQueueSeedStep = (value: unknown): value is QueueSeedStep => value === -1 || value === 0 || value === 1;

export const sanitizeBatchCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_QUEUE_BATCH_ITEMS, Math.max(1, Math.round(value)))
    : 1;

/** Consecutive seeds from `start`, wrapping over the inclusive `0..SEED_MAX` range. */
export const generateSeedSequence = (start: number, count: number, step: QueueSeedStep = 1): number[] => {
  const range = SEED_MAX + 1;

  return Array.from(
    { length: sanitizeBatchCount(count) },
    (_, index) => (((start + index * step) % range) + range) % range
  );
};

/** One value list of a zipped batch group, in the backend's `BatchDatum` shape. */
export interface QueueBatchDatum {
  field_name: string;
  items: (number | string)[];
  node_path: string;
}

export interface GeneratePromptBatchDatum extends QueueBatchDatum {
  field_name: 'value';
}

/** Persist each workflow seed's start and step; expand deterministic runs at send time. */
export interface QueueWorkflowSeed {
  fieldName: string;
  nodeId: string;
  seed: number;
  seedStep: -1 | 1;
}

export const isQueueWorkflowSeed = (value: unknown): value is QueueWorkflowSeed => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const seed = value as Partial<QueueWorkflowSeed>;

  return (
    typeof seed.fieldName === 'string' &&
    seed.fieldName.length > 0 &&
    typeof seed.nodeId === 'string' &&
    seed.nodeId.length > 0 &&
    typeof seed.seed === 'number' &&
    Number.isInteger(seed.seed) &&
    seed.seed >= 0 &&
    seed.seed <= SEED_MAX &&
    (seed.seedStep === -1 || seed.seedStep === 1)
  );
};

export interface WorkflowSeedBatchPlan {
  /** One zipped group over every varying input, or undefined while every seed holds. */
  data?: QueueBatchDatum[][];
  runs: number;
}

/**
 * A workflow batch repeats one graph unless a seed input varies, in which case
 * every varying input joins one zipped group so `batchCount` runs stay
 * `batchCount` runs. A single run needs no data: the plan already wrote each
 * start seed into the graph.
 */
export const buildWorkflowSeedBatchPlan = ({
  batchCount,
  seeds,
}: {
  batchCount: number;
  seeds: readonly QueueWorkflowSeed[] | undefined;
}): WorkflowSeedBatchPlan => {
  const runs = sanitizeBatchCount(batchCount);

  if (!seeds || seeds.length === 0 || runs === 1) {
    return { runs };
  }

  return {
    data: [
      seeds.map((seed) => ({
        field_name: seed.fieldName,
        items: generateSeedSequence(seed.seed, runs, seed.seedStep),
        node_path: seed.nodeId,
      })),
    ],
    runs: 1,
  };
};

export interface GeneratePromptBatchPlanInput {
  batchCount: number;
  negativePrompt: string;
  negativePromptNodeId: string;
  positivePromptNodeId: string;
  prompts: readonly string[];
  seed: number;
  seedBehaviour: QueuePromptSeedBehaviour;
  seedNodeId: string;
  seedStep: QueueSeedStep;
}

export interface GeneratePromptBatchPlan {
  /** Outer list is a cartesian product; each inner list is zipped. */
  data: GeneratePromptBatchDatum[][];
  runs: number;
  /** Images this plan produces, for optimistic placeholder sizing. */
  expectedImageCount: number;
}

/** The pre-seed-mode sequence: consecutive from `start`, wrapping one short of the inclusive range. */
const generateLegacySeedSequence = (start: number, count: number): number[] =>
  Array.from({ length: sanitizeBatchCount(count) }, (_, index) => (start + index) % SEED_MAX);

/**
 * Recovery preserves legacy random-toggle seed rules, including exclusive SEED_MAX wrapping; new submissions never
 * use this path.
 */
export const buildLegacyGeneratePromptBatchPlan = ({
  batchCount,
  negativePrompt,
  negativePromptNodeId,
  positivePromptNodeId,
  prompts,
  seed,
  seedBehaviour,
  seedNodeId,
  seedStep,
}: GeneratePromptBatchPlanInput): GeneratePromptBatchPlan => {
  const shouldRandomizeSeed = seedStep !== 0;
  const iterations = sanitizeBatchCount(batchCount);
  const promptList = prompts.length > 0 ? [...prompts] : [''];
  const promptDatum = (items: string[]): GeneratePromptBatchDatum[] => [
    { field_name: 'value', items, node_path: positivePromptNodeId },
    { field_name: 'value', items: items.map(() => negativePrompt), node_path: negativePromptNodeId },
  ];

  if (promptList.length === 1) {
    const seeds = shouldRandomizeSeed ? generateLegacySeedSequence(seed, iterations) : [seed];

    return {
      data: [
        [{ field_name: 'value', items: seeds, node_path: seedNodeId }, ...promptDatum(seeds.map(() => promptList[0]))],
      ],
      expectedImageCount: iterations,
      runs: shouldRandomizeSeed ? 1 : iterations,
    };
  }

  if (seedBehaviour === 'per-image') {
    const seeds = generateLegacySeedSequence(seed, promptList.length * iterations);
    const repeatedPrompts = Array.from({ length: iterations }, () => promptList).flat();

    return {
      data: [[{ field_name: 'value', items: seeds, node_path: seedNodeId }, ...promptDatum(repeatedPrompts)]],
      expectedImageCount: seeds.length,
      runs: 1,
    };
  }

  const seeds = shouldRandomizeSeed ? generateLegacySeedSequence(seed, iterations) : [seed];

  return {
    data: [[{ field_name: 'value', items: seeds, node_path: seedNodeId }], promptDatum(promptList)],
    expectedImageCount: promptList.length * iterations,
    runs: shouldRandomizeSeed ? 1 : iterations,
  };
};

/**
 * Held seeds reuse one value. Stepping per-iteration seeds form a product with prompts; per-image seeds zip with
 * repeated prompts.
 */
export const buildGeneratePromptBatchPlan = ({
  batchCount,
  negativePrompt,
  negativePromptNodeId,
  positivePromptNodeId,
  prompts,
  seed,
  seedBehaviour,
  seedNodeId,
  seedStep,
}: GeneratePromptBatchPlanInput): GeneratePromptBatchPlan => {
  const iterations = sanitizeBatchCount(batchCount);
  const promptList = prompts.length > 0 ? [...prompts] : [''];
  const promptDatum = (items: string[]): GeneratePromptBatchDatum[] => [
    { field_name: 'value', items, node_path: positivePromptNodeId },
    { field_name: 'value', items: items.map(() => negativePrompt), node_path: negativePromptNodeId },
  ];
  const isHeld = seedStep === 0;

  if (promptList.length === 1) {
    const seeds = isHeld ? [seed] : generateSeedSequence(seed, iterations, seedStep);

    return {
      data: [
        [{ field_name: 'value', items: seeds, node_path: seedNodeId }, ...promptDatum(seeds.map(() => promptList[0]))],
      ],
      expectedImageCount: iterations,
      runs: isHeld ? iterations : 1,
    };
  }

  if (seedBehaviour === 'per-image' && !isHeld) {
    const seeds = generateSeedSequence(seed, promptList.length * iterations, seedStep);
    const repeatedPrompts = Array.from({ length: iterations }, () => promptList).flat();

    return {
      data: [[{ field_name: 'value', items: seeds, node_path: seedNodeId }, ...promptDatum(repeatedPrompts)]],
      expectedImageCount: seeds.length,
      runs: 1,
    };
  }

  // per-iteration: the seed list is its own dimension, so each iteration's seed
  // is applied across the whole prompt set. Seeds first so results group by
  // iteration rather than interleaving prompts.
  const seeds = isHeld ? [seed] : generateSeedSequence(seed, iterations, seedStep);

  return {
    data: [[{ field_name: 'value', items: seeds, node_path: seedNodeId }], promptDatum(promptList)],
    expectedImageCount: promptList.length * iterations,
    runs: isHeld ? iterations : 1,
  };
};
