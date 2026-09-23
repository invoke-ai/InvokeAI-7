import type {
  NodeInvocationCompleteEvent,
  NodeInvocationErrorEvent,
  NodeInvocationStartedEvent,
} from '@features/nodes/core/executionContracts';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createKeyedTransientStore } from '@platform/state/externalStore';

import { browserNodesDataPort } from './transport';

/**
 * Keep transient execution state outside the workbench reducer; subscribe per source node ID to isolate frequent
 * renders.
 */

export type NodeExecutionStatus = 'running' | 'completed' | 'failed';

/** How the queue item that was running these nodes ended. */
export type NodeExecutionOutcome = 'completed' | 'failed' | 'canceled';

export interface NodeExecutionState {
  status: NodeExecutionStatus;
  /** 0..1, or null while indeterminate. Only meaningful while running. */
  progress: number | null;
  progressMessage: string | null;
  /** Thumbnail of the node's most recent image output, when it produced one. */
  outputImageUrl: string | null;
  /** The node's most recent invocation result in the current run (a loop body runs many times). */
  latestOutput: unknown;
  error: string | null;
}

const stateByNodeId = createKeyedTransientStore<string, NodeExecutionState>();

/** Pull the produced image out of an invocation output, whatever the node type. */
const getResultImageName = (result: unknown): string | null => {
  const image = (result as { image?: { image_name?: unknown } }).image;

  return typeof image?.image_name === 'string' ? image.image_name : null;
};

export const nodeExecutionStore = {
  clearAll(): void {
    stateByNodeId.clear();
  },
  get(nodeId: string): NodeExecutionState | null {
    return stateByNodeId.get(nodeId) ?? null;
  },
  subscribe(nodeId: string, listener: () => void): () => void {
    return stateByNodeId.subscribeKey(nodeId, listener);
  },
  completed(event: NodeInvocationCompleteEvent): void {
    const imageName = getResultImageName(event.result);
    const previous = stateByNodeId.get(event.invocation_source_id);

    stateByNodeId.set(event.invocation_source_id, {
      error: null,
      outputImageUrl: imageName
        ? browserNodesDataPort.buildUrl(`/api/v1/images/i/${encodeURIComponent(imageName)}/thumbnail`)
        : (previous?.outputImageUrl ?? null),
      latestOutput: event.result,
      progress: null,
      progressMessage: null,
      status: 'completed',
    });
  },
  failed(event: NodeInvocationErrorEvent): void {
    const previous = stateByNodeId.get(event.invocation_source_id);

    stateByNodeId.set(event.invocation_source_id, {
      error: event.error_message,
      outputImageUrl: previous?.outputImageUrl ?? null,
      latestOutput: previous?.latestOutput ?? null,
      progress: null,
      progressMessage: null,
      status: 'failed',
    });
  },
  progress(nodeId: string, percentage: number | null, message: string): void {
    const previous = stateByNodeId.get(nodeId);

    stateByNodeId.set(nodeId, {
      error: null,
      outputImageUrl: previous?.outputImageUrl ?? null,
      latestOutput: previous?.latestOutput ?? null,
      progress: percentage,
      progressMessage: message,
      status: 'running',
    });
  },
  /** Terminal queue items end any remaining running node state, including missed failure/cancel events. */
  settleRunning(nodeIds: Iterable<string>, outcome: NodeExecutionOutcome): void {
    for (const nodeId of nodeIds) {
      const state = stateByNodeId.get(nodeId);

      if (state?.status !== 'running') {
        continue;
      }

      if (outcome === 'completed') {
        stateByNodeId.set(nodeId, { ...state, progress: null, progressMessage: null, status: 'completed' });
      } else {
        stateByNodeId.delete(nodeId);
      }
    }
  },
  started(event: NodeInvocationStartedEvent): void {
    const previous = stateByNodeId.get(event.invocation_source_id);

    stateByNodeId.set(event.invocation_source_id, {
      error: null,
      outputImageUrl: previous?.outputImageUrl ?? null,
      latestOutput: previous?.latestOutput ?? null,
      progress: null,
      progressMessage: null,
      status: 'running',
    });
  },
};

export interface NodeExecutionSink {
  clearAll(): void;
  completed(event: NodeInvocationCompleteEvent): void;
  failed(event: NodeInvocationErrorEvent): void;
  get(nodeId: string): NodeExecutionState | null;
  progress(nodeId: string, percentage: number | null, message: string): void;
  settleRunning(nodeIds: Iterable<string>, outcome: NodeExecutionOutcome): void;
  started(event: NodeInvocationStartedEvent): void;
  subscribe(nodeId: string, listener: () => void): () => void;
}

registerAccountOwnedResource({
  clear: nodeExecutionStore.clearAll,
  name: 'node-execution',
});

export const useNodeExecutionState = (nodeId: string): NodeExecutionState | null =>
  stateByNodeId.useValue(nodeId) ?? null;
