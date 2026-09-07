import type { QueueItemReadModel } from '@features/queue/core/types';

/**
 * Best-effort recovery of the human-facing generation parameters for a queue
 * item. The reliable source is the local submission snapshot (matched in the
 * view by origin), but server items from other clients/sources only carry
 * field values — generic node/field/value substitutions.
 *
 * Every batch this client submits names its nodes (`buildGeneratePromptBatchPlan`
 * stamps the graph's prompt/seed node ids as `node_path`), so read by identity
 * first. Order alone is not safe: a submission may legitimately carry an EMPTY
 * positive prompt — the Video panel has no positive-prompt requirement at all —
 * and a positional scan that skips blanks would slide the negative prompt into
 * the positive slot and recall it as the subject.
 *
 * Unknown graphs (other clients, workflow batches naming their own nodes) fall
 * back to the original by-type/by-order heuristic.
 */

export interface QueueGenerationMeta {
  positivePrompt?: string;
  negativePrompt?: string;
  seed?: number;
}

/** The node ids the generate/video graphs give their prompt and seed nodes. */
const POSITIVE_PROMPT_NODE_PATH = 'positive_prompt';
const NEGATIVE_PROMPT_NODE_PATH = 'negative_prompt';
const SEED_NODE_PATH = 'seed';

export const extractGenerationMeta = (item: QueueItemReadModel): QueueGenerationMeta => {
  const fieldValues = item.fieldValues ?? [];
  const meta: QueueGenerationMeta = {};
  let namedPrompt = false;

  for (const { nodePath, value } of fieldValues) {
    if (nodePath === POSITIVE_PROMPT_NODE_PATH && typeof value === 'string') {
      // Recorded verbatim, empty included: an empty positive is a real
      // submission, not a missing field.
      meta.positivePrompt = value;
      namedPrompt = true;
    } else if (nodePath === NEGATIVE_PROMPT_NODE_PATH && typeof value === 'string') {
      meta.negativePrompt = value;
      namedPrompt = true;
    } else if (nodePath === SEED_NODE_PATH && typeof value === 'number') {
      meta.seed = value;
    }
  }

  if (namedPrompt && meta.seed !== undefined) {
    return meta;
  }

  // Fallback for graphs that name their nodes differently: recover by value
  // type and order, as before. Only fills what the named pass did not.
  const prompts: string[] = [];

  for (const { value } of fieldValues) {
    if (typeof value === 'number' && meta.seed === undefined) {
      meta.seed = value;
    } else if (typeof value === 'string' && value.trim().length > 0) {
      prompts.push(value);
    }
  }

  if (namedPrompt) {
    return meta;
  }

  if (prompts[0] !== undefined) {
    meta.positivePrompt = prompts[0];
  }

  if (prompts[1] !== undefined) {
    meta.negativePrompt = prompts[1];
  }

  return meta;
};

/** First result image name from a completed item's session, or null. */
export const getResultImageName = (item: QueueItemReadModel): string | null => {
  return item.resultImageNames[0] ?? null;
};
