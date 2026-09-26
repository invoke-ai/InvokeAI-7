import type { QueueBackendGraph } from '@features/queue/core/types';

export const AUTOMATIC_REMOTE_WORKER_NODE_ID = '__irw_automatic_mirror__';
export const AUTOMATIC_REMOTE_WORKER_NODE_TYPE = 'irw_builtin_mirror_current_workflow';

const REMOTE_WORKER_DISPATCH_NODE_TYPES = new Set([
  'remote_mirror_current_workflow',
  AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
]);

export const hasRemoteWorkerDispatchNode = (graph: QueueBackendGraph): boolean =>
  Object.values(graph.nodes).some((node) => REMOTE_WORKER_DISPATCH_NODE_TYPES.has(node.type));
