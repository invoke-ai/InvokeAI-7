import { useMountEffect } from '@platform/react/useMountEffect';
import { useStoreApi } from '@xyflow/react';
import { useEffectEvent } from 'react';

import type { WorkflowFlowEdge, WorkflowFlowNode } from './flowAdapters';

import {
  clearWorkflowFitViewRequest,
  workflowFitViewRequestStore,
  type WorkflowFlowInstance,
} from './flowInstanceStore';
import { clearNodeSelectionRequest, workflowSelectionStore } from './selectionStore';

interface WorkflowSelectionRequestRuntimeProps {
  flowInstance: WorkflowFlowInstance;
  reduceMotion: boolean;
  selectNodes: (nodeIds: string[]) => void;
}

/** Applies outside selection and fit-view requests while a workflow flow instance is mounted. */
export const WorkflowSelectionRequestRuntime = ({
  flowInstance,
  reduceMotion,
  selectNodes,
}: WorkflowSelectionRequestRuntimeProps) => {
  const store = useStoreApi<WorkflowFlowNode, WorkflowFlowEdge>();
  const applyRequestedSelection = useEffectEvent(() => {
    const selectionRequest = workflowSelectionStore.getSnapshot().selectionRequest;

    if (!selectionRequest) {
      return;
    }

    selectNodes(selectionRequest.nodeIds);
    void flowInstance.fitView({
      duration: reduceMotion ? 0 : 300,
      maxZoom: 1.25,
      nodes: selectionRequest.nodeIds.map((id) => ({ id })),
    });
    clearNodeSelectionRequest();
  });
  // The requested nodes are the loaded document's; the flow shows them only after React commits the
  // rebuilt model (and, for a large graph, its full mount), so the fit waits for that exact set.
  const applyRequestedFit = useEffectEvent(() => {
    const fitViewRequest = workflowFitViewRequestStore.getSnapshot().request;

    if (!fitViewRequest) {
      return;
    }

    if (fitViewRequest.nodes.length === 0) {
      clearWorkflowFitViewRequest();
      return;
    }

    const { nodeLookup } = store.getState();

    if (nodeLookup.size !== fitViewRequest.nodes.length) {
      return;
    }

    for (const node of fitViewRequest.nodes) {
      const internal = nodeLookup.get(node.id);

      if (
        !internal?.measured.width ||
        !internal.measured.height ||
        internal.internals.positionAbsolute.x !== node.position.x ||
        internal.internals.positionAbsolute.y !== node.position.y
      ) {
        return;
      }
    }

    clearWorkflowFitViewRequest();
    void flowInstance.fitView({ duration: reduceMotion ? 0 : 300 });
  });

  /* eslint-disable react-hooks/rules-of-hooks -- useMountEffect is the repository's explicit useEffect wrapper */
  useMountEffect(() => {
    const pendingRequestTimer = window.setTimeout(() => {
      applyRequestedSelection();
      applyRequestedFit();
    }, 0);
    const unsubscribeSelection = workflowSelectionStore.subscribe(applyRequestedSelection);
    const unsubscribeFitRequests = workflowFitViewRequestStore.subscribe(applyRequestedFit);
    // The flow store ticks when nodes mount, measure, or move, which is when a pending fit becomes applicable.
    const unsubscribeFlow = store.subscribe(applyRequestedFit);

    return () => {
      window.clearTimeout(pendingRequestTimer);
      unsubscribeSelection();
      unsubscribeFitRequests();
      unsubscribeFlow();
    };
  });
  /* eslint-enable react-hooks/rules-of-hooks */

  return null;
};
