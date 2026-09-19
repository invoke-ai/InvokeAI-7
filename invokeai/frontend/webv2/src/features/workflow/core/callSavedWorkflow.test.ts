import { describe, expect, it } from 'vitest';

import type {
  FieldInputTemplate,
  InvocationTemplate,
  InvocationTemplates,
  ProjectGraphState,
  WorkflowInvocationNode,
} from './types';

import { compileProjectGraph, getProjectGraphReadiness } from './buildGraph';
import {
  CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX,
  getSavedWorkflowDynamicEdgeIdsToRemove,
  getSavedWorkflowDynamicFields,
  syncCallSavedWorkflowFields,
} from './callSavedWorkflow';
import { buildInvocationNode, createProjectGraph, projectGraphReducer } from './document';
import { parseWorkflowJson, serializeWorkflowJson } from './workflowJson';

const field = (name: string, typeName: string, overrides: Partial<FieldInputTemplate> = {}): FieldInputTemplate => ({
  default: typeName === 'IntegerField' ? 0 : '',
  description: `The ${name} field`,
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
  title: name === 'a' ? 'Left Addend' : 'B',
  type: { batch: false, cardinality: 'SINGLE', name: typeName },
  uiChoiceLabels: null,
  uiComponent: null,
  uiHidden: false,
  uiModelBase: null,
  uiModelFormat: null,
  uiModelType: null,
  uiOrder: null,
  ...overrides,
});

const addTemplate: InvocationTemplate = {
  category: 'math',
  classification: 'stable',
  description: 'Adds values',
  inputs: { a: field('a', 'IntegerField'), b: field('b', 'IntegerField') },
  nodePack: 'invokeai',
  outputType: 'integer_output',
  outputs: {
    value: {
      description: '',
      name: 'value',
      title: 'Value',
      type: { batch: false, cardinality: 'SINGLE', name: 'IntegerField' },
    },
  },
  tags: [],
  title: 'Add',
  type: 'add',
  useCache: true,
  version: '1.0.0',
};

const callSavedWorkflowTemplate: InvocationTemplate = {
  category: 'workflow',
  classification: 'stable',
  description: 'Calls a saved workflow',
  inputs: {
    workflow_id: field('workflow_id', 'SavedWorkflowField', { default: '' }),
    workflow_inputs: field('workflow_inputs', 'AnyField', { default: {}, uiHidden: true }),
  },
  nodePack: 'invokeai',
  outputType: 'image_output',
  outputs: {},
  tags: [],
  title: 'Call Saved Workflow',
  type: 'call_saved_workflow',
  useCache: true,
  version: '1.0.0',
};

const templates: InvocationTemplates = {
  add: addTemplate,
  call_saved_workflow: callSavedWorkflowTemplate,
};

const buildChildWorkflow = (): ProjectGraphState => {
  const childNode = buildInvocationNode(addTemplate, { x: 0, y: 0 });
  childNode.id = 'node-1';
  childNode.data.inputs.a = { label: 'Left Addend', name: 'a', value: 23 };
  childNode.data.inputs.b = { label: '', name: 'b', value: 2 };

  let document = createProjectGraph('child-workflow', 'Child Workflow');
  document = projectGraphReducer(document, { node: childNode, type: 'addNode' });
  document = projectGraphReducer(document, {
    fieldIdentifier: { fieldName: 'a', nodeId: childNode.id },
    type: 'exposeField',
  });
  document = projectGraphReducer(document, {
    fieldIdentifier: { fieldName: 'b', nodeId: childNode.id },
    type: 'exposeField',
  });
  return document;
};

const dynamicFieldName = (fieldName: string): string =>
  `${CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX}node-1::${fieldName}`;

