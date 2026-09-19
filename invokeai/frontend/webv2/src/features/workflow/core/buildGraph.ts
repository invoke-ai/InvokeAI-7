import { isSeedMode, planSeedSubmission, SEED_MAX, type SeedMode, wrapSeed } from '@platform/core/seed';

import type { CompiledWorkflowGraph, WorkflowBackendGraph } from './graphContracts';
import type {
  FieldInputTemplate,
  InvocationTemplates,
  InvocationTemplatesSnapshot,
  ProjectGraphState,
  WorkflowFieldInstance,
  WorkflowInvocationNode,
  WorkflowSeedFieldAdvance,
} from './types';

import { CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX } from './callSavedWorkflow';
import { createWorkflowId } from './document';
import { getWorkflowFieldInvalidReason, isDirectInputField } from './fields';
import {
  createForLoopValidationReason,
  ForLoopGraphValidationError,
  getCanonicalWorkflowEdges,
  validateForLoopGraph,
  type ForLoopValidationReason,
} from './forLoops';
import { isInvocationNode } from './types';
import { hasAnyCycle } from './validation';

/**
 * Compiles the project graph document into the immutable, queue-facing
 * `GraphContract`. Ported from the legacy `buildNodesGraph`, with connector
 * resolution and without batch handling (batch/generator nodes are rejected by
 * readiness until batching lands).
 */

/** Client-resolved batch/generator nodes from the legacy editor; executing them server-side is meaningless. */
const UNSUPPORTED_NODE_TYPES = new Set([
  'float_batch',
  'float_generator',
  'image_batch',
  'image_generator',
  'integer_batch',
  'integer_generator',
  'string_batch',
  'string_generator',
]);

export const isExecutableInvocationType = (type: string): boolean => !UNSUPPORTED_NODE_TYPES.has(type);

const getExecutableNodes = (document: ProjectGraphState): WorkflowInvocationNode[] =>
  document.nodes.filter(isInvocationNode);

const isMissingValue = (value: unknown): boolean => value === undefined || value === null;

const isEmptyValue = (value: unknown): boolean =>
  isMissingValue(value) || (typeof value === 'string' && value.trim() === '');

const getNodeDisplayName = (node: WorkflowInvocationNode, templates: InvocationTemplates): string =>
  node.data.label || templates[node.data.type]?.title || node.data.type;

const getNodeInputTemplates = (
  node: WorkflowInvocationNode,
  template: InvocationTemplates[string]
): FieldInputTemplate[] => Object.values({ ...template.inputs, ...node.data.dynamicInputTemplates });

/**
 * Translates a board field value to the backend shape: `auto` and `none`
 * sentinels are passed through for backend board handling.
 */
const toBoardGraphValue = (value: unknown): unknown => {
  if (isEmptyValue(value)) {
    return undefined;
  }

  return value;
};

export interface ProjectGraphReadiness {
  canInvoke: boolean;
  reasons: Array<string | ForLoopValidationReason>;
}

export interface ProjectGraphReadinessOptions {
  /** Required connection inputs supplied by an ephemeral caller after document compilation. */
  externallySatisfiedInputs?: ReadonlySet<string>;
}

