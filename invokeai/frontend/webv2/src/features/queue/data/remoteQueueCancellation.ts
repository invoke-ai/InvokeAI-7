import { assertAccountScopeCurrent, captureAccountScope } from '@platform/state/accountLifecycle';
import { apiFetchJson } from '@platform/transport/http';

type OwnerScope = ReturnType<typeof captureAccountScope>;

type RemoteCancellation = { item_id: number } | { origin_prefix: string | null; keep_current: boolean };

interface RemoteCancelResponse {
  matched: number;
  canceled: number;
  already_finished: number;
  failed: number;
}

const assertRemoteCancellationSucceeded = (result: RemoteCancelResponse): void => {
  if (result.failed > 0) {
    throw new Error(`${result.failed} remote worker cancellation request(s) failed. Check the server log.`);
  }
};

/** Owner-scoped bridge cancellation by the original Workbench queue UUID. */
export const cancelRemoteGeneration = async (queueItemId: string): Promise<void> => {
  const owner = captureAccountScope();
  const result = await apiFetchJson<RemoteCancelResponse>('/api/v1/remote_workers/cancel', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue_item_id: queueItemId }),
    signal: owner.signal,
  });
  assertAccountScopeCurrent(owner);
  assertRemoteCancellationSucceeded(result);
};

/**
 * One cancellation seam for the queue header, dropdowns, and individual rows.
 * Always attempt native cancellation even if a remote host or the bridge API is
 * unreachable.
 */
export const cancelWithRemoteWorkers = async (
  target: RemoteCancellation,
  cancelLocal: () => Promise<void>,
  owner: OwnerScope
): Promise<void> => {
  const path = 'item_id' in target ? '/cancel-queue-item' : '/cancel-scoped';

  // Start native cancellation immediately. Remote cleanup may need to wait on
  // an unavailable worker, but it must never delay stopping the local job.
  assertAccountScopeCurrent(owner);
  let localCancellation: Promise<void>;
  try {
    localCancellation = cancelLocal();
  } catch (error: unknown) {
    localCancellation = Promise.reject(error);
  }

  const remoteCancellation = (async (): Promise<void> => {
    const result = await apiFetchJson<RemoteCancelResponse>(`/api/v1/remote_workers${path}`, {
      body: JSON.stringify(target),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
      signal: owner.signal,
    });
    assertRemoteCancellationSucceeded(result);
  })();

  const [localResult, remoteResult] = await Promise.allSettled([localCancellation, remoteCancellation]);
  assertAccountScopeCurrent(owner);

  if (localResult.status === 'rejected') {
    throw localResult.reason;
  }
  if (remoteResult.status === 'rejected') {
    throw remoteResult.reason;
  }
};
