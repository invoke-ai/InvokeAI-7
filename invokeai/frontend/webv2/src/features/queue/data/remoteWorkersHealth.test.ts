import type { QueueItem } from '@features/queue/core/historyTypes';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ apiFetchJson: vi.fn() }));
vi.mock('@platform/transport/http', () => transport);

import { getRemoteDispatchPlan, reserveRemoteDispatchPlans, selectRemoteDispatch } from './remoteWorkersDispatch';
import {
  getOnlineRemoteWorkerUrls,
  invalidateRemoteWorkerHealth,
  refreshRemoteWorkerHealth,
  remoteWorkersHealthStore,
} from './remoteWorkersHealth';
import {
  getRemoteWorkerUrls,
  getRemoteWorkersSettings,
  isRemoteWorkerEnabled,
  setRemoteWorkerEnabled,
  setRemoteWorkersSettings,
} from './remoteWorkersStore';

const worker1 = 'http://192.168.1.101:9090';
const worker2 = 'http://192.168.1.102:9090';

describe('Remote worker availability', () => {
  beforeEach(() => {
    accountLifecycle.activate('worker-health-test-user');
    setRemoteWorkersSettings({ disabledWorkerUrls: [], enabled: true });
    remoteWorkersHealthStore.setSnapshot({ byUrl: {} });
    transport.apiFetchJson.mockReset();
  });

  it('does not ping any worker or dispatch to one while rendering is disabled', async () => {
    setRemoteWorkersSettings({ enabled: false });
    await refreshRemoteWorkerHealth([worker1, worker2]);
    expect(transport.apiFetchJson).not.toHaveBeenCalled();
    expect(getOnlineRemoteWorkerUrls([worker1, worker2])).toEqual([]);

    // Re-enabling permits a fresh status check without re-adding the worker.
    setRemoteWorkersSettings({ enabled: true });
    transport.apiFetchJson.mockResolvedValue({ status: 'online' });
    await refreshRemoteWorkerHealth([worker1]);
    expect(transport.apiFetchJson).toHaveBeenCalledTimes(1);
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([worker1]);
  });

  it('ignores a pending status result after rendering is disabled', async () => {
    let finish!: (value: { status: string }) => void;
    transport.apiFetchJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = refreshRemoteWorkerHealth([worker1]);
    setRemoteWorkersSettings({ enabled: false });
    finish({ status: 'online' });
    await pending;
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([]);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]?.status).not.toBe('online');
  });

  it('excludes an offline worker but retains its configured URL and slot', async () => {
    transport.apiFetchJson.mockImplementation((path: string) =>
      Promise.resolve({ status: path.includes(encodeURIComponent(worker1)) ? 'online' : 'offline' })
    );
    await refreshRemoteWorkerHealth([worker1, worker2]);
    expect(getOnlineRemoteWorkerUrls([worker1, worker2])).toEqual([worker1]);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker2]?.status).toBe('offline');
  });

  it('automatically makes a recovered worker eligible again', async () => {
    transport.apiFetchJson.mockResolvedValueOnce({ status: 'offline' }).mockResolvedValueOnce({ status: 'online' });
    await refreshRemoteWorkerHealth([worker1]);
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([]);
    remoteWorkersHealthStore.setSnapshot({ byUrl: { [worker1]: { status: 'offline', checkedAt: 0 } } });
    await refreshRemoteWorkerHealth([worker1]);
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([worker1]);
  });

  it('preserves original R slots while filtering offline workers across modes', () => {
    expect(selectRemoteDispatch('mirror_all', [worker1, worker2], 'mirror', [worker2])).toMatchObject({
      local: true,
      remoteUrls: [worker2],
      remoteSlots: [2],
    });
    expect(selectRemoteDispatch('remotes_only', [worker1, worker2], 'only', [worker2])).toMatchObject({
      local: false,
      remoteUrls: [worker2],
      remoteSlots: [2],
    });
    expect(selectRemoteDispatch('round_robin', [worker1, worker2], 'round-1', [worker2]).local).toBe(true);
    expect(selectRemoteDispatch('round_robin', [worker1, worker2], 'round-2', [worker2]).remoteSlots).toEqual([2]);
  });

  it('keeps a disabled worker online but excludes it from all four dispatch modes', async () => {
    transport.apiFetchJson.mockResolvedValue({ status: 'online' });
    await refreshRemoteWorkerHealth([worker1, worker2]);
    setRemoteWorkerEnabled(worker1, false);

    expect(isRemoteWorkerEnabled(worker1)).toBe(false);
    expect(getOnlineRemoteWorkerUrls([worker1, worker2])).toEqual([worker2]);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]?.status).toBe('online');
    expect(selectRemoteDispatch('mirror_all', [worker1, worker2], 'disabled-mirror', [worker1, worker2])).toMatchObject(
      {
        local: true,
        remoteUrls: [worker2],
        remoteSlots: [2],
      }
    );
    expect(selectRemoteDispatch('remotes_only', [worker1, worker2], 'disabled-only', [worker1, worker2])).toMatchObject(
      { local: false, remoteUrls: [worker2], remoteSlots: [2] }
    );
    for (const mode of ['round_robin', 'auto_balance'] as const) {
      for (let index = 0; index < 4; index += 1) {
        const plan = selectRemoteDispatch(mode, [worker1, worker2], `${mode}-disabled-${index}`, [worker1, worker2]);
        expect(plan.remoteUrls).not.toContain(worker1);
        expect(plan.remoteSlots).not.toContain(1);
      }
    }

    setRemoteWorkerEnabled(worker1, true);
    expect(getOnlineRemoteWorkerUrls([worker1, worker2])).toEqual([worker1, worker2]);
  });

  it('stores the disabled choice per URL, not the worker slot, and retains it across global toggles', () => {
    setRemoteWorkerEnabled(worker1, false);
    expect(getRemoteWorkersSettings().disabledWorkerUrls).toEqual([worker1]);
    expect(getRemoteWorkerUrls(`${worker2}\n${worker1}`).filter(isRemoteWorkerEnabled)).toEqual([worker2]);
    setRemoteWorkersSettings({ enabled: false });
    setRemoteWorkersSettings({ enabled: true });
    expect(isRemoteWorkerEnabled(worker1)).toBe(false);
    setRemoteWorkerEnabled(worker1, true);
    expect(getRemoteWorkersSettings().disabledWorkerUrls).toEqual([]);
  });

  it('keeps an already assigned job intact but excludes its worker from new dispatches', () => {
    const assigned = selectRemoteDispatch('remotes_only', [worker1, worker2], 'already-submitted', [worker1]);
    expect(assigned.remoteUrls).toEqual([worker1]);
    setRemoteWorkerEnabled(worker1, false);
    expect(selectRemoteDispatch('remotes_only', [worker1, worker2], 'already-submitted', [worker1])).toBe(assigned);
    expect(selectRemoteDispatch('remotes_only', [worker1, worker2], 'new-job', [worker1, worker2])).toMatchObject({
      local: false,
      remoteUrls: [worker2],
      remoteSlots: [2],
    });
  });

  it('does not select disabled workers when every remote is disabled', async () => {
    transport.apiFetchJson.mockResolvedValue({ status: 'online' });
    await refreshRemoteWorkerHealth([worker1, worker2]);
    setRemoteWorkerEnabled(worker1, false);
    setRemoteWorkerEnabled(worker2, false);
    expect(getOnlineRemoteWorkerUrls([worker1, worker2])).toEqual([]);
    expect(selectRemoteDispatch('remotes_only', [worker1, worker2], 'none', [worker1, worker2])).toMatchObject({
      local: false,
      remoteUrls: [],
    });
    expect(selectRemoteDispatch('mirror_all', [worker1, worker2], 'local-only', [worker1, worker2])).toMatchObject({
      local: true,
      remoteUrls: [],
    });
  });

  it('does not create a phantom remote tile for a local run submitted before remotes were enabled', () => {
    setRemoteWorkersSettings({ workerUrls: worker1, dispatchMode: 'mirror_all' });
    remoteWorkersHealthStore.setSnapshot({
      byUrl: { [worker1]: { status: 'online', checkedAt: Date.now() } },
    });
    const snapshot: QueueItem['snapshot'] = {
      backendSubmission: {
        kind: 'workflow',
        batchCount: 1,
        graph: {
          id: 'test-graph',
          nodes: {},
          edges: [],
        },
      },
      sourceId: 'workflow',
      destination: 'gallery',
      graph: {
        id: 'test-graph',
        label: 'Test workflow',
      },
      galleryBoardId: null,
      filterIntermediateResults: true,
      presentation: {
        batchCount: 1,
        width: 1024,
        height: 1024,
      },
      submittedAt: '2026-09-23T00:00:00Z',
    };
    const localAlreadyRunning = {
      id: 'pre-toggle-local',
      status: 'running',
      cancellable: true,
      backendItemIds: [101],
      snapshot,
    } as QueueItem;
    const newlyQueued = {
      id: 'post-toggle-mirror',
      status: 'pending',
      cancellable: true,
      snapshot: { ...snapshot, submittedAt: '2026-09-23T00:01:00Z' },
    } as QueueItem;

    reserveRemoteDispatchPlans([localAlreadyRunning, newlyQueued]);

    expect(getRemoteDispatchPlan(localAlreadyRunning.id)).toBeNull();
    expect(getRemoteDispatchPlan(newlyQueued.id)).toMatchObject({
      local: true,
      remoteUrls: [worker1],
      remoteSlots: [1],
    });
  });

  it('forces a fresh worker probe after credential health is invalidated', async () => {
    remoteWorkersHealthStore.setSnapshot({
      byUrl: { [worker1]: { status: 'login_required', checkedAt: Date.now() } },
    });
    transport.apiFetchJson.mockResolvedValue({ status: 'online' });

    await refreshRemoteWorkerHealth([worker1]);
    expect(transport.apiFetchJson).not.toHaveBeenCalled();

    invalidateRemoteWorkerHealth(worker1);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]).toBeUndefined();

    await refreshRemoteWorkerHealth([worker1]);
    expect(transport.apiFetchJson).toHaveBeenCalledTimes(1);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]?.status).toBe('online');
  });

  it('ignores an older in-flight health result after credentials change', async () => {
    let finishOld!: (value: { status: string }) => void;
    let finishNew!: (value: { status: string }) => void;
    transport.apiFetchJson
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          })
      );

    const oldProbe = refreshRemoteWorkerHealth([worker1]);
    await vi.waitFor(() => expect(transport.apiFetchJson).toHaveBeenCalledTimes(1));

    invalidateRemoteWorkerHealth(worker1);
    const newProbe = refreshRemoteWorkerHealth([worker1]);
    await vi.waitFor(() => expect(transport.apiFetchJson).toHaveBeenCalledTimes(2));

    finishOld({ status: 'login_required' });
    finishNew({ status: 'online' });
    await Promise.all([oldProbe, newProbe]);

    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]?.status).toBe('online');
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([worker1]);
  });

  it('does not mark a worker online when its saved login is rejected', async () => {
    transport.apiFetchJson.mockResolvedValue({ status: 'login_required' });
    await refreshRemoteWorkerHealth([worker1]);
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([]);
    expect(remoteWorkersHealthStore.getSnapshot().byUrl[worker1]?.status).toBe('login_required');
  });

  it('discards results from a previous account', async () => {
    let finish!: (value: { status: string }) => void;
    transport.apiFetchJson.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = refreshRemoteWorkerHealth([worker1]);
    accountLifecycle.activate('another-user');
    finish({ status: 'online' });
    await pending;
    expect(getOnlineRemoteWorkerUrls([worker1])).toEqual([]);
  });
});
