import type { QueueBackendGraph, QueueResultDestination } from '@features/queue/core/types';

import { getRemoteWorkerUrls, getRemoteWorkersSettings } from './remoteWorkersStore';

const AUTOMATIC_MIRROR_NODE_ID = '__irw_automatic_mirror__';

/**
 * Add one kickoff invocation to an immutable *submission* graph. The saved
 * workflow document is never modified. Existing manual Mirror nodes win.
 * Use InvokeAI's captured result destination. Canvas candidates are delivered
 * by the app-owned remote-result adapter, not through Gallery board routing.
 */
export const applyRemoteWorkersToGraph = (
  graph: QueueBackendGraph,
  galleryBoardId: string | null,
  destination: QueueResultDestination
): QueueBackendGraph => {
  const settings = getRemoteWorkersSettings();
  if (!settings.enabled || (destination !== 'gallery' && destination !== 'canvas')) {
    return graph;
  }
  const urls = getRemoteWorkerUrls(settings.workerUrls);
  if (
    urls.length === 0 ||
    Object.values(graph.nodes).some(
      (node) => node.type === 'remote_mirror_current_workflow' || node.type === 'irw_builtin_mirror_current_workflow'
    )
  ) {
    return graph;
  }
  if (Object.hasOwn(graph.nodes, AUTOMATIC_MIRROR_NODE_ID)) {
    // Do not overwrite a workflow's existing node on the very unlikely ID collision.
    return graph;
  }

  const [remoteUrl, ...additionalUrls] = urls;
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      [AUTOMATIC_MIRROR_NODE_ID]: {
        id: AUTOMATIC_MIRROR_NODE_ID,
        type: 'irw_builtin_mirror_current_workflow',
        use_cache: false,
        is_intermediate: true,
        remote_url: remoteUrl,
        additional_remote_urls: additionalUrls.join('\n'),
        remote_seed_mode: 'Randomize remote seed inputs',
        remote_seed: -1,
        auto_transfer_missing_models: settings.autoTransferMissingModels,
        model_transfer_host: settings.modelTransferHost.trim(),
        keep_remote_copies: settings.keepRemoteCopies,
        result_destination: destination,
        // Board=Auto is not in the executable image-node graph. The local queue
        // already captured its destination board at Invoke time; pass that exact
        // immutable snapshot into the background bridge, not the live selection.
        local_gallery_board_id:
          destination === 'gallery' && galleryBoardId && galleryBoardId !== 'none' ? galleryBoardId : '',
      },
    },
  };
};
