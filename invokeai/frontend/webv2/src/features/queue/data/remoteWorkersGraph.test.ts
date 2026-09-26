import type { QueueBackendGraph } from '@features/queue/core/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOnlineRemoteWorkerUrls: vi.fn(),
  getRemoteWorkerUrls: vi.fn(),
  getRemoteWorkersSettings: vi.fn(),
  selectRemoteDispatch: vi.fn(),
}));

vi.mock('./remoteWorkersDispatch', () => ({ selectRemoteDispatch: mocks.selectRemoteDispatch }));
vi.mock('./remoteWorkersHealth', () => ({ getOnlineRemoteWorkerUrls: mocks.getOnlineRemoteWorkerUrls }));
vi.mock('./remoteWorkersStore', () => ({
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
      dispatchMode: 'mirror_all',
      autoTransferMissingModels: true,
      modelTransferHost: '  primary-host  ',
      keepRemoteCopies: false,
    });
    mocks.getRemoteWorkerUrls.mockReturnValue([worker1, worker2]);
    mocks.getOnlineRemoteWorkerUrls.mockReturnValue([worker1, worker2]);
    mocks.selectRemoteDispatch.mockReturnValue({
      local: true,
      remoteUrls: [worker1, worker2],
      remoteSlots: [1, 2],
    });
  });

  it('leaves the graph untouched when Remote Workers are disabled', () => {
    const graph = makeGraph();
    mocks.getRemoteWorkersSettings.mockReturnValue({ enabled: false });

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery', 'queue-1')).toBe(graph);
    expect(mocks.selectRemoteDispatch).not.toHaveBeenCalled();
  });

  it('leaves a graph with a manual Remote Worker dispatch node untouched', () => {
    const graph = makeGraph();
    graph.nodes.manual = { id: 'manual', type: 'remote_mirror_current_workflow' };

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery', 'queue-1')).toBe(graph);
    expect(mocks.selectRemoteDispatch).not.toHaveBeenCalled();
  });

  it('does not overwrite a pre-existing node that uses the automatic helper id', () => {
    const graph = makeGraph();
    graph.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID] = {
      id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
      type: 'some_other_node',
    };

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery', 'queue-1')).toBe(graph);
    expect(mocks.selectRemoteDispatch).not.toHaveBeenCalled();
  });

  it('injects one automatic helper while preserving the local graph for mirror dispatch', () => {
    const graph = makeGraph();
    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'gallery', 'queue-1');
    const helper = result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID];

    expect(result).not.toBe(graph);
    expect(result.edges).toEqual(graph.edges);
    expect(result.nodes.prompt).toEqual(graph.nodes.prompt);
    expect(helper).toMatchObject({
      id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
      type: AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
      remote_url: worker1,
      additional_remote_urls: worker2,
      remote_slot_indices: '1,2',
      remote_seed_mode: 'Randomize remote seed inputs',
      auto_transfer_missing_models: true,
      model_transfer_host: 'primary-host',
      keep_remote_copies: false,
      result_destination: 'gallery',
      local_gallery_board_id: 'board-1',
    });
    expect(helper).not.toHaveProperty('source_graph_json');
  });

  it('reduces a remote-only submission to the helper and embeds the untouched source graph', () => {
    const graph = makeGraph();
    mocks.getRemoteWorkersSettings.mockReturnValue({
      enabled: true,
      workerUrls: `${worker1}\n${worker2}`,
      dispatchMode: 'remotes_only',
      autoTransferMissingModels: false,
      modelTransferHost: '',
      keepRemoteCopies: true,
    });
    mocks.selectRemoteDispatch.mockReturnValue({
      local: false,
      remoteUrls: [worker1, worker2],
      remoteSlots: [1, 2],
    });

    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'gallery', 'queue-2');
    const helper = result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID];

    expect(result.edges).toEqual([]);
    expect(Object.keys(result.nodes)).toEqual([AUTOMATIC_REMOTE_WORKER_NODE_ID]);
    expect(helper?.source_graph_json).toBe(JSON.stringify(graph));
    expect(JSON.parse(String(helper?.source_graph_json))).toEqual(graph);
    expect(helper).toMatchObject({
      remote_seed_mode: 'Randomize remote seed inputs',
      result_destination: 'gallery',
      local_gallery_board_id: 'board-1',
    });
  });

  it('never carries a Gallery board into a Canvas dispatch', () => {
    const graph = makeGraph();
    const result = applyRemoteWorkersToGraph(graph, 'board-1', 'canvas', 'queue-3');

    expect(result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID]?.local_gallery_board_id).toBe('');
    expect(result.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID]?.result_destination).toBe('canvas');
  });

  it('leaves the original graph untouched when the selected plan has no remote target', () => {
    const graph = makeGraph();
    mocks.selectRemoteDispatch.mockReturnValue({ local: true, remoteUrls: [], remoteSlots: [] });

    expect(applyRemoteWorkersToGraph(graph, null, 'gallery', 'queue-local')).toBe(graph);
  });
});
