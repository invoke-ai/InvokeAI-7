import { ReactFlowProvider, type Node } from '@xyflow/react';
/* eslint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- test injects stable fakes into the runtime */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestWorkflowFitView, workflowFitViewRequestStore, type WorkflowFlowInstance } from './flowInstanceStore';
import { requestNodeSelection, workflowSelectionStore } from './selectionStore';
import { WorkflowSelectionRequestRuntime } from './WorkflowSelectionRequestRuntime';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waitForPendingSelection = () =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });

describe('WorkflowSelectionRequestRuntime', () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    workflowSelectionStore.patchSnapshot({ hoveredNodeId: null, selectedNodeIds: [], selectionRequest: null });
    workflowFitViewRequestStore.setSnapshot({ request: null });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) {
      await act(() => root?.unmount());
    }
    host.remove();
  });

  it('applies pending and later requests with current motion preferences, then unsubscribes', async () => {
    const fitView = vi.fn(() => Promise.resolve(true));
    const flowInstance = { fitView } as unknown as WorkflowFlowInstance;
    const selectNodes = vi.fn();
    requestNodeSelection(['pending-node']);

    await act(() => {
      root?.render(
        <ReactFlowProvider>
          <WorkflowSelectionRequestRuntime flowInstance={flowInstance} reduceMotion={false} selectNodes={selectNodes} />
        </ReactFlowProvider>
      );
    });
    await act(waitForPendingSelection);

    expect(selectNodes).toHaveBeenLastCalledWith(['pending-node']);
    expect(fitView).toHaveBeenLastCalledWith({
      duration: 300,
      maxZoom: 1.25,
      nodes: [{ id: 'pending-node' }],
    });

    await act(() => {
      root?.render(
        <ReactFlowProvider>
          <WorkflowSelectionRequestRuntime flowInstance={flowInstance} reduceMotion selectNodes={selectNodes} />
        </ReactFlowProvider>
      );
    });
    act(() => requestNodeSelection(['later-node']));

    expect(selectNodes).toHaveBeenLastCalledWith(['later-node']);
    expect(fitView).toHaveBeenLastCalledWith({ duration: 0, maxZoom: 1.25, nodes: [{ id: 'later-node' }] });

    await act(() => root?.unmount());
    root = null;
    act(() => requestNodeSelection(['after-unmount']));

    expect(selectNodes).toHaveBeenCalledTimes(2);
    expect(fitView).toHaveBeenCalledTimes(2);
  });

  const target = (id: string, x: number, y: number) => ({ id, position: { x, y } });
  const flowNode = (id: string, x: number, y: number, measured = true): Node => ({
    data: {},
    id,
    measured: measured ? { height: 40, width: 80 } : undefined,
    position: { x, y },
  });

  let providerKey = 0;

  // `initialNodes` only seed a provider on mount, so each step renders a fresh provider.
  const renderFit = async (flowInstance: WorkflowFlowInstance, initialNodes: Node[]) => {
    providerKey += 1;
    await act(() => {
      root?.render(
        <ReactFlowProvider key={providerKey} initialNodes={initialNodes}>
          <WorkflowSelectionRequestRuntime flowInstance={flowInstance} reduceMotion selectNodes={vi.fn()} />
        </ReactFlowProvider>
      );
    });
    await act(waitForPendingSelection);
  };

  it('fits once the flow shows the requested nodes measured at their positions, then clears the request', async () => {
    const fitView = vi.fn(() => Promise.resolve(true));
    const flowInstance = { fitView } as unknown as WorkflowFlowInstance;
    requestWorkflowFitView([target('a', 0, 0)]);

    await renderFit(flowInstance, [flowNode('a', 0, 0)]);

    expect(fitView).toHaveBeenCalledWith({ duration: 0 });
    expect(workflowFitViewRequestStore.getSnapshot().request).toBeNull();
  });

  it('waits while the flow still shows other nodes, stale positions, or unmeasured nodes', async () => {
    const fitView = vi.fn(() => Promise.resolve(true));
    const flowInstance = { fitView } as unknown as WorkflowFlowInstance;
    requestWorkflowFitView([target('a', 10, 10)]);

    await renderFit(flowInstance, [flowNode('a', 0, 0)]);
    expect(fitView).not.toHaveBeenCalled();

    await renderFit(flowInstance, [flowNode('a', 10, 10, false)]);
    expect(fitView).not.toHaveBeenCalled();

    await renderFit(flowInstance, [flowNode('a', 10, 10), flowNode('b', 0, 0)]);
    expect(fitView).not.toHaveBeenCalled();
    expect(workflowFitViewRequestStore.getSnapshot().request).not.toBeNull();

    await renderFit(flowInstance, [flowNode('a', 10, 10)]);
    expect(fitView).toHaveBeenCalledTimes(1);
  });

  it('drops a fit request for an empty document instead of leaving it armed', async () => {
    const fitView = vi.fn(() => Promise.resolve(true));
    requestWorkflowFitView([]);

    await renderFit({ fitView } as unknown as WorkflowFlowInstance, []);

    expect(fitView).not.toHaveBeenCalled();
    expect(workflowFitViewRequestStore.getSnapshot().request).toBeNull();
  });
});
