import type { QueueBackendGraph } from '@features/queue/core/types';

import { describe, expect, it } from 'vitest';

import { prepareRemoteOnlyBatch } from './remoteWorkersBatch';
import { AUTOMATIC_REMOTE_WORKER_NODE_ID, AUTOMATIC_REMOTE_WORKER_NODE_TYPE } from './remoteWorkersGraphContract';

const makeSourceGraph = (): QueueBackendGraph => ({
  id: 'source',
  edges: [
    {
      source: { node_id: 'prompt', field: 'text' },
      destination: { node_id: 'denoise', field: 'positive_conditioning' },
    },
  ],
  nodes: {
    prompt: { id: 'prompt', type: 'string', text: 'base prompt' },
    seed: { id: 'seed', type: 'integer', value: 1 },
    denoise: { id: 'denoise', type: 'denoise' },
  },
});

const makeRemoteOnlyGraph = (source = makeSourceGraph()): QueueBackendGraph => ({
  id: 'remote-only',
  edges: [],
  nodes: {
    [AUTOMATIC_REMOTE_WORKER_NODE_ID]: {
      id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
      type: AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
      source_graph_json: JSON.stringify(source),
    },
  },
});

describe('prepareRemoteOnlyBatch', () => {
  it('leaves a normal graph and batch data unchanged', () => {
    const graph = makeSourceGraph();
    const data = [[{ field_name: 'text', items: ['one', 'two'], node_path: 'prompt' }]];

    expect(prepareRemoteOnlyBatch(graph, data)).toEqual({ graph, data });
  });

  it('returns no batch data when the remote-only source has no varying fields', () => {
    const graph = makeRemoteOnlyGraph();

    expect(prepareRemoteOnlyBatch(graph, undefined)).toEqual({ graph, data: undefined });
  });

  it('keeps fields in one batch group zipped by index', () => {
    const graph = makeRemoteOnlyGraph();
    const data = [
      [
        { field_name: 'text', items: ['first', 'second'], node_path: 'prompt' },
        { field_name: 'value', items: [101, 202], node_path: 'seed' },
      ],
    ];

    const prepared = prepareRemoteOnlyBatch(graph, data);
    const serialized = prepared.data?.[0]?.[0]?.items;

    expect(serialized).toHaveLength(2);
    const variants = serialized?.map((value) => JSON.parse(String(value)) as QueueBackendGraph) ?? [];
    expect(variants.map((variant) => variant.nodes.prompt?.text)).toEqual(['first', 'second']);
    expect(variants.map((variant) => variant.nodes.seed?.value)).toEqual([101, 202]);
  });

  it('expands separate batch groups as a Cartesian product', () => {
    const graph = makeRemoteOnlyGraph();
    const data = [
      [{ field_name: 'text', items: ['A', 'B'], node_path: 'prompt' }],
      [{ field_name: 'value', items: [10, 20, 30], node_path: 'seed' }],
    ];

    const prepared = prepareRemoteOnlyBatch(graph, data);
    const serialized = prepared.data?.[0]?.[0]?.items ?? [];
    const variants = serialized.map((value) => JSON.parse(String(value)) as QueueBackendGraph);

    expect(variants).toHaveLength(6);
    expect(variants.map((variant) => [variant.nodes.prompt?.text, variant.nodes.seed?.value])).toEqual([
      ['A', 10],
      ['A', 20],
      ['A', 30],
      ['B', 10],
      ['B', 20],
      ['B', 30],
    ]);
  });

  it('does not mutate the serialized source graph while expanding variants', () => {
    const source = makeSourceGraph();
    const graph = makeRemoteOnlyGraph(source);

    prepareRemoteOnlyBatch(graph, [[{ field_name: 'text', items: ['changed'], node_path: 'prompt' }]]);

    expect(JSON.parse(String(graph.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID]?.source_graph_json))).toEqual(source);
    expect(source.nodes.prompt?.text).toBe('base prompt');
  });

  it('rejects unequal field lengths within one zipped batch group', () => {
    const graph = makeRemoteOnlyGraph();

    expect(() =>
      prepareRemoteOnlyBatch(graph, [
        [
          { field_name: 'text', items: ['one', 'two'], node_path: 'prompt' },
          { field_name: 'value', items: [1], node_path: 'seed' },
        ],
      ])
    ).toThrow('Remote-only batch contains unequal zipped field lengths');
  });

  it('rejects batch fields that reference a missing source node', () => {
    const graph = makeRemoteOnlyGraph();

    expect(() => prepareRemoteOnlyBatch(graph, [[{ field_name: 'value', items: [1], node_path: 'missing' }]])).toThrow(
      'Remote-only batch field references missing source node: missing'
    );
  });
});
