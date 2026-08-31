import type { GenerateWidgetValues } from '@features/generation/contracts';
import type { InvocationSourceId } from '@workbench/invocationContracts';
import type { Project } from '@workbench/projectContracts';

import { parseQueueItemOrigin } from '@features/queue/contracts';
import { useWorkbenchSelector } from '@workbench/WorkbenchContext';

/**
 * The full Generate settings snapshot for a server queue item, if this client
 * submitted it. webv2 stamps the local submission id into each item's `origin`,
 * so we decode it and look the snapshot up in local state. Present → "Use again"
 * can recall the exact settings (model, steps, LoRAs, …); absent (item from
 * another client, or a cleared snapshot) → only field_values are recoverable.
 */
/**
 * The local queue item a server item's origin points at, or null. The single
 * resolution both lookups below build on: deriving the item's source and its
 * Generate snapshot from two independent scans would let them disagree about
 * WHICH item they matched, and a capability matrix computed from one item while
 * the recall routes by another is how a verb ends up enabled but unserviceable.
 */
const findLocalQueueItem = (
  projects: readonly Pick<Project, 'queue'>[],
  origin?: string | null
): Project['queue']['items'][number] | null => {
  const localId = parseQueueItemOrigin(origin);

  if (!localId) {
    return null;
  }

  for (const project of projects) {
    const localItem = project.queue.items.find((queueItem) => queueItem.id === localId);

    if (localItem) {
      return localItem;
    }
  }

  return null;
};

export const useLocalGenerateValues = (origin?: string | null): GenerateWidgetValues | null =>
  useWorkbenchSelector((snapshot) => {
    const localItem = findLocalQueueItem(snapshot.projects, origin);

    if (!localItem || (localItem.snapshot.sourceId !== 'generate' && localItem.snapshot.sourceId !== 'canvas')) {
      return null;
    }

    const generate = (localItem.snapshot.widgetStates as Record<string, { values?: unknown }>).generate;

    return (generate?.values as GenerateWidgetValues | undefined) ?? null;
  });

/**
 * The invocation source a server queue item was submitted from, if this client
 * submitted it. Decoded the same way as {@link useLocalGenerateValues}, but kept
 * separate because it answers a different question and returns a primitive, so
 * it re-renders its host only when the source actually changes.
 *
 * `null` means "unknown", not "not video": a foreign item — or one whose local
 * snapshot has been cleared — carries no source, and its `field_values` cannot
 * distinguish a video batch from an image one (both record a seed and prompts
 * through the same batch plan). Callers must treat null as the Generate-shaped
 * default rather than assuming a source.
 */
export const getLocalQueueItemSource = (
  projects: readonly Pick<Project, 'queue'>[],
  origin?: string | null
): InvocationSourceId | null => findLocalQueueItem(projects, origin)?.snapshot.sourceId ?? null;

export const useLocalQueueItemSource = (origin?: string | null): InvocationSourceId | null =>
  useWorkbenchSelector((snapshot) => getLocalQueueItemSource(snapshot.projects, origin));
