import type { InvocationTemplate, ProjectGraphState, WorkflowInvocationNode } from '@features/workflow/contracts';
import type { WorkflowNodeExecutionState } from '@features/workflow/ui/contracts';
import type { WorkflowUiAdapter } from '@features/workflow/ui/WorkflowUiContext';

/* eslint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- each render mounts a fresh flow on purpose */
import { ChakraProvider } from '@chakra-ui/react';
import { WorkflowUiProvider } from '@features/workflow/ui/WorkflowUiContext';
import { setNodePreviewCollapsed } from '@features/workflow/ui/workflowUiStore';
import { createProjectGraph } from '@features/workflow/utility';
import { system } from '@theme/system';
import { ReactFlow } from '@xyflow/react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';

import { toFlowEdges, toFlowNodes } from './flowAdapters';
import { InvocationFlowNode } from './InvocationFlowNode';

import '@xyflow/react/dist/style.css';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({ 'nodes.latestOutput': 'Latest output', 'nodes.latestOutputImage': 'Latest output of this node' })[key] ?? key,
  }),
}));

const NODE_ID = 'preview-node';
/** The preview's fixed height (10rem) in CSS pixels, however the root font is sized. */
const previewHeightPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) * 10;

const template: InvocationTemplate = {
  category: 'test',
  classification: 'stable',
  description: '',
  inputs: {
    a: {
      default: undefined,
      description: '',
      exclusiveMaximum: null,
      exclusiveMinimum: null,
      fieldKind: 'input',
      input: 'connection',
      maximum: null,
      minimum: null,
      multipleOf: null,
      name: 'a',
      options: null,
      required: false,
      title: 'A',
      type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
      uiChoiceLabels: null,
      uiComponent: null,
      uiHidden: false,
      uiModelBase: null,
      uiModelFormat: null,
      uiModelType: null,
      uiOrder: null,
    },
  },
  nodePack: 'invokeai',
  outputType: 'test',
  outputs: {
    value: {
      description: '',
      name: 'value',
      title: 'Value',
      type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
    },
  },
  tags: [],
  title: 'Preview',
  type: 'preview',
  useCache: true,
  version: '1.0.0',
};

const documentNode: WorkflowInvocationNode = {
  data: {
    inputs: {},
    isIntermediate: true,
    isOpen: true,
    label: '',
    nodePack: 'invokeai',
    notes: '',
    type: 'preview',
    useCache: true,
    version: '1.0.0',
  },
  id: NODE_ID,
  position: { x: 20, y: 20 },
  type: 'invocation',
};

const projectGraph: ProjectGraphState = { ...createProjectGraph('preview-test'), nodes: [documentNode] };
const templates = { preview: template };
const flowNodes = toFlowNodes(projectGraph, [], templates);
const nodeTypes = { invocation: InvocationFlowNode };

const outputImage = (width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#4c8bf5';
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL();
};

const completed = (outputImageUrl: string): WorkflowNodeExecutionState => ({
  error: null,
  latestOutput: null,
  outputImageUrl,
  progress: null,
  progressMessage: null,
  status: 'completed',
});