export const getProjectGraphReadiness = (
  document: ProjectGraphState,
  templatesSnapshot: InvocationTemplatesSnapshot,
  options: ProjectGraphReadinessOptions = {}
): ProjectGraphReadiness => {
  if (templatesSnapshot.status === 'error') {
    return { canInvoke: false, reasons: ['Node definitions failed to load from the backend.'] };
  }

  if (templatesSnapshot.status !== 'loaded') {
    return { canInvoke: false, reasons: ['Node definitions are still loading.'] };
  }

  const templates = templatesSnapshot.templates;
  const executableNodes = getExecutableNodes(document);
  const canonicalEdges = getCanonicalWorkflowEdges(document);

  if (executableNodes.length === 0) {
    return { canInvoke: false, reasons: ['The project graph has no nodes. Add nodes in the Workflow view.'] };
  }

  const reasons: Array<string | ForLoopValidationReason> = [];
  const connectedInputs = new Set(
    canonicalEdges
      .filter((edge) => executableNodes.some((node) => node.id === edge.destination.node_id))
      .map((edge) => `${edge.destination.node_id}:${edge.destination.field}`)
  );

  for (const node of executableNodes) {
    const template = templates[node.data.type];

    if (!template) {
      reasons.push(`Unknown node type "${node.data.type}".`);
      continue;
    }

    if (!isExecutableInvocationType(node.data.type)) {
      reasons.push(`Batch/generator node "${getNodeDisplayName(node, templates)}" is not supported yet.`);
      continue;
    }

    if (node.data.type === 'call_saved_workflow') {
      const workflowId = node.data.inputs.workflow_id?.value;

      if (typeof workflowId !== 'string' || workflowId.trim() === '') {
        reasons.push('Call Saved Workflow requires a saved workflow.');
        continue;
      }

      if (node.data.callSavedWorkflowStatus === 'loading' || node.data.callSavedWorkflowStatus === undefined) {
        reasons.push('Call Saved Workflow inputs are still loading.');
        continue;
      }

      if (node.data.callSavedWorkflowStatus === 'error') {
        reasons.push('The selected saved workflow is unavailable or incompatible.');
        continue;
      }
    }

    for (const inputTemplate of getNodeInputTemplates(node, template)) {
      if (connectedInputs.has(`${node.id}:${inputTemplate.name}`)) {
        continue;
      }

      if (inputTemplate.input === 'connection') {
        if (inputTemplate.required && !options.externallySatisfiedInputs?.has(`${node.id}:${inputTemplate.name}`)) {
          reasons.push(
            `"${getNodeDisplayName(node, templates)}" is missing a connection for "${inputTemplate.title}".`
          );
        }
        continue;
      }

      const invalidReason = getWorkflowFieldInvalidReason({
        isConnected: false,
        template: inputTemplate,
        value: node.data.inputs[inputTemplate.name]?.value,
      });

      if (inputTemplate.required && isMissingValue(node.data.inputs[inputTemplate.name]?.value)) {
        reasons.push(`"${getNodeDisplayName(node, templates)}" is missing required input "${inputTemplate.title}".`);
      } else if (invalidReason) {
        reasons.push(`"${getNodeDisplayName(node, templates)}" has invalid input "${inputTemplate.title}".`);
      }
    }
  }

  if (
    hasAnyCycle(
      document.nodes,
      canonicalEdges.map((edge) => ({
        id: edge.id,
        source: edge.source.node_id,
        sourceHandle: edge.source.field,
        target: edge.destination.node_id,
        targetHandle: edge.destination.field,
        type: edge.type,
      }))
    )
  ) {
    reasons.push('The project graph contains a cycle.');
  }

  const forLoopError = validateForLoopGraph(document);

  if (forLoopError) {
    reasons.push(createForLoopValidationReason(forLoopError));
  }

  return { canInvoke: reasons.length === 0, reasons };
};

const toGraphInputValue = (inputTemplate: FieldInputTemplate, value: unknown): unknown => {
  if (inputTemplate.type.name === 'BoardField') {
    return toBoardGraphValue(value);
  }

  return value;
};

