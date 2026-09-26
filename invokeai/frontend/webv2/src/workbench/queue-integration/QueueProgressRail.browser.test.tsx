/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import { ChakraProvider } from '@chakra-ui/react';
import { getRemoteProgressTarget } from '@features/queue/core/remoteProgress';
import { selectRemoteDispatch } from '@features/queue/data/remoteWorkersDispatch';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Share rail visibility/progress coverage across topbar and floating Preview: offline/idle hides, unstepped runs
 * sweep, stepped runs fill.
 */

const state = vi.hoisted(() => ({
  activeItemIds: [] as number[],
  remoteTargets: [] as { queueItemId: string; itemIndex: number }[],
  generatingRemoteIds: new Set<string>(),
  isConnected: true,
  percentage: null as number | null,
  queueItems: [] as {
    backendItemIds: number[];
    id: string;
    status: string;
    snapshot: {
      graph: { label: string };
      presentation: Record<string, never>;
      sourceId: string;
      submittedAt: string;
    };
  }[],
}));

vi.mock('@features/models', () => ({ useModelLoads: () => [] }));
vi.mock('@features/queue/react', () => ({
  useActiveProgressTargets: () => [
    ...state.activeItemIds.flatMap((backendItemId) => {
      const item = state.queueItems.find((entry) => entry.backendItemIds.includes(backendItemId));
      const index = item?.backendItemIds.indexOf(backendItemId) ?? -1;
      return item && index >= 0 ? [{ queueItemId: item.id, itemIndex: index + 1 }] : [];
    }),
    ...state.remoteTargets,
  ],
  useGeneratingRemotePreviewIds: () => state.generatingRemoteIds,
  useItemProgress: (itemId: number | null) => (itemId === null ? null : { percentage: state.percentage }),
}));
vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (select: (project: unknown) => unknown) => select({ queue: { items: state.queueItems } }),
  useWorkbenchSelector: (select: (snapshot: unknown) => unknown) =>
    select({ backendConnection: { status: state.isConnected ? 'connected' : 'disconnected' } }),
}));

import { QueueProgressRail } from './QueueProgressRail';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = async () => {
  await act(async () => {
    root?.render(
      <ChakraProvider value={system}>
        <QueueProgressRail css={{ height: '3px', position: 'absolute', top: 0, insetInline: 0 }} />
      </ChakraProvider>
    );
    await Promise.resolve();
  });

  return host?.querySelector<HTMLElement>('[data-queue-progress-rail]') ?? null;
};

const runningItem = {
  backendItemIds: [7],
  id: 'item-7',
  snapshot: {
    graph: { label: 'Test generation' },
    presentation: {},
    sourceId: 'generate',
    submittedAt: '2026-07-16T00:00:00.000Z',
  },
  status: 'running',
};

beforeEach(() => {
  state.activeItemIds = [];
  state.remoteTargets = [];
  state.generatingRemoteIds = new Set();
  state.isConnected = true;
  state.percentage = null;
  state.queueItems = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('QueueProgressRail', () => {
  it('renders nothing while the queue is idle', async () => {
    expect(await render()).toBeNull();
  });

  it('renders nothing while the backend is away, even with open work', async () => {
    state.queueItems = [runningItem];
    state.activeItemIds = [7];
    state.isConnected = false;

    expect(await render()).toBeNull();
  });

  it('preserves the pending sweep while ordinary local work is queued', async () => {
    state.queueItems = [{ ...runningItem, status: 'pending' }];

    const sweeping = await render();
    expect(sweeping).not.toBeNull();
    expect(sweeping?.querySelector('[style*="width"]')).toBeNull();
  });

  it('hides queued remote-only work until its worker begins rendering', async () => {
    const remoteOnlyItem = { ...runningItem, id: 'remote-only-item' };
    state.queueItems = [remoteOnlyItem];
    selectRemoteDispatch('remotes_only', ['http://worker'], remoteOnlyItem.id, ['http://worker']);
    const remote = getRemoteProgressTarget(remoteOnlyItem.id, 1, 7);
    state.remoteTargets = [remote];

    expect(await render()).toBeNull();

    state.generatingRemoteIds = new Set([`${remote.queueItemId}:${remote.itemIndex}`]);
    const rendering = await render();
    expect(rendering).not.toBeNull();
    expect(rendering?.children).toHaveLength(1);
  });

  it('allocates rail width only to rendering sessions, not queued remotes', async () => {
    state.queueItems = [runningItem];
    state.activeItemIds = [7];
    const remote = getRemoteProgressTarget(runningItem.id, 1, 7);
    state.remoteTargets = [remote];

    const localOnly = await render();
    expect(localOnly?.children).toHaveLength(1);

    state.generatingRemoteIds = new Set([`${remote.queueItemId}:${remote.itemIndex}`]);
    const bothRendering = await render();
    expect(bothRendering?.children).toHaveLength(2);
  });

  it('sweeps while the running item has not reported a step, then fills to its fraction', async () => {
    state.queueItems = [runningItem];
    state.activeItemIds = [7];

    const sweeping = await render();
    expect(sweeping).not.toBeNull();
    expect(sweeping?.querySelector('[style*="width"]')).toBeNull();

    state.percentage = 0.4;
    const filling = await render();
    const fill = filling?.querySelector<HTMLElement>('[style*="width"]');
    expect(fill?.style.width).toBe('40%');
  });
});
