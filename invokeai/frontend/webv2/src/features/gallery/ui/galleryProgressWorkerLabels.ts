import type { QueueItemProgressTarget } from '@features/queue/contracts';

import { getRemoteProgressIdentity } from '@features/queue/contracts';

type ProgressTileIdentity = QueueItemProgressTarget & { id: string };

/** Label only remote workers; the unlabelled preview is Local. */
export const getGalleryWorkerLabels = (
  sessions: readonly ProgressTileIdentity[],
  getQueuedRemoteSlot: (queueItemId: string) => number | null = () => null
): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const remote = getRemoteProgressIdentity(session);
    if (remote) {
      labels.set(session.id, `R${remote.slot}`);
      continue;
    }
    // Remote-only or one-target round-robin: the queued local backend item is
    // just the lightweight dispatcher, not a local image generation. Label it
    // before the remote bridge sends its first frame. Never label local work.
    const slot = getQueuedRemoteSlot(session.queueItemId);
    if (slot !== null) {
      labels.set(session.id, `R${slot}`);
    }
  }
  return labels;
};