/** Compiles the document into a `GraphContract` carrying the executable backend graph. */
export const compileProjectGraph = (
  document: ProjectGraphState,
  templates: InvocationTemplates
): CompiledWorkflowGraph => {
  const forLoopError = validateForLoopGraph(document);

  if (forLoopError) {
    throw new ForLoopGraphValidationError(forLoopError);
  }

  const executableNodes = getExecutableNodes(document).filter((node) => templates[node.data.type] !== undefined);
  const executableNodeIds = new Set(executableNodes.map((node) => node.id));
  const backendGraph: WorkflowBackendGraph = { edges: [], id: createWorkflowId('workflow-graph'), nodes: {} };
  const resolvedEdges = getCanonicalWorkflowEdges(document);

  for (const node of executableNodes) {
    const template = templates[node.data.type] as NonNullable<(typeof templates)[string]>;
    const graphNode: Record<string, unknown> = {
      id: node.id,
      is_intermediate: node.data.isIntermediate,
      type: node.data.type,
      use_cache: node.data.useCache,
    };

    const workflowInputs: Record<string, unknown> = {};

    for (const instance of Object.values(node.data.inputs)) {
      const inputTemplate = node.data.dynamicInputTemplates?.[instance.name] ?? template.inputs[instance.name];

      if (!inputTemplate || instance.value === undefined) {
        continue;
      }

      const value = toGraphInputValue(inputTemplate, instance.value);

      if (value !== undefined) {
        if (
          node.data.type === 'call_saved_workflow' &&
          instance.name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX)
        ) {
          workflowInputs[instance.name] = value;
        } else {
          graphNode[instance.name] = value;
        }
      }
    }

    if (node.data.type === 'call_saved_workflow') {
      graphNode.workflow_inputs = workflowInputs;
    }

    backendGraph.nodes[node.id] = graphNode as WorkflowBackendGraph['nodes'][string];
  }

  const seenEdgeKeys = new Set<string>();

  for (const edge of resolvedEdges) {
    if (!executableNodeIds.has(edge.source.node_id) || !executableNodeIds.has(edge.destination.node_id)) {
      continue;
    }

    const key = `${edge.type}:${edge.source.node_id}:${edge.source.field}->${edge.destination.node_id}:${edge.destination.field}`;

    if (seenEdgeKeys.has(key)) {
      continue;
    }

    seenEdgeKeys.add(key);
    backendGraph.edges.push({
      destination: edge.destination,
      source: edge.source,
      type: edge.type,
    });

    // A connected input always wins over a stale direct value; sending both
    // would let pydantic reject the node on the ignored direct value.
    const targetNode = backendGraph.nodes[edge.destination.node_id];

    if (targetNode) {
      if (
        targetNode.type === 'call_saved_workflow' &&
        edge.destination.field.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX)
      ) {
        const workflowInputs = targetNode.workflow_inputs;

        if (workflowInputs && typeof workflowInputs === 'object') {
          delete (workflowInputs as Record<string, unknown>)[edge.destination.field];
        }
      } else {
        delete targetNode[edge.destination.field];
      }
    }
  }

  return {
    backendGraph,
    edges: resolvedEdges
      .filter((edge) => executableNodeIds.has(edge.source.node_id) && executableNodeIds.has(edge.destination.node_id))
      .map((edge) => ({
        id: edge.id,
        sourceField: edge.source.field,
        sourceNodeId: edge.source.node_id,
        targetField: edge.destination.field,
        targetNodeId: edge.destination.node_id,
        type: edge.type,
      })),
    id: backendGraph.id,
    label: document.name || 'Workflow',
    nodes: executableNodes.map((node) => ({
      id: node.id,
      inputs: Object.fromEntries(Object.values(node.data.inputs).map((instance) => [instance.name, instance.value])),
      type: node.data.type,
    })),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
};

/**
 * The inputs that carry a seed mode: the scalar integer a node declares as `seed`
 * over the full seed range. Read from the template alone, so an editable label
 * cannot turn an ordinary integer into a seed, and a provider's own-range `seed`
 * keeps its plain control instead of wrapping at a bound it never had.
 *
 * Seed policy lives here rather than in `fields.ts` because it is the one place
 * the workflow core depends on the platform seed arithmetic at runtime: the
 * shared field/document helpers stay in the lighter utility chunk every overlay loads.
 */
export const isSeedInputField = (template: FieldInputTemplate): boolean =>
  template.name === 'seed' &&
  template.type.name === 'IntegerField' &&
  template.type.cardinality === 'SINGLE' &&
  // The modes walk and wrap over 0…SEED_MAX in steps of one, so the template has to
  // accept every value on that walk; a tighter range or step keeps its plain control.
  template.maximum === SEED_MAX &&
  (template.minimum === null || template.minimum <= 0) &&
  template.exclusiveMinimum === null &&
  template.exclusiveMaximum === null &&
  (template.multipleOf === null || template.multipleOf === 1) &&
  isDirectInputField(template);

export const getWorkflowFieldSeedMode = (instance: Pick<WorkflowFieldInstance, 'seedMode'> | undefined): SeedMode =>
  isSeedMode(instance?.seedMode) ? instance.seedMode : 'fixed';

/** One seed input that varies between runs: the seed the first run uses and the direction of the rest. */
export interface WorkflowSeedAssignment {
  fieldName: string;
  nodeId: string;
  seed: number;
  seedStep: -1 | 1;
}

