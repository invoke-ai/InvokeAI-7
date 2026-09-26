import type { QueueBackendGraph, QueueResultDestination } from '@features/queue/core/types';

import { selectRemoteDispatch } from './remoteWorkersDispatch';
import {
  AUTOMATIC_REMOTE_WORKER_NODE_ID,
  AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
  hasRemoteWorkerDispatchNode,
} from './remoteWorkersGraphContract';
import { getOnlineRemoteWorkerUrls } from './remoteWorkersHealth';
import { getRemoteWorkerUrls, getRemoteWorkersSettings } from './remoteWorkersStore';

/** Only the submitted graph is modified. The saved Canvas/workflow stays untouched. */
export const applyRemoteWorkersToGraph = (
  graph: QueueBackendGraph,
  galleryBoardId: string | null,
  destination: QueueResultDestination,
  queueItemId = graph.id
): QueueBackendGraph => {
  const settings = getRemoteWorkersSettings();
  if (!settings.enabled || (destination !== 'gallery' && destination !== 'canvas')) {
    return graph;
  }
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  if (urls.length === 0 || hasRemoteWorkerDispatchNode(graph)) {
    return graph;
  }
  if (Object.hasOwn(graph.nodes, AUTOMATIC_REMOTE_WORKER_NODE_ID)) {
    return graph;
  }

  const plan = selectRemoteDispatch(settings.dispatchMode, urls, queueItemId, getOnlineRemoteWorkerUrls(urls));
  const [remoteUrl, ...additionalUrls] = plan.remoteUrls;
  if (!remoteUrl) {
    return graph;
  }
  const kickoff = {
    id: AUTOMATIC_REMOTE_WORKER_NODE_ID,
    type: AUTOMATIC_REMOTE_WORKER_NODE_TYPE,
    use_cache: false,
    is_intermediate: true,
    remote_url: remoteUrl,
    additional_remote_urls: additionalUrls.join('\n'),
    remote_slot_indices: plan.remoteSlots.join(','),
    remote_seed_mode:
      settings.dispatchMode === 'mirror_all' || settings.dispatchMode === 'remotes_only'
        ? 'Randomize remote seed inputs'
        : 'Keep current workflow seeds',
    remote_seed: -1,
    auto_transfer_missing_models: settings.autoTransferMissingModels,
    model_transfer_host: settings.modelTransferHost.trim(),
    keep_remote_copies: settings.keepRemoteCopies,
    result_destination: destination,
    local_gallery_board_id:
      destination === 'gallery' && galleryBoardId && galleryBoardId !== 'none' ? galleryBoardId : '',
    // A remote-only kickoff must retain the complete ORIGINAL graph. The local
    // queue runs just this helper, while Python dispatches the serialized graph.
    ...(plan.local ? {} : { source_graph_json: JSON.stringify(graph) }),
  };
  return plan.local
    ? {
        ...graph,
        nodes: { ...graph.nodes, [AUTOMATIC_REMOTE_WORKER_NODE_ID]: kickoff },
      }
    : {
        ...graph,
        edges: [],
        nodes: { [AUTOMATIC_REMOTE_WORKER_NODE_ID]: kickoff },
      };
};
