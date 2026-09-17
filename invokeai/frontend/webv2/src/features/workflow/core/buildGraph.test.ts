import { describe, expect, it, vi } from 'vitest';

import type { FieldInputTemplate, InvocationTemplate, InvocationTemplatesSnapshot, ProjectGraphState } from './types';

import {
  compileProjectGraph,
  getProjectGraphReadiness,
  getWorkflowFieldSeedMode,
  isSeedInputField,
  planWorkflowSubmission,
} from './buildGraph';
import {
  buildConnectorNode,
  buildInvocationNode,
  buildNotesNode,
  createProjectGraph,
  projectGraphReducer,
} from './document';

const input = (name: string, overrides: Partial<FieldInputTemplate> = {}): FieldInputTemplate => ({
  default: undefined,
  description: '',
  exclusiveMaximum: null,
  exclusiveMinimum: null,
  fieldKind: 'input',
  input: 'any',
  maximum: null,
  minimum: null,
  multipleOf: null,
  name,
  options: null,
  required: false,
  title: name,
  type: { batch: false, cardinality: 'SINGLE', name: 'StringField' },
  uiChoiceLabels: null,
  uiComponent: null,
  uiHidden: false,
  uiModelBase: null,
  uiModelFormat: null,
  uiModelType: null,
  uiOrder: null,
  ...overrides,
});

const template = (type: string, inputs: Record<string, FieldInputTemplate>): InvocationTemplate => ({
  category: 'test',
  classification: 'stable',
  description: '',
  inputs,
  nodePack: 'invokeai',
  outputs: {
    out: {
      description: '',
      name: 'out',
      title: 'Out',
      type: { batch: false, cardinality: 'SINGLE', name: 'StringField' },
    },
  },
  outputType: `${type}_output`,
  tags: [],
  title: type,
  type,
  useCache: true,
  version: '1.0.0',
});

const templates = {
  sink: template('sink', {
    board: input('board', { type: { batch: false, cardinality: 'SINGLE', name: 'BoardField' } }),
    text: input('text', { required: true }),
  }),
  source: template('source', { value: input('value', { default: 'hello', required: true }) }),
};

const loadedSnapshot: InvocationTemplatesSnapshot = { error: null, status: 'loaded', templates };

const buildDocument = (): { doc: ProjectGraphState; sinkId: string; sourceId: string } => {
  const sourceNode = buildInvocationNode(templates.source, { x: 0, y: 0 });
  const sinkNode = buildInvocationNode(templates.sink, { x: 10, y: 0 });
  let doc = createProjectGraph('compile-test');

  doc = projectGraphReducer(doc, { node: sourceNode, type: 'addNode' });
  doc = projectGraphReducer(doc, { node: sinkNode, type: 'addNode' });
  doc = projectGraphReducer(doc, { node: buildNotesNode({ x: 0, y: 100 }), type: 'addNode' });
  doc = projectGraphReducer(doc, {
    edge: {
      id: 'e1',
      source: sourceNode.id,
      sourceHandle: 'out',
      target: sinkNode.id,
      targetHandle: 'text',
      type: 'default',
    },
    type: 'addEdge',
  });

  return { doc, sinkId: sinkNode.id, sourceId: sourceNode.id };
};

