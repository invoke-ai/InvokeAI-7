import type { QueueBackendGraph } from '@features/queue/core/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOnlineRemoteWorkerUrls: vi.fn(),
  getRemoteWorkerName: vi.fn(),
  getRemoteWorkerUrls: vi.fn(),
  getRemoteWorkersSettings: vi.fn(),
}));

vi.mock('./remoteWorkersHealth', () => ({ getOnlineRemoteWorkerUrls: mocks.getOnlineRemoteWorkerUrls }));
vi.mock('./remoteWorkersStore', () => ({
  getRemoteWorkerName: mocks.getRemoteWorkerName,
  getRemoteWorkerUrls: mocks.getRemoteWorkerUrls,
  getRemoteWorkersSettings: mocks.getRemoteWorkersSettings,
}));

import { applyRemoteWorkersToGraph } from './remoteWorkersGraph';
import { AUTOMATIC_REMOTE_WORKER_NODE_ID, AUTOMATIC_REMOTE_WORKER_NODE_TYPE } from './remoteWorkersGraphContract';

const worker1 = 'http://worker-1:9090';
const worker2 = 'http://worker-2:9090';

const makeGraph = (): QueueBackendGraph => ({
  id: 'graph-1',
  edges: [
    {
      source: { node_id: 'prompt', field: 'text' },
      destination: { node_id: 'denoise', field: 'positive_conditioning' },
    },
  ],
  nodes: {
    prompt: { id: 'prompt', type: 'string', text: 'hello' },
    denoise: { id: 'denoise', type: 'denoise' },
  },
});

describe('applyRemoteWorkersToGraph', () => {
  beforeEach(() => {
    mocks.getRemoteWorkersSettings.mockReturnValue({
      enabled: true,
      workerUrls: `${worker1}\n${worker2}`,
      workerNames: {},
      disabledWorkerUrls: [],
      dispatchMode: 'distributed',
      autoTransferMissingModels: true,
      modelTransferHost: '  primary-host  ',
      keepRemoteCopies: false,
    });
    mocks.getRemoteWorkerUrls.mockReturnValue([worker1, worker2]);
    mocks.getOnlineRemoteWorkerUrls.mockReturnValue([worker1, worker2]);
    mocks.getRemoteWorkerName.mockImplementation((_url: string, index: number) =>
      index === 0 ? 'RTX5080' : 'Server GPU'
    );
  });

  it('leaves the graph untouched when Remote Workers are disabled', () => {
    const graph = makeGraph();
    mocks.getRemoteWorkersSettings.mockReturnValue({ enabled: false });

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery')).toBe(graph);
  });

  it('does not overwrite a pre-existing node that uses the automatic helper id', () => {
    const graph = makeGraph();
    graph.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID] = {
      id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
      type: 'some_other_node',
    };

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery')).toBe(graph);
  });

  it('injects one Distributed helper while preserving the executable graph', () => {
    const graph = makeGraph();
    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'gallery');
    const helper = result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID];

    expect(result).not.toBe(graph);
    expect(result.edges).toEqual(graph.edges);
    expect(result.nodes.prompt).toEqual(graph.nodes.prompt);
    expect(helper).toMatchObject({
      id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
      type: AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
      remote_url: worker1,
      additional_remote_urls: worker2,
      remote_worker_names: JSON.stringify(['RTX5080', 'Server GPU']),
      dispatch_mode: 'Distributed',
      auto_transfer_missing_models: true,
      model_transfer_host: 'primary-host',
      keep_remote_copies: false,
      result_destination: 'gallery',
      local_gallery_board_id: 'board-1',
    });
    expect(helper).not.toHaveProperty('source_graph_json');
  });

  it('keeps the executable graph intact for Remote Only', () => {
    const graph = makeGraph();
    mocks.getRemoteWorkersSettings.mockReturnValue({
      enabled: true,
      workerUrls: `${worker1}\n${worker2}`,
      workerNames: {},
      disabledWorkerUrls: [],
      dispatchMode: 'remote_only',
      autoTransferMissingModels: false,
      modelTransferHost: '',
      keepRemoteCopies: true,
    });

    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'gallery');
    const helper = result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID];

    expect(result.edges).toEqual(graph.edges);
    expect(result.nodes.prompt).toEqual(graph.nodes.prompt);
    expect(helper).toMatchObject({
      dispatch_mode: 'Remote Only',
      result_destination: 'gallery',
      local_gallery_board_id: 'board-1',
      keep_remote_copies: true,
    });
    expect(helper).not.toHaveProperty('source_graph_json');
  });

  it('never carries a Gallery board into a Canvas dispatch', () => {
    const graph = makeGraph();
    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'canvas');

    expect(result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID]?.local_gallery_board_id).toBe('');
    expect(result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID]?.result_destination).toBe('canvas');
  });

  it('leaves the graph untouched when no enabled online worker is available', () => {
    const graph = makeGraph();
    mocks.getOnlineRemoteWorkerUrls.mockReturnValue([]);

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery')).toBe(graph);
  });
});
