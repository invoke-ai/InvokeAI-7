import { accountLifecycle } from '@platform/state/accountLifecycle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRemoteDispatchPlan,
  isRemoteDispatchItemSettled,
  noteRemoteDispatchProgress,
  selectRemoteDispatch,
  syncLocalDispatches,
} from './remoteWorkersDispatch';
import { setRemoteWorkersSettings } from './remoteWorkersStore';

const worker1 = 'http://192.168.1.101:9090';
const worker2 = 'http://192.168.1.102:9090';

describe('Remote dispatch settlement', () => {
  beforeEach(() => {
    accountLifecycle.activate('remote-dispatch-settlement-test-user');
    setRemoteWorkersSettings({ disabledWorkerUrls: [], enabled: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('settles the reported slot and releases that worker from auto-balance load', () => {
    const current = selectRemoteDispatch('mirror_all', [worker1, worker2], 'current', [worker1, worker2]);
    expect(current).toMatchObject({
      local: true,
      remoteUrls: [worker1, worker2],
      remoteSlots: [1, 2],
    });

    noteRemoteDispatchProgress('current', 2, 'completed', 202);

    expect(isRemoteDispatchItemSettled('current', 2, 202)).toBe(true);
    expect(isRemoteDispatchItemSettled('current', 1, 202)).toBe(false);

    // Local and R1 still have the mirrored job active; R2 was released by
    // the terminal event above, so it is the least-loaded auto-balance target.
    expect(selectRemoteDispatch('auto_balance', [worker1, worker2], 'next', [worker1, worker2])).toMatchObject({
      local: false,
      remoteUrls: [worker2],
      remoteSlots: [2],
    });
  });

  it('does not age-prune an active remote dispatch', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);

    expect(selectRemoteDispatch('remotes_only', [worker1], 'long-running', [worker1])).toMatchObject({
      local: false,
      remoteUrls: [worker1],
      remoteSlots: [1],
    });

    now.mockReturnValue(4 * 60 * 60 * 1000 + 1);
    syncLocalDispatches(new Set());

    expect(getRemoteDispatchPlan('long-running')).not.toBeNull();

    noteRemoteDispatchProgress('long-running', 1, 'completed', 404);
    syncLocalDispatches(new Set());

    expect(getRemoteDispatchPlan('long-running')).toBeNull();
  });

  it('ignores duplicate terminal events for the same remote item', () => {
    selectRemoteDispatch('mirror_all', [worker1, worker2], 'duplicate', [worker1, worker2]);

    noteRemoteDispatchProgress('duplicate', 2, 'completed', 303);
    noteRemoteDispatchProgress('duplicate', 2, 'failed', 303);

    expect(isRemoteDispatchItemSettled('duplicate', 2, 303)).toBe(true);

    // A duplicate terminal event must not change load accounting twice.
    expect(
      selectRemoteDispatch('auto_balance', [worker1, worker2], 'after-duplicate', [worker1, worker2])
    ).toMatchObject({
      local: false,
      remoteUrls: [worker2],
      remoteSlots: [2],
    });
  });
});