describe('getProjectGraphReadiness', () => {
  it('requires loaded templates and at least one node', () => {
    const empty = createProjectGraph('empty');

    expect(getProjectGraphReadiness(empty, { error: null, status: 'loading', templates: {} }).reasons[0]).toMatch(
      /still loading/
    );
    expect(getProjectGraphReadiness(empty, loadedSnapshot).reasons[0]).toMatch(/no nodes/);
  });

  it('is ready when required inputs are connected or filled', () => {
    const { doc } = buildDocument();

    expect(getProjectGraphReadiness(doc, loadedSnapshot)).toEqual({ canInvoke: true, reasons: [] });
  });

  it('treats resolved connector output edges as connected required inputs', () => {
    const sourceNode = buildInvocationNode(templates.source, { x: 0, y: 0 });
    const sinkNode = buildInvocationNode(templates.sink, { x: 10, y: 0 });
    const connector = buildConnectorNode({ x: 5, y: 0 });
    let doc = createProjectGraph('connector-readiness');

    doc = projectGraphReducer(doc, { node: sourceNode, type: 'addNode' });
    doc = projectGraphReducer(doc, { node: sinkNode, type: 'addNode' });
    doc = projectGraphReducer(doc, { node: connector, type: 'addNode' });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'connector-in',
        source: sourceNode.id,
        sourceHandle: 'out',
        target: connector.id,
        targetHandle: 'in',
        type: 'default',
      },
      type: 'addEdge',
    });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'connector-out',
        source: connector.id,
        sourceHandle: 'out',
        target: sinkNode.id,
        targetHandle: 'text',
        type: 'default',
      },
      type: 'addEdge',
    });

    expect(getProjectGraphReadiness(doc, loadedSnapshot)).toEqual({ canInvoke: true, reasons: [] });
  });

  it('reports missing required inputs and unknown node types', () => {
    const { doc, sourceId } = buildDocument();
    const withEmptyString = projectGraphReducer(doc, {
      fieldName: 'value',
      nodeId: sourceId,
      type: 'setFieldValue',
      value: '',
    });

    expect(getProjectGraphReadiness(withEmptyString, loadedSnapshot)).toEqual({ canInvoke: true, reasons: [] });

    const withMissingValue = projectGraphReducer(doc, {
      fieldName: 'value',
      nodeId: sourceId,
      type: 'setFieldValue',
      value: undefined,
    });

    expect(getProjectGraphReadiness(withMissingValue, loadedSnapshot).reasons[0]).toMatch(/missing required input/);

    const unknownTemplates: InvocationTemplatesSnapshot = {
      error: null,
      status: 'loaded',
      templates: { source: templates.source },
    };

    expect(getProjectGraphReadiness(doc, unknownTemplates).reasons[0]).toMatch(/Unknown node type "sink"/);
  });

  it('reports invalid required direct values', () => {
    const constrainedTemplate = template('constrained', {
      choice: input('choice', {
        options: ['a', 'b'],
        required: true,
        type: { batch: false, cardinality: 'SINGLE', name: 'EnumField' },
      }),
      count: input('count', {
        maximum: 4,
        minimum: 1,
        required: true,
        type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
      }),
    });
    const node = buildInvocationNode(constrainedTemplate, { x: 0, y: 0 });
    let doc = createProjectGraph('invalid-values');

    doc = projectGraphReducer(doc, { node, type: 'addNode' });
    doc = projectGraphReducer(doc, { fieldName: 'choice', nodeId: node.id, type: 'setFieldValue', value: 'z' });
    doc = projectGraphReducer(doc, { fieldName: 'count', nodeId: node.id, type: 'setFieldValue', value: 10 });

    const readiness = getProjectGraphReadiness(doc, {
      error: null,
      status: 'loaded',
      templates: { constrained: constrainedTemplate },
    });

    expect(readiness.canInvoke).toBe(false);
    expect(readiness.reasons).toEqual([
      '"constrained" has invalid input "choice".',
      '"constrained" has invalid input "count".',
    ]);
  });

  it('reports invalid optional direct values when they are populated', () => {
    const constrainedTemplate = template('optional-constrained', {
      count: input('count', {
        maximum: 4,
        minimum: 1,
        required: false,
        type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
      }),
    });
    const node = buildInvocationNode(constrainedTemplate, { x: 0, y: 0 });
    let doc = createProjectGraph('invalid-optional-values');

    doc = projectGraphReducer(doc, { node, type: 'addNode' });

    expect(
      getProjectGraphReadiness(doc, {
        error: null,
        status: 'loaded',
        templates: { 'optional-constrained': constrainedTemplate },
      })
    ).toEqual({ canInvoke: true, reasons: [] });

    doc = projectGraphReducer(doc, { fieldName: 'count', nodeId: node.id, type: 'setFieldValue', value: 10 });

    expect(
      getProjectGraphReadiness(doc, {
        error: null,
        status: 'loaded',
        templates: { 'optional-constrained': constrainedTemplate },
      })
    ).toEqual({ canInvoke: false, reasons: ['"optional-constrained" has invalid input "count".'] });
  });

  it('treats only explicitly externally satisfied connection inputs as ready', () => {
    const connectionTemplate = template('connection-sink', {
      image: input('image', {
        input: 'connection',
        required: true,
        title: 'Layer image',
        type: { batch: false, cardinality: 'SINGLE', name: 'ImageField' },
      }),
      mask: input('mask', {
        input: 'connection',
        required: true,
        title: 'Mask image',
        type: { batch: false, cardinality: 'SINGLE', name: 'ImageField' },
      }),
    });
    const node = buildInvocationNode(connectionTemplate, { x: 0, y: 0 });
    const doc = { ...createProjectGraph('external-input'), nodes: [{ ...node, id: 'sink' }] };
    const snapshot: InvocationTemplatesSnapshot = {
      error: null,
      status: 'loaded',
      templates: { 'connection-sink': connectionTemplate },
    };

    expect(getProjectGraphReadiness(doc, snapshot, { externallySatisfiedInputs: new Set(['sink:image']) })).toEqual({
      canInvoke: false,
      reasons: ['"connection-sink" is missing a connection for "Mask image".'],
    });
    expect(
      getProjectGraphReadiness(doc, snapshot, {
        externallySatisfiedInputs: new Set(['sink:image', 'sink:mask']),
      })
    ).toEqual({ canInvoke: true, reasons: [] });
  });

  it('does not let external satisfaction bypass a required direct value', () => {
    const directTemplate = template('direct-sink', {
      image: input('image', {
        input: 'direct',
        required: true,
        title: 'Layer image',
        type: { batch: false, cardinality: 'SINGLE', name: 'ImageField' },
      }),
    });
    const node = buildInvocationNode(directTemplate, { x: 0, y: 0 });
    const doc = { ...createProjectGraph('external-direct'), nodes: [{ ...node, id: 'sink' }] };
    const snapshot: InvocationTemplatesSnapshot = {
      error: null,
      status: 'loaded',
      templates: { 'direct-sink': directTemplate },
    };

    expect(getProjectGraphReadiness(doc, snapshot, { externallySatisfiedInputs: new Set(['sink:image']) })).toEqual({
      canInvoke: false,
      reasons: ['"direct-sink" is missing required input "Layer image".'],
    });
  });
});

