import type { captureAccountScope } from '@platform/state/accountLifecycle';

import { assertAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { apiFetchJson } from '@platform/transport/http';

type OwnerScope = ReturnType<typeof captureAccountScope>;

type RemoteCancellation = { item_id: number } | { origin_prefix: string | null; keep_current: boolean };

interface RemoteCancelResponse {
  matched: number;
  canceled: number;
  already_finished: number;
  failed: number;
}

/**
 * One cancellation seam for the queue header, dropdowns, and individual rows.
 * Always attempt native cancellation even if a remote host or the bridge API is
 * unreachable. The Canvas staging button retains its existing UUID-based path.
 */
export const cancelWithRemoteWorkers = async (
  target: RemoteCancellation,
  cancelLocal: () => Promise<void>,
  owner: OwnerScope
): Promise<void> => {
  const path = 'item_id' in target ? '/cancel-queue-item' : '/cancel-scoped';
  let remoteError: unknown;

  try {
    const result = await apiFetchJson<RemoteCancelResponse>(`/api/v1/remote_workers${path}`, {
      body: JSON.stringify(target),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
      signal: owner.signal,
    });
    if (result.failed > 0) {
      throw new Error(`${result.failed} remote worker cancellation request(s) failed. Check the server log.`);
    }
  } catch (error: unknown) {
    remoteError = error;
  }

  // Don't issue a local mutation under a new account after asynchronous I/O.
  assertAccountScopeCurrent(owner);
  await cancelLocal();
  assertAccountScopeCurrent(owner);
  if (remoteError) {
    throw remoteError;
  }
};
