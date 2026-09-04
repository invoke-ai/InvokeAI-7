import type { CanvasLoadRefusal } from './canvasLoadContracts';
import type { RefusedWorkbenchProject } from './projectContracts';

import { isRecord, loadCanvasState } from './canvasMigration';

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const invalidQueueSnapshot = (raw: unknown, path: string, message: string): CanvasLoadRefusal => ({
  diagnostics: [{ message, path }],
  raw,
  scope: 'snapshot',
  status: 'invalid',
});

/**
 * The project-ingestion gate: version-checks every canvas embedded in a raw project document
 * before anything migrates, defaults, or clones it. A live canvas is refused for any load
 * failure. Queue history is gated before normalization too: refusing the containing project is what
 * keeps the malformed snapshot available in the existing raw-project recovery path.
 */
export const gateProjectCanvases = (raw: unknown): RefusedWorkbenchProject | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const refuse = (
    refusal: CanvasLoadRefusal,
    source: RefusedWorkbenchProject['source'],
    queueItem?: RefusedWorkbenchProject['queueItem']
  ): RefusedWorkbenchProject => ({
    projectId: asString(raw.id),
    projectName: asString(raw.name),
    raw,
    refusal,
    source,
    ...(queueItem ? { queueItem } : {}),
  });

  const canvas = loadCanvasState(raw.canvas);
  if (canvas.status !== 'loaded') {
    return refuse(canvas, 'canvas');
  }

  const items = isRecord(raw.queue) && Array.isArray(raw.queue.items) ? raw.queue.items : [];
  for (const [index, item] of items.entries()) {
    const itemId = isRecord(item) && typeof item.id === 'string' ? item.id : null;
    if (!isRecord(item)) {
      return refuse(invalidQueueSnapshot(item, `queue.items[${index}]`, 'queue item is invalid'), 'queue-item', {
        index,
        itemId,
      });
    }
    if (!isRecord(item.snapshot)) {
      return refuse(
        invalidQueueSnapshot(item.snapshot, `queue.items[${index}].snapshot`, 'queue snapshot is missing or invalid'),
        'queue-item',
        { index, itemId }
      );
    }
    const result = isRecord(item.snapshot.canvas)
      ? loadCanvasState(item.snapshot.canvas)
      : invalidQueueSnapshot(
          item.snapshot.canvas,
          `queue.items[${index}].snapshot.canvas`,
          'queue snapshot canvas is missing or invalid'
        );
    if (result.status !== 'loaded') {
      return refuse(result, 'queue-item', { index, itemId });
    }
  }
  return null;
};