describe('compileProjectGraph', () => {
  it('compiles nodes and edges, omitting notes nodes and connected direct values', () => {
    const { doc, sinkId, sourceId } = buildDocument();
    const withStaleValue = projectGraphReducer(doc, {
      fieldName: 'text',
      nodeId: sinkId,
      type: 'setFieldValue',
      value: 'stale direct value',
    });
    const compiled = compileProjectGraph(withStaleValue, templates);
    const backendGraph = compiled.backendGraph;

    expect(backendGraph).toBeDefined();
    expect(Object.keys(backendGraph?.nodes ?? {}).sort()).toEqual([sinkId, sourceId].sort());
    expect(backendGraph?.nodes[sourceId]).toMatchObject({ type: 'source', use_cache: true, value: 'hello' });
    // The connected input's direct value must not be sent alongside the edge.
    expect(backendGraph?.nodes[sinkId]).not.toHaveProperty('text');
    expect(backendGraph?.edges).toEqual([
      { destination: { field: 'text', node_id: sinkId }, source: { field: 'out', node_id: sourceId }, type: 'default' },
    ]);
  });

  it('omits auto/none board sentinels and keeps explicit boards', () => {
    const { doc, sinkId } = buildDocument();
    const withAutoBoard = projectGraphReducer(doc, {
      fieldName: 'board',
      nodeId: sinkId,
      type: 'setFieldValue',
      value: 'auto',
    });

    expect(compileProjectGraph(withAutoBoard, templates).backendGraph?.nodes[sinkId]).not.toHaveProperty('board');

    const withExplicitBoard = projectGraphReducer(doc, {
      fieldName: 'board',
      nodeId: sinkId,
      type: 'setFieldValue',
      value: { board_id: 'board-1' },
    });

    expect(compileProjectGraph(withExplicitBoard, templates).backendGraph?.nodes[sinkId]).toMatchObject({
      board: { board_id: 'board-1' },
    });
  });

  it('resolves connector chains into executable backend edges', () => {
    const sourceNode = buildInvocationNode(templates.source, { x: 0, y: 0 });
    const sinkNode = buildInvocationNode(templates.sink, { x: 10, y: 0 });
    const connector = buildConnectorNode({ x: 5, y: 0 });
    let doc = createProjectGraph('connector-compile');

    doc = projectGraphReducer(doc, { node: sourceNode, type: 'addNode' });
    doc = projectGraphReducer(doc, { node: sinkNode, type: 'addNode' });
    doc = projectGraphReducer(doc, { node: connector, type: 'addNode' });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'connector-in',
        source: sourceNode.id,
        sourceHandle: 'out',
        target: connector.id,
        targetHandle: 'in',
        type: 'default',
      },
      type: 'addEdge',
    });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'connector-out',
        source: connector.id,
        sourceHandle: 'out',
        target: sinkNode.id,
        targetHandle: 'text',
        type: 'default',
      },
      type: 'addEdge',
    });

    expect(compileProjectGraph(doc, templates).backendGraph?.edges).toEqual([
      {
        destination: { field: 'text', node_id: sinkNode.id },
        source: { field: 'out', node_id: sourceNode.id },
        type: 'default',
      },
    ]);
  });

  it('preserves the direct loop_linkage edge type in the queue graph', () => {
    const forTemplate: InvocationTemplate = {
      ...template('for', {
        collection: input('collection', {
          default: [],
          type: { batch: false, cardinality: 'COLLECTION', name: 'CollectionField' },
        }),
      }),
      outputs: {
        item: {
          description: '',
          name: 'item',
          outputScope: 'iteration',
          title: 'Item',
          type: { batch: false, cardinality: 'SINGLE', name: 'CollectionItemField' },
        },
        loop_linkage: {
          description: '',
          name: 'loop_linkage',
          title: 'Loop linkage',
          type: { batch: false, cardinality: 'SINGLE', name: 'AnyField' },
        },
        output_collection: {
          description: '',
          name: 'output_collection',
          outputScope: 'final',
          title: 'Output collection',
          type: { batch: false, cardinality: 'COLLECTION', name: 'CollectionField' },
        },
      },
    };
    const returnTemplate: InvocationTemplate = {
      ...template('for_return', {
        loop_linkage: input('loop_linkage', {
          input: 'connection',
          type: { batch: false, cardinality: 'SINGLE', name: 'AnyField' },
        }),
        output: input('output', {
          input: 'any',
          type: { batch: false, cardinality: 'SINGLE', name: 'CollectionItemField' },
        }),
      }),
      outputs: {},
    };
    const forNode = buildInvocationNode(forTemplate, { x: 0, y: 0 });
    const returnNode = buildInvocationNode(returnTemplate, { x: 100, y: 0 });
    let doc = createProjectGraph('loop-compile');

    doc = projectGraphReducer(doc, { node: forNode, type: 'addNode' });
    doc = projectGraphReducer(doc, { node: returnNode, type: 'addNode' });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'item',
        source: forNode.id,
        sourceHandle: 'item',
        target: returnNode.id,
        targetHandle: 'output',
        type: 'default',
      },
      type: 'addEdge',
    });
    doc = projectGraphReducer(doc, {
      edge: {
        id: 'linkage',
        source: forNode.id,
        sourceHandle: 'loop_linkage',
        target: returnNode.id,
        targetHandle: 'loop_linkage',
        type: 'loop_linkage',
      },
      type: 'addEdge',
    });

    const graph = compileProjectGraph(doc, { for: forTemplate, for_return: returnTemplate }).backendGraph;

    expect(graph.edges).toEqual([
      {
        destination: { field: 'output', node_id: returnNode.id },
        source: { field: 'item', node_id: forNode.id },
        type: 'default',
      },
      {
        destination: { field: 'loop_linkage', node_id: returnNode.id },
        source: { field: 'loop_linkage', node_id: forNode.id },
        type: 'loop_linkage',
      },
    ]);
  });

  it('rejects a loop-linkage source reused as ordinary connector data', () => {
    const forTemplate: InvocationTemplate = {
      ...template('for', {
        collection: input('collection', {
          default: [],
          type: { batch: false, cardinality: 'COLLECTION', name: 'CollectionField' },
        }),
      }),
      outputs: {
        item: {
          description: '',
          name: 'item',
          outputScope: 'iteration',
          title: 'Item',
          type: { batch: false, cardinality: 'SINGLE', name: 'CollectionItemField' },
        },
        loop_linkage: {
          description: '',
          name: 'loop_linkage',
          title: 'Loop linkage',
          type: { batch: false, cardinality: 'SINGLE', name: 'AnyField' },
        },
        output_collection: {
          description: '',
          name: 'output_collection',
          outputScope: 'final',
          title: 'Output collection',
          type: { batch: false, cardinality: 'COLLECTION', name: 'CollectionField' },
        },
      },
    };
    const returnTemplate: InvocationTemplate = {
      ...template('for_return', {
        loop_linkage: input('loop_linkage', {
          input: 'connection',
          type: { batch: false, cardinality: 'SINGLE', name: 'AnyField' },
        }),
        output: input('output', { type: { batch: false, cardinality: 'SINGLE', name: 'CollectionItemField' } }),
      }),
      outputs: {},
    };
    const sinkTemplate = template('sink', { value: input('value') });
    const forNode = buildInvocationNode(forTemplate, { x: 0, y: 0 });
    const returnNode = buildInvocationNode(returnTemplate, { x: 100, y: 0 });
    const sinkNode = buildInvocationNode(sinkTemplate, { x: 200, y: 0 });
    const connector = buildConnectorNode({ x: 50, y: 0 });
    const document: ProjectGraphState = {
      ...createProjectGraph('invalid-loop-linkage-source'),
      edges: [
        {
          id: 'item',
          source: forNode.id,
          sourceHandle: 'item',
          target: returnNode.id,
          targetHandle: 'output',
          type: 'default',
        },
        {
          id: 'linkage',
          source: forNode.id,
          sourceHandle: 'loop_linkage',
          target: returnNode.id,
          targetHandle: 'loop_linkage',
          type: 'loop_linkage',
        },
        {
          id: 'connector-in',
          source: forNode.id,
          sourceHandle: 'loop_linkage',
          target: connector.id,
          targetHandle: 'in',
          type: 'default',
        },
        {
          id: 'connector-out',
          source: connector.id,
          sourceHandle: 'out',
          target: sinkNode.id,
          targetHandle: 'value',
          type: 'default',
        },
      ],
      nodes: [forNode, returnNode, sinkNode, connector],
    };
    const loopTemplates = { for: forTemplate, for_return: returnTemplate, sink: sinkTemplate };

    expect(getProjectGraphReadiness(document, { error: null, status: 'loaded', templates: loopTemplates })).toEqual({
      canInvoke: false,
      reasons: [{ key: 'nodes.forLoopLinkageInvalid' }],
    });
  });
});

