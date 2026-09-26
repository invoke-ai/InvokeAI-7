import type { QueueItem } from '@features/queue/core/historyTypes';
import type { QueueItemReadModel } from '@features/queue/core/types';

import { getQueueItemSnapshotPositivePrompt } from '@features/queue/core/historySnapshot';
import { parseQueueItemOrigin } from '@features/queue/data/events';

import { getRemoteDispatchPlan, type RemoteDispatchPlan } from './remoteWorkersDispatch';

/** Human-facing metadata for the native queue's lightweight Remote-only launcher. */
export interface RemoteOnlyDispatchDisplay {
  positivePrompt: string;
  negativePrompt?: string;
  seed?: number;
}

/**
 * The original per-iteration graph is already persisted in the native queue
 * field_values. Read only human-facing fields; never show source_graph_json as
 * a prompt, even when browser-owned project history has been cleared.
 */
const recoverOriginalGraphDisplay = (fieldValue: string): RemoteOnlyDispatchDisplay => {
  const fallback: RemoteOnlyDispatchDisplay = { positivePrompt: 'Remote workflow' };
  try {
    const graph: unknown = JSON.parse(fieldValue);
    if (!graph || typeof graph !== 'object') {
      return fallback;
    }
    const nodes = (graph as { nodes?: unknown }).nodes;
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
      return fallback;
    }
    const entries = Object.entries(nodes as Record<string, unknown>);
    const node = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    const text = (value: unknown): string | undefined => {
      const fields = node(value);
      if (!fields) {
        return undefined;
      }
      for (const key of ['value', 'prompt', 'text']) {
        if (typeof fields[key] === 'string') {
          return fields[key];
        }
      }
      return undefined;
    };
    const number = (value: unknown): number | undefined => {
      const fields = node(value);
      const candidate = fields?.value ?? fields?.seed;
      return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
    };
    const named = nodes as Record<string, unknown>;
    const positive = text(named.positive_prompt) ?? text(entries.find(([id]) => /positive.*prompt/i.test(id))?.[1]);
    const negative = text(named.negative_prompt) ?? text(entries.find(([id]) => /negative.*prompt/i.test(id))?.[1]);
    const seed = number(named.seed) ?? number(entries.find(([id]) => /seed/i.test(id))?.[1]);
    return {
      positivePrompt: positive?.trim() || fallback.positivePrompt,
      ...(negative === undefined ? {} : { negativePrompt: negative }),
      ...(seed === undefined ? {} : { seed }),
    };
  } catch {
    // Corrupted/legacy source graphs should still get a readable queue label.
    return fallback;
  }
};

/**
 * Recognize only the Remote-only launcher (never a mirrored/local graph).
 * Prefer iteration-specific queue fields and fall back to the browser snapshot
 * only when the original graph does not contain a usable prompt/seed.
 */
export const getRemoteOnlyDispatchDisplay = (
  backendItem: QueueItemReadModel,
  projectItems: readonly QueueItem[],
  readPlan: (queueItemId: string) => RemoteDispatchPlan | null = getRemoteDispatchPlan
): RemoteOnlyDispatchDisplay | null => {
  const id = parseQueueItemOrigin(backendItem.origin);
  const source = projectItems.find((item) =>
    id ? item.id === id : item.backendItemIds?.includes(backendItem.id) === true
  );
  const graphField = backendItem.fieldValues?.find(
    (field) =>
      field.nodePath === '__irw_automatic_mirror__' &&
      field.fieldName === 'source_graph_json' &&
      typeof field.value === 'string'
  );
  const graphDisplay = typeof graphField?.value === 'string' ? recoverOriginalGraphDisplay(graphField.value) : null;
  const plan = source ? readPlan(source.id) : null;
  if (plan?.local || (plan && plan.remoteSlots.length === 0) || (!plan && !graphDisplay)) {
    return null;
  }
  if (!source) {
    return graphDisplay;
  }

  const submission = source.snapshot.backendSubmission;
  // Batch overrides are saved in the graph field, while the browser snapshot
  // may contain only the original prompt/seed for the first iteration.
  const positivePrompt =
    (graphDisplay?.positivePrompt === 'Remote workflow' ? '' : graphDisplay?.positivePrompt) ||
    getQueueItemSnapshotPositivePrompt(source) ||
    (submission.kind === 'generate' ? submission.positivePrompt : '') ||
    source.snapshot.graph.label;

  return submission.kind === 'generate'
    ? {
        positivePrompt,
        negativePrompt: graphDisplay?.negativePrompt ?? submission.negativePrompt,
        seed: graphDisplay?.seed ?? submission.seed,
      }
    : { ...graphDisplay, positivePrompt };
};
