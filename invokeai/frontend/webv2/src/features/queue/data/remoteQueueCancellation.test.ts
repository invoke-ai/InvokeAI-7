import { accountLifecycle, captureAccountScope } from '@platform/state/accountLifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  apiFetchJson: vi.fn(),
}));

vi.mock('@platform/transport/http', () => transport);

import { cancelRemoteGeneration, cancelWithRemoteWorkers } from './remoteQueueCancellation';

describe('cancelWithRemoteWorkers', () => {
  beforeEach(() => {
    accountLifecycle.activate('irw-test-user');
    transport.apiFetchJson.mockReset();
    transport.apiFetchJson.mockResolvedValue({ matched: 1, canceled: 1, already_finished: 0, failed: 0 });
  });

  it('cancels one remote generation by Workbench queue UUID', async () => {
    await cancelRemoteGeneration('queue-uuid');

    expect(transport.apiFetchJson).toHaveBeenCalledWith('/api/v1/remote_workers/cancel', {
      body: '{"queue_item_id":"queue-uuid"}',
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
      signal: expect.any(AbortSignal),
    });
  });

  it('starts native cancellation before owner-scoped remote cleanup', async () => {
    const calls: string[] = [];
    transport.apiFetchJson.mockImplementation(() => {
      calls.push('remote');
      return Promise.resolve({ matched: 1, canceled: 1, already_finished: 0, failed: 0 });
    });
    const cancelLocal = vi.fn(() => {
      calls.push('local');
      return Promise.resolve();
    });

    await cancelWithRemoteWorkers({ item_id: 14 }, cancelLocal, captureAccountScope());

    expect(calls).toEqual(['local', 'remote']);
    expect(transport.apiFetchJson.mock.calls[0]?.[0]).toBe('/api/v1/remote_workers/cancel-queue-item');
    expect(transport.apiFetchJson.mock.calls[0]?.[1]).toMatchObject({
      body: '{"item_id":14}',
      method: 'PUT',
    });
  });

  it('passes the origin scope and keep-current selection to the remote bridge', async () => {
    await cancelWithRemoteWorkers(
      { origin_prefix: 'webv2:p:example:q:', keep_current: true },
      () => Promise.resolve(),
      captureAccountScope()
    );
    expect(transport.apiFetchJson.mock.calls[0]?.[0]).toBe('/api/v1/remote_workers/cancel-scoped');
    expect(transport.apiFetchJson.mock.calls[0]?.[1]).toMatchObject({
      body: '{"origin_prefix":"webv2:p:example:q:","keep_current":true}',
      method: 'PUT',
    });
  });

  it('still cancels local work and reports a remote host failure', async () => {
    transport.apiFetchJson.mockResolvedValue({ matched: 1, canceled: 0, already_finished: 0, failed: 1 });
    const cancelLocal = vi.fn(() => Promise.resolve());
    await expect(cancelWithRemoteWorkers({ item_id: 14 }, cancelLocal, captureAccountScope())).rejects.toThrow(
      /1 remote worker/
    );
    expect(cancelLocal).toHaveBeenCalledOnce();
  });

  it('still cancels local work when the remote endpoint is unreachable', async () => {
    transport.apiFetchJson.mockRejectedValue(new Error('Network unavailable'));
    const cancelLocal = vi.fn(() => Promise.resolve());
    await expect(cancelWithRemoteWorkers({ item_id: 14 }, cancelLocal, captureAccountScope())).rejects.toThrow(
      'Network unavailable'
    );
    expect(cancelLocal).toHaveBeenCalledOnce();
  });
});
