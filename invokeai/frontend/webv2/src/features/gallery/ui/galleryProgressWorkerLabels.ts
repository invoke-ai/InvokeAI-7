import type { QueueItemProgressTarget } from '@features/queue/contracts';

import { getRemoteProgressIdentity } from '@features/queue/contracts';

type ProgressTileIdentity = QueueItemProgressTarget & { id: string };

/** Label only remote workers; the unlabelled preview is Local. */
export const getGalleryWorkerLabels = (sessions: readonly ProgressTileIdentity[]): ReadonlyMap<string, string> => {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const remote = getRemoteProgressIdentity(session);
    if (remote) {
      labels.set(session.id, `R${remote.slot}`);
    }
  }
  return labels;
};
