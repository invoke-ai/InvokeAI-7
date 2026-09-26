import type { InvocationProgressEvent } from '@features/queue/data/events';

import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { apiFetchJson } from '@platform/transport/http';

/** The primary owns the live threads; the browser only restores their UI state. */
export interface RemoteBridgeRecoverySnapshot {
  events: InvocationProgressEvent[];
  requestedAt: number;
}

type RecoveryListener = (snapshot: RemoteBridgeRecoverySnapshot) => void;
const listeners = new Set<RecoveryListener>();
let requestSequence = 0;

export const subscribeRecoveredRemoteBridges = (listener: RecoveryListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Best-effort refresh after initial page load, socket reconnect, or a tab becoming visible.
 * No worker is contacted by the browser and no job is re-enqueued. */
export const recoverActiveRemoteBridges = async (): Promise<void> => {
  const owner = captureAccountScope();
  const requestedAt = Date.now();
  const sequence = ++requestSequence;
  try {
    const events = await apiFetchJson<InvocationProgressEvent[]>('/api/v1/remote_workers/active-bridges', {
      signal: owner.signal,
    });
    if (!isAccountScopeCurrent(owner) || sequence !== requestSequence) {
      return;
    }
    const snapshot = { events, requestedAt };
    for (const listener of listeners) {
      listener(snapshot);
    }
  } catch {
    // A temporary network outage must never clear working local/remote previews.
    // A later connect/visibility refresh can retry.
  }
};
