import type { QueueBackendGraph } from '@features/queue/core/types';

import { AUTOMATIC_REMOTE_WORKER_NODE_ID } from './remoteWorkersGraphContract';

type BatchDatum = { field_name: string; items: unknown[]; node_path: string };

/**
 * Remote-only queue items contain ONLY the lightweight kickoff node. Preserve
 * InvokeAI's prompt/seed batch dimensions by expanding each original prepared
 * graph into the kickoff's JSON input (rather than targeting missing local nodes).
 * `runs` stays unchanged: it repeats each expanded graph exactly as before.
 */
export const prepareRemoteOnlyBatch = (
  graph: QueueBackendGraph,
  data: BatchDatum[][] | undefined
): { graph: QueueBackendGraph; data: BatchDatum[][] | undefined } => {
  const kickoff = graph.nodes[AUTOMATIC_REMOTE_WORKER_NODE_ID];
  if (typeof kickoff?.source_graph_json !== 'string') {
    return { graph, data };
  }
  const original = JSON.parse(kickoff.source_graph_json) as QueueBackendGraph;
  if (!original.nodes || !Array.isArray(original.edges)) {
    throw new Error('Remote-only source graph is invalid');
  }
  if (!data?.length) {
    return { graph, data: undefined };
  }
  let graphs = [original];
  for (const group of data) {
    if (group.length === 0) {
      continue;
    }
    const length = group[0]!.items.length;
    if (group.some((entry) => entry.items.length !== length)) {
      throw new Error('Remote-only batch contains unequal zipped field lengths');
    }
    const next: QueueBackendGraph[] = [];
    for (const variant of graphs) {
      for (let index = 0; index < length; index += 1) {
        const copy = JSON.parse(JSON.stringify(variant)) as QueueBackendGraph;
        for (const entry of group) {
          const node = copy.nodes[entry.node_path];
          if (!node) {
            throw new Error(`Remote-only batch field references missing source node: ${entry.node_path}`);
          }
          node[entry.field_name] = entry.items[index];
        }
        next.push(copy);
      }
    }
    graphs = next;
  }
  const serialized = graphs.map((variant) => JSON.stringify(variant));
  return {
    graph,
    data: [[{ field_name: 'source_graph_json', items: serialized, node_path: AUTOMATIC_REMOTE_WORKER_NODE_ID }]],
  };
};