export interface WorkflowSeedPlan {
  /** Every unconnected seed input in a varying mode, with its first seed; fixed inputs are absent. */
  seeds: WorkflowSeedAssignment[];
  /** Stepping-mode fields to move once the submission is reserved. */
  seedAdvances: WorkflowSeedFieldAdvance[];
}

/**
 * Decides every seed input's start for a submission of `batchCount` runs. Seeds
 * vary per queued run, not per iteration of a loop inside a run. A random input
 * draws its start here and the runs step consecutively from it, like Generate's
 * random mode, while the entered seed stays in reserve; a stepping input counts
 * from the authored seed and reports where the field goes afterwards. Expansion
 * into per-run values happens at send time from these starts, never redrawing.
 */
export const planWorkflowSeeds = (
  document: ProjectGraphState,
  templates: InvocationTemplates,
  batchCount: number
): WorkflowSeedPlan => {
  const connectedInputs = new Set(
    getCanonicalWorkflowEdges(document).map((edge) => `${edge.destination.node_id}:${edge.destination.field}`)
  );
  const seeds: WorkflowSeedAssignment[] = [];
  const seedAdvances: WorkflowSeedFieldAdvance[] = [];

  for (const node of getExecutableNodes(document)) {
    const template = templates[node.data.type];

    if (!template) {
      continue;
    }

    for (const inputTemplate of Object.values({ ...template.inputs, ...node.data.dynamicInputTemplates })) {
      if (!isSeedInputField(inputTemplate) || connectedInputs.has(`${node.id}:${inputTemplate.name}`)) {
        continue;
      }

      const instance = node.data.inputs[inputTemplate.name];
      const seedMode = getWorkflowFieldSeedMode(instance);

      if (seedMode === 'fixed') {
        continue;
      }

      const authoredSeed =
        typeof instance?.value === 'number'
          ? instance.value
          : typeof inputTemplate.default === 'number'
            ? inputTemplate.default
            : 0;
      const startSeed = seedMode === 'random' ? Math.floor(Math.random() * SEED_MAX) : wrapSeed(authoredSeed);
      const plan = planSeedSubmission({
        batchCount,
        promptCount: 1,
        seedBehaviour: 'per-iteration',
        seedMode,
        startSeed,
      });

      seeds.push({
        fieldName: inputTemplate.name,
        nodeId: node.id,
        seed: startSeed,
        seedStep: seedMode === 'decrement' ? -1 : 1,
      });

      if (plan.nextSeed !== null) {
        seedAdvances.push({
          fieldName: inputTemplate.name,
          ...(typeof instance?.value === 'number' ? { fromSeed: instance.value } : {}),
          nodeId: node.id,
          seedMode,
          toSeed: plan.nextSeed,
        });
      }
    }
  }

  return { seedAdvances, seeds };
};

/** Writes each planned first seed into the compiled graph, so a single run needs no batch data. */
export const applyWorkflowSeeds = (
  graph: CompiledWorkflowGraph,
  seeds: readonly WorkflowSeedAssignment[]
): CompiledWorkflowGraph => {
  for (const { fieldName, nodeId, seed } of seeds) {
    const backendNode = graph.backendGraph.nodes[nodeId];
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);

    if (backendNode) {
      backendNode[fieldName] = seed;
    }

    if (node) {
      node.inputs[fieldName] = seed;
    }
  }

  return graph;
};

export interface WorkflowSubmissionPlan extends WorkflowSeedPlan {
  /** Runs the submission produces. */
  batchCount: number;
  graph: CompiledWorkflowGraph;
}

export interface WorkflowSubmissionPlanOptions {
  /** Runs per submission; already sanitized to a positive integer by the caller. */
  batchCount: number;
}

/** Compiles the document with every planned first seed in place and reports the seeds that vary. */
export const planWorkflowSubmission = (
  document: ProjectGraphState,
  templates: InvocationTemplates,
  { batchCount }: WorkflowSubmissionPlanOptions
): WorkflowSubmissionPlan => {
  const seedPlan = planWorkflowSeeds(document, templates, batchCount);

  return {
    ...seedPlan,
    batchCount,
    graph: applyWorkflowSeeds(compileProjectGraph(document, templates), seedPlan.seeds),
  };
};
