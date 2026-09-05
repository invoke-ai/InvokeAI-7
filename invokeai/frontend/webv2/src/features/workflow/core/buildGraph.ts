import type { CompiledWorkflowGraph, WorkflowBackendGraph } from './graphContracts';
import type {
  FieldInputTemplate,
  InvocationTemplates,
  InvocationTemplatesSnapshot,
  ProjectGraphState,
  WorkflowInvocationNode,
} from './types';

import { createWorkflowId } from './document';
import { getWorkflowFieldInvalidReason } from './fields';
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

const isEmptyValue = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const getNodeDisplayName = (node: WorkflowInvocationNode, templates: InvocationTemplates): string =>
  node.data.label || templates[node.data.type]?.title || node.data.type;

/**
 * Translates a board field value to the backend shape: `auto` and `none`
 * sentinels are omitted so the backend applies its default board behavior.
 */
const toBoardGraphValue = (value: unknown): unknown => {
  if (value === 'auto' || value === 'none' || isEmptyValue(value)) {
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

    for (const inputTemplate of Object.values(template.inputs)) {
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

      if (inputTemplate.required && isEmptyValue(node.data.inputs[inputTemplate.name]?.value)) {
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

    for (const instance of Object.values(node.data.inputs)) {
      const inputTemplate = template.inputs[instance.name];

      if (!inputTemplate || instance.value === undefined) {
        continue;
      }

      const value = toGraphInputValue(inputTemplate, instance.value);

      if (value !== undefined) {
        graphNode[instance.name] = value;
      }
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
      delete targetNode[edge.destination.field];
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