describe('planWorkflowSubmission', () => {
  const SEED_MAX = 4_294_967_295;
  const seedInput = input('seed', {
    default: 0,
    maximum: SEED_MAX,
    minimum: 0,
    type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
  });
  const seededTemplates = {
    integer: template('integer', {
      value: input('value', { default: 0, type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' } }),
    }),
    noise: template('noise', { seed: seedInput, width: input('width', { default: 512 }) }),
  };
  const seededTemplate = seededTemplates.noise;

  const buildSeeded = (nodes: Array<{ seed?: number; seedMode?: 'random' | 'fixed' | 'increment' | 'decrement' }>) => {
    let doc = createProjectGraph('seed-plan');
    const ids: string[] = [];

    for (const [index, config] of nodes.entries()) {
      const node = buildInvocationNode(seededTemplate, { x: index * 100, y: 0 });

      ids.push(node.id);
      doc = projectGraphReducer(doc, { node, type: 'addNode' });

      if (config.seed !== undefined) {
        doc = projectGraphReducer(doc, {
          fieldName: 'seed',
          nodeId: node.id,
          type: 'setFieldValue',
          value: config.seed,
        });
      }

      if (config.seedMode) {
        doc = projectGraphReducer(doc, {
          fieldName: 'seed',
          nodeId: node.id,
          seedMode: config.seedMode,
          type: 'setFieldSeedMode',
        });
      }
    }

    return { doc, ids };
  };

  it('repeats an unchanged graph while every seed holds', () => {
    const { doc, ids } = buildSeeded([{ seed: 7 }, { seed: 9, seedMode: 'fixed' }]);
    const plan = planWorkflowSubmission(doc, seededTemplates, { batchCount: 3 });

    expect(plan).toMatchObject({ batchCount: 3, seedAdvances: [], seeds: [] });
    expect(plan.graph.backendGraph.nodes[ids[0] as string]?.seed).toBe(7);
    expect(plan.graph.backendGraph.nodes[ids[1] as string]?.seed).toBe(9);
  });

  it('records one start per stepping seed and where each field goes after the batch', () => {
    const { doc, ids } = buildSeeded([
      { seed: 42, seedMode: 'increment' },
      { seed: 100, seedMode: 'decrement' },
      { seed: 5 },
    ]);
    const plan = planWorkflowSubmission(doc, seededTemplates, { batchCount: 3 });

    expect(plan.seeds).toEqual([
      { fieldName: 'seed', nodeId: ids[0], seed: 42, seedStep: 1 },
      { fieldName: 'seed', nodeId: ids[1], seed: 100, seedStep: -1 },
    ]);
    expect(plan.seedAdvances).toEqual([
      { fieldName: 'seed', fromSeed: 42, nodeId: ids[0], seedMode: 'increment', toSeed: 45 },
      { fieldName: 'seed', fromSeed: 100, nodeId: ids[1], seedMode: 'decrement', toSeed: 97 },
    ]);
    // Every node carries its first run's seed as a constant; the fixed one stays as authored.
    expect(plan.graph.backendGraph.nodes[ids[0] as string]?.seed).toBe(42);
    expect(plan.graph.backendGraph.nodes[ids[2] as string]?.seed).toBe(5);
    expect(plan.graph.nodes.find((node) => node.id === ids[1])?.inputs.seed).toBe(100);
  });

  it('wraps the authored seed and the advance over the inclusive seed range', () => {
    const { doc } = buildSeeded([{ seed: 1, seedMode: 'decrement' }]);
    const plan = planWorkflowSubmission(doc, seededTemplates, { batchCount: 3 });

    expect(plan.seeds[0]).toMatchObject({ seed: 1, seedStep: -1 });
    expect(plan.seedAdvances[0]?.toSeed).toBe(SEED_MAX - 1);
  });

  it('draws a random start into the graph and never advances the entered seed', () => {
    const { doc, ids } = buildSeeded([
      { seed: 42, seedMode: 'random' },
      { seed: 42, seedMode: 'random' },
    ]);
    // A constant draw: the graph id generator shares the random source, so a queue of draws would skew.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const start = Math.floor(0.25 * SEED_MAX);

    try {
      const plan = planWorkflowSubmission(doc, seededTemplates, { batchCount: 2 });

      expect(plan.seeds).toEqual([
        { fieldName: 'seed', nodeId: ids[0], seed: start, seedStep: 1 },
        { fieldName: 'seed', nodeId: ids[1], seed: start, seedStep: 1 },
      ]);
      expect(plan.seedAdvances).toEqual([]);
      expect(plan.graph.backendGraph.nodes[ids[0] as string]?.seed).toBe(start);
      // The document keeps the entered seed in reserve.
      expect(doc.nodes[0]).toMatchObject({ data: { inputs: { seed: { value: 42 } } } });
    } finally {
      random.mockRestore();
    }
  });

  it('leaves a connected seed to its upstream node and keeps the local mode for later', () => {
    const { doc, ids } = buildSeeded([{ seed: 42, seedMode: 'increment' }]);
    const source = buildInvocationNode(seededTemplates.integer, { x: -100, y: 0 });
    const connected = projectGraphReducer(projectGraphReducer(doc, { node: source, type: 'addNode' }), {
      edge: {
        id: 'e',
        source: source.id,
        sourceHandle: 'out',
        target: ids[0] as string,
        targetHandle: 'seed',
        type: 'default',
      },
      type: 'addEdge',
    });
    const plan = planWorkflowSubmission(connected, seededTemplates, { batchCount: 2 });

    expect(plan).toMatchObject({ seedAdvances: [], seeds: [] });
    expect(plan.graph.backendGraph.nodes[ids[0] as string]).not.toHaveProperty('seed');
    expect(connected.nodes.find((node) => node.id === ids[0])).toMatchObject({
      data: { inputs: { seed: { seedMode: 'increment', value: 42 } } },
    });
  });

  it('steps an empty seed input from the template default and fills it in afterwards', () => {
    const { doc, ids } = buildSeeded([{ seedMode: 'increment' }]);
    const emptied = projectGraphReducer(doc, {
      fieldName: 'seed',
      nodeId: ids[0] as string,
      type: 'setFieldValue',
      value: undefined,
    });
    const plan = planWorkflowSubmission(emptied, seededTemplates, { batchCount: 2 });

    expect(plan.seeds).toEqual([{ fieldName: 'seed', nodeId: ids[0], seed: 0, seedStep: 1 }]);
    expect(plan.graph.backendGraph.nodes[ids[0] as string]?.seed).toBe(0);
    // The advance is fenced on the empty value, so the field fills in with the seed after the batch.
    expect(plan.seedAdvances).toEqual([{ fieldName: 'seed', nodeId: ids[0], seedMode: 'increment', toSeed: 2 }]);
    expect(
      projectGraphReducer(emptied, { advances: plan.seedAdvances, type: 'advanceSeedFields' }).nodes[0]
    ).toMatchObject({ data: { inputs: { seed: { value: 2 } } } });
  });
});

describe('seed inputs', () => {
  const seed = (overrides: Partial<FieldInputTemplate> = {}) =>
    input('seed', {
      maximum: 4_294_967_295,
      minimum: 0,
      type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
      ...overrides,
    });

  it('recognises the scalar integer a node declares as seed over the seed range', () => {
    expect(isSeedInputField(seed())).toBe(true);
    // The title is what a user edits; the name and range are what the backend declared.
    expect(isSeedInputField(seed({ title: 'Noise seed' }))).toBe(true);
  });

  it('leaves other integers, other ranges, and connection-only seeds alone', () => {
    expect(isSeedInputField(seed({ name: 'steps' }))).toBe(false);
    expect(isSeedInputField(seed({ maximum: 1_000 }))).toBe(false);
    expect(isSeedInputField(seed({ maximum: null }))).toBe(false);
    expect(isSeedInputField(seed({ type: { batch: false, cardinality: 'SINGLE', name: 'FloatField' } }))).toBe(false);
    expect(isSeedInputField(seed({ type: { batch: false, cardinality: 'COLLECTION', name: 'IntegerField' } }))).toBe(
      false
    );
    expect(isSeedInputField(seed({ input: 'connection' }))).toBe(false);
  });

  it('requires the template to accept the whole walk: every value from 0 to the maximum in steps of one', () => {
    expect(isSeedInputField(seed({ minimum: null }))).toBe(true);
    expect(isSeedInputField(seed({ multipleOf: 1 }))).toBe(true);
    // A custom node with a seed of 1…SEED_MAX would receive Decrement and submit 0.
    expect(isSeedInputField(seed({ minimum: 1 }))).toBe(false);
    expect(isSeedInputField(seed({ exclusiveMinimum: 0 }))).toBe(false);
    expect(isSeedInputField(seed({ exclusiveMaximum: 4_294_967_295 }))).toBe(false);
    expect(isSeedInputField(seed({ multipleOf: 2 }))).toBe(false);
  });

  it('reads an absent or unknown mode as fixed', () => {
    expect(getWorkflowFieldSeedMode(undefined)).toBe('fixed');
    expect(getWorkflowFieldSeedMode({})).toBe('fixed');
    expect(getWorkflowFieldSeedMode({ seedMode: 'shuffle' as never })).toBe('fixed');
    expect(getWorkflowFieldSeedMode({ seedMode: 'decrement' })).toBe('decrement');
  });
});