describe('Call Saved Workflow dynamic fields', () => {
  it('ports the ordered exposed fields with child labels and defaults', () => {
    const fields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates);

    expect(fields.map((item) => item.fieldName)).toEqual([dynamicFieldName('a'), dynamicFieldName('b')]);
    expect(fields.map((item) => item.fieldTemplate.title)).toEqual(['Left Addend', 'B']);
    expect(fields.map((item) => item.initialValue)).toEqual([23, 2]);
    expect(fields[0]?.fieldTemplate.input).toBe('any');
  });

  it('preserves compatible dynamic values and resets incompatible values', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    const firstFields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates);
    const first = syncCallSavedWorkflowFields(
      { ...createProjectGraph('parent'), nodes: [callNode] },
      callNode.id,
      firstFields,
      []
    );
    const edited = projectGraphReducer(first, {
      fieldName: dynamicFieldName('a'),
      nodeId: callNode.id,
      type: 'setFieldValue',
      value: 99,
    });
    const incompatible = firstFields.map((item) =>
      item.fieldName === dynamicFieldName('a')
        ? {
            ...item,
            fieldTemplate: { ...item.fieldTemplate, type: { ...item.fieldTemplate.type, name: 'StringField' } },
            initialValue: 'new default',
          }
        : item
    );
    const second = syncCallSavedWorkflowFields(edited, callNode.id, incompatible, []);
    const node = second.nodes.find((candidate): candidate is WorkflowInvocationNode => candidate.id === callNode.id);

    expect(node?.data.inputs[dynamicFieldName('a')]?.value).toBe('new default');
    expect(node?.data.inputs[dynamicFieldName('b')]?.value).toBe(2);
  });

  it('preserves dynamic values and user presentation overrides after JSON reload', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    const fields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates);
    let document = syncCallSavedWorkflowFields(
      { ...createProjectGraph('parent'), nodes: [callNode] },
      callNode.id,
      fields,
      []
    );
    document = projectGraphReducer(document, {
      fieldName: dynamicFieldName('a'),
      nodeId: callNode.id,
      type: 'setFieldValue',
      value: 99,
    });
    document = projectGraphReducer(document, {
      fieldName: dynamicFieldName('a'),
      label: 'Custom label',
      nodeId: callNode.id,
      type: 'setFieldLabel',
    });
    document = projectGraphReducer(document, {
      description: 'Custom description',
      fieldName: dynamicFieldName('a'),
      nodeId: callNode.id,
      type: 'setFieldDescription',
    });

    const reloaded = parseWorkflowJson(serializeWorkflowJson(document)).document;
    const resynced = syncCallSavedWorkflowFields(reloaded, callNode.id, fields, []);
    const node = resynced.nodes.find((candidate): candidate is WorkflowInvocationNode => candidate.id === callNode.id);

    expect(node?.data.inputs[dynamicFieldName('a')]).toMatchObject({
      description: 'Custom description',
      label: 'Custom label',
      value: 99,
    });
  });

  it('deduplicates duplicate child form fields before syncing', () => {
    const child = buildChildWorkflow();
    const root = child.form.elements[child.form.rootElementId];
    const firstField = Object.values(child.form.elements).find(
      (element) => element.type === 'node-field' && element.data.fieldIdentifier.fieldName === 'a'
    );

    expect(root?.type).toBe('container');
    expect(firstField?.type).toBe('node-field');

    if (root?.type !== 'container' || firstField?.type !== 'node-field') {
      return;
    }

    child.form.elements.duplicate = { ...firstField, id: 'duplicate' };
    root.data.children.push('duplicate');

    const fields = getSavedWorkflowDynamicFields(child, templates);

    expect(fields.map((item) => item.fieldName)).toEqual([dynamicFieldName('a'), dynamicFieldName('b')]);
  });

  it('marks a selected Call Saved Workflow as not ready until its child is synchronized', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    const document = projectGraphReducer(
      { ...createProjectGraph('parent'), nodes: [callNode] },
      { fieldName: 'workflow_id', nodeId: callNode.id, type: 'setFieldValue', value: 'child-1' }
    );
    const readiness = getProjectGraphReadiness(document, { error: null, status: 'loaded', templates });

    expect(readiness.canInvoke).toBe(false);
    expect(readiness.reasons).toContain('Call Saved Workflow inputs are still loading.');
  });

  it('blocks empty and incompatible Call Saved Workflow selections', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    const emptyReadiness = getProjectGraphReadiness(
      { ...createProjectGraph('empty-selection'), nodes: [callNode] },
      { error: null, status: 'loaded', templates }
    );
    const selected = projectGraphReducer(
      { ...createProjectGraph('incompatible-selection'), nodes: [callNode] },
      { fieldName: 'workflow_id', nodeId: callNode.id, type: 'setFieldValue', value: 'child-1' }
    );
    const incompatible = projectGraphReducer(selected, {
      nodeId: callNode.id,
      status: 'error',
      type: 'setCallSavedWorkflowStatus',
    });

    expect(emptyReadiness).toMatchObject({
      canInvoke: false,
      reasons: ['Call Saved Workflow requires a saved workflow.'],
    });
    expect(getProjectGraphReadiness(incompatible, { error: null, status: 'loaded', templates })).toMatchObject({
      canInvoke: false,
      reasons: ['The selected saved workflow is unavailable or incompatible.'],
    });
  });

  it('removes dynamic edges whose exposed field disappeared or changed type', () => {
    const source = buildInvocationNode(addTemplate, { x: 0, y: 0 });
    source.id = 'source-1';
    const target = buildInvocationNode(callSavedWorkflowTemplate, { x: 100, y: 0 });
    target.id = 'call-1';
    const document = {
      ...createProjectGraph('parent'),
      nodes: [source, target],
      edges: [
        {
          id: 'edge-a',
          source: source.id,
          sourceHandle: 'value',
          target: target.id,
          targetHandle: dynamicFieldName('a'),
          type: 'default' as const,
        },
      ],
    };

    expect(getSavedWorkflowDynamicEdgeIdsToRemove(document, target.id, [], templates)).toEqual(['edge-a']);
  });

  it('packs dynamic literals into workflow_inputs and removes connected literals', () => {
    const source = buildInvocationNode(addTemplate, { x: 0, y: 0 });
    source.id = 'source-1';
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 100, y: 0 });
    callNode.id = 'call-1';
    const fields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates);
    let document = syncCallSavedWorkflowFields(
      { ...createProjectGraph('parent'), nodes: [source, callNode] },
      callNode.id,
      fields,
      []
    );
    document = projectGraphReducer(document, {
      fieldName: dynamicFieldName('a'),
      nodeId: callNode.id,
      type: 'setFieldValue',
      value: 42,
    });

    const literalGraph = compileProjectGraph(document, templates);
    expect(literalGraph.backendGraph.nodes[callNode.id]).toMatchObject({
      workflow_inputs: { [dynamicFieldName('a')]: 42, [dynamicFieldName('b')]: 2 },
    });

    document = projectGraphReducer(document, {
      edge: {
        id: 'edge-a',
        source: source.id,
        sourceHandle: 'value',
        target: callNode.id,
        targetHandle: dynamicFieldName('a'),
        type: 'default',
      },
      type: 'addEdge',
    });
    const connectedGraph = compileProjectGraph(document, templates);

    expect(connectedGraph.backendGraph.nodes[callNode.id]).toMatchObject({
      workflow_inputs: { [dynamicFieldName('b')]: 2 },
    });
    expect(connectedGraph.backendGraph.nodes[callNode.id]).not.toHaveProperty(
      `workflow_inputs.${dynamicFieldName('a')}`
    );
  });

  it('checks required dynamic fields when determining workflow readiness', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    callNode.data.inputs.workflow_id = { label: '', name: 'workflow_id', value: 'child-1' };
    const fields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates).map((field) => ({
      ...field,
      fieldTemplate: { ...field.fieldTemplate, required: true },
      initialValue: undefined,
    }));
    const document = syncCallSavedWorkflowFields(
      { ...createProjectGraph('parent'), nodes: [callNode] },
      callNode.id,
      fields,
      []
    );
    const readiness = getProjectGraphReadiness(document, { error: null, status: 'loaded', templates });

    expect(readiness.canInvoke).toBe(false);
    expect(readiness.reasons).toContain('"Call Saved Workflow" is missing required input "Left Addend".');
  });

  it('clears dynamic state when the selected workflow changes', () => {
    const callNode = buildInvocationNode(callSavedWorkflowTemplate, { x: 0, y: 0 });
    callNode.id = 'call-1';
    const fields = getSavedWorkflowDynamicFields(buildChildWorkflow(), templates);
    const document = syncCallSavedWorkflowFields(
      { ...createProjectGraph('parent'), nodes: [callNode] },
      callNode.id,
      fields,
      []
    );
    const changed = projectGraphReducer(document, {
      fieldName: 'workflow_id',
      nodeId: callNode.id,
      type: 'setFieldValue',
      value: 'workflow-2',
    });
    const node = changed.nodes.find((candidate): candidate is WorkflowInvocationNode => candidate.id === callNode.id);

    expect(node?.data.dynamicInputTemplates).toEqual({});
    expect(
      Object.keys(node?.data.inputs ?? {}).some((name) => name.startsWith(CALL_SAVED_WORKFLOW_DYNAMIC_FIELD_PREFIX))
    ).toBe(false);
  });
});
