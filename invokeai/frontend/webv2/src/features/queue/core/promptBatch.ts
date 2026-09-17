/**
 * The seed/prompt matrix for a generate submission.
 *
 * A generate graph carries one `positive_prompt` string node, so submitting
 * several prompts is a batch dimension over that node rather than several
 * graphs. Backend batch semantics (see
 * `invokeai/app/services/session_queue/session_queue_common.py`): the outer list
 * is a cartesian PRODUCT of groups, and each inner group is ZIPPED, so all of
 * its items must have the same length.
 *
 * The prompt list arrives already expanded — Queue never talks to the expansion
 * route itself.
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

/**
 * One workflow seed input that varies between runs: its first seed and the
 * direction of the rest. Compact on purpose — the snapshot records the start
 * the plan drew, and the runs expand from it deterministically at send time.
 */
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
 * The expansion items queued before seed modes were planned with, reproduced so
 * recovery replays them as recorded. Those items knew only a random toggle,
 * which the runtime maps to a step of 1 or 0: the toggle decided whether one
 * prompt (or per-iteration prompts) stepped or held, while several prompts with
 * sharing disabled always stepped per image, and the sequence wrapped at
 * `SEED_MAX` exclusive. New submissions never take this path.
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
 * With a single prompt this reproduces the pre-dynamic-prompts payload exactly,
 * which `promptBatch.test.ts` pins:
 * - stepping seed -> one zipped group of `batchCount` seeds and repeated
 *   prompts, `runs: 1`
 * - held seed -> one zipped group of length 1, `runs: batchCount`
 *
 * With several prompts the seed behaviour decides the shape, but only while the
 * seed steps — a held seed is the same for every image whatever the behaviour:
 * - `per-iteration` -> seeds become their own group, so the product is
 *   `iterations x prompts` and every prompt in an iteration shares its seed
 * - `per-image` -> one distinct sequential seed per image, zipped against the
 *   prompt list repeated `batchCount` times, `runs: 1`
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