/** A node-execution port the test can advance between renders. */
const createExecutionPort = () => {
  const listeners = new Set<() => void>();
  let state: WorkflowNodeExecutionState | null = null;

  return {
    port: {
      get: (nodeId: string) => (nodeId === NODE_ID ? state : null),
      subscribe: (_nodeId: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    set(next: WorkflowNodeExecutionState) {
      state = next;
      listeners.forEach((listener) => listener());
    },
  };
};

const preferencesSnapshot = {
  reduceMotion: true,
  themeId: 'classic' as const,
  workflowEdgeStyle: 'curved' as const,
  workflowEdgesBehindNodes: false,
  workflowShowMinimap: false,
  workflowSnapToGrid: false,
  workflowValidateConnections: true,
};
const projectSnapshot = {
  galleryValues: {},
  id: 'project-1',
  isWorkflowRunning: false,
  projectGraph,
  workflowValues: {},
};

const createAdapter = (nodeExecution: WorkflowUiAdapter['nodeExecution']): WorkflowUiAdapter =>
  ({
    capabilities: { getSnapshot: () => ({ canUseCache: true }), subscribe: () => () => {} },
    commands: { bindLibraryWorkflow: vi.fn(), editGraph: vi.fn(), redo: vi.fn(), replace: vi.fn(), undo: vi.fn() },
    getProjectGraph: () => projectGraph,
    nodeExecution,
    notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
    openAddModels: vi.fn(),
    performance: {
      mark: vi.fn(),
      measure: vi.fn(),
      time: <T,>(_name: string, _source: unknown, callback: () => T) => callback(),
    },
    preferences: { getSnapshot: () => preferencesSnapshot, subscribe: () => () => {} },
    project: { getSnapshot: () => projectSnapshot, subscribe: () => () => {} },
    registerModalHotkeyLayer: vi.fn(() => vi.fn()),
    widgets: { open: vi.fn(), patchValues: vi.fn() },
  }) as unknown as WorkflowUiAdapter;

describe('InvocationFlowNode output preview', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setNodePreviewCollapsed(NODE_ID, false);
    host = document.createElement('div');
    host.style.cssText = 'width: 480px; height: 520px;';
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  const render = (adapter: WorkflowUiAdapter, zoom = 1) =>
    act(() =>
      root.render(
        <ChakraProvider value={system}>
          <WorkflowUiProvider adapter={adapter}>
            <ReactFlow
              defaultViewport={{ x: 0, y: 0, zoom }}
              edges={[]}
              minZoom={0.1}
              nodes={flowNodes}
              nodeTypes={nodeTypes}
            />
          </WorkflowUiProvider>
        </ChakraProvider>
      )
    );
  const image = () => host.querySelector<HTMLImageElement>('.react-flow__node img');
  const disclosure = () =>
    [...host.querySelectorAll<HTMLButtonElement>('.react-flow__node button[aria-expanded]')].find(
      (button) => button.textContent === 'Latest output'
    )!;
  const nodeHeight = () => host.querySelector<HTMLElement>('.react-flow__node')!.getBoundingClientRect().height;

  it('keeps one preview height across differently shaped outputs and folds it away per node', async () => {
    const execution = createExecutionPort();
    const adapter = createAdapter(execution.port);

    await render(adapter);
    expect(image()).toBeNull();
    expect(disclosure()).toBeUndefined();

    await act(() => execution.set(completed(outputImage(400, 100))));
    await vi.waitFor(() => expect(image()!.getBoundingClientRect().height).toBeCloseTo(previewHeightPx(), 0));
    const heightWithWideOutput = nodeHeight();
    await page.screenshot({ path: '../../../../../artifacts/workflow-node-preview/expanded.png' });

    await act(() => execution.set(completed(outputImage(100, 400))));
    await vi.waitFor(() => expect(image()!.src).toBe(outputImage(100, 400)));
    expect(image()!.getBoundingClientRect().height).toBeCloseTo(previewHeightPx(), 0);
    expect(nodeHeight()).toBe(heightWithWideOutput);

    await act(() => disclosure().click());
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(image()).toBeNull();
    expect(nodeHeight()).toBeLessThan(heightWithWideOutput - 100);
    await page.screenshot({ path: '../../../../../artifacts/workflow-node-preview/collapsed.png' });

    // The fold outlives the node's mount: a remount (offscreen virtualization, a project switch back) keeps it.
    await act(() => root.unmount());
    root = createRoot(host);
    await render(adapter);
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(image()).toBeNull();

    await act(() => disclosure().click());
    expect(disclosure().getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => expect(image()!.getBoundingClientRect().height).toBeCloseTo(previewHeightPx(), 0));
  });

  it('stands in a same-height skeleton for the image when the viewport is zoomed out', async () => {
    const execution = createExecutionPort();
    const adapter = createAdapter(execution.port);
    execution.set(completed(outputImage(400, 100)));

    await render(adapter);
    await vi.waitFor(() => expect(image()).not.toBeNull());
    const node = () => host.querySelector<HTMLElement>('.react-flow__node')!;
    const layoutHeight = node().offsetHeight;

    await act(() => root.unmount());
    root = createRoot(host);
    await render(adapter, 0.3);

    await vi.waitFor(() => expect(image()).toBeNull());
    expect(node().offsetHeight).toBe(layoutHeight);
  });
});

describe('InvocationFlowNode edge stacking', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.cssText = 'width: 400px; height: 500px;';
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  /** Screen-space samples along an edge's hit path that fall inside `rect`, with what the pointer would hit there. */
  const hitsInside = (path: SVGGeometryElement, rect: DOMRect) => {
    const svg = path.ownerSVGElement!;
    const matrix = svg.getScreenCTM()!;
    const length = path.getTotalLength();
    const hits: Element[] = [];

    for (let step = 0; step <= 80; step += 1) {
      const point = path.getPointAtLength((length * step) / 80).matrixTransform(matrix);

      if (point.x > rect.left + 2 && point.x < rect.right - 2 && point.y > rect.top + 2 && point.y < rect.bottom - 2) {
        hits.push(document.elementFromPoint(point.x, point.y)!);
      }
    }

    return hits;
  };

  it('keeps a selected node clickable where its own edge crosses it, while the edge stays above other nodes', async () => {
    // The target sits behind and above the source, so the edge leaves the source's right handle and
    // sweeps back across the source's own body and over an unrelated node on the way. Everything stays
    // inside the test viewport.
    const target: WorkflowInvocationNode = { ...documentNode, id: 'target-node', position: { x: 0, y: 0 } };
    const bystander: WorkflowInvocationNode = { ...documentNode, id: 'bystander-node', position: { x: 20, y: 120 } };
    const graph: ProjectGraphState = {
      ...projectGraph,
      edges: [
        { id: 'e', source: NODE_ID, sourceHandle: 'value', target: target.id, targetHandle: 'a', type: 'default' },
      ],
      nodes: [{ ...documentNode, position: { x: 100, y: 220 } }, target, bystander],
    };
    const nodes = toFlowNodes(graph, [], templates).map((node) => ({ ...node, selected: node.id === NODE_ID }));
    const edges = toFlowEdges(graph, [], 'default', new Set([NODE_ID]), templates);

    await act(() =>
      root.render(
        <ChakraProvider value={system}>
          <WorkflowUiProvider adapter={createAdapter({ get: () => null, subscribe: () => () => {} })}>
            {/* The editor passes `elevateEdgesOnSelect` unless edges are kept behind nodes; xyflow defaults it off. */}
            <ReactFlow edges={edges} elevateEdgesOnSelect nodes={nodes} nodeTypes={nodeTypes} />
          </WorkflowUiProvider>
        </ChakraProvider>
      )
    );

    const path = await vi.waitFor(() => {
      const element = host.querySelector<SVGGeometryElement>('.react-flow__edge-interaction');
      expect(element?.getTotalLength()).toBeGreaterThan(0);
      return element!;
    });
    const selectedNode = host.querySelector<HTMLElement>(`.react-flow__node[data-id="${NODE_ID}"]`)!;
    const otherNode = host.querySelector<HTMLElement>(`.react-flow__node[data-id="${bystander.id}"]`)!;
    const overSelected = hitsInside(path, selectedNode.getBoundingClientRect());
    const overOther = hitsInside(path, otherNode.getBoundingClientRect());

    expect(overSelected.length).toBeGreaterThan(0);
    expect(overSelected.every((hit) => selectedNode.contains(hit))).toBe(true);
    expect(overOther.length).toBeGreaterThan(0);
    expect(overOther.some((hit) => hit.closest('.react-flow__edge') !== null)).toBe(true);
  });
});
