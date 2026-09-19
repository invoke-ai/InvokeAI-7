import { describe, expect, it } from 'vitest';

import {
  buildSavedWorkflowOptions,
  getSavedWorkflowPickerOwnedQuery,
  getSavedWorkflowPickerSharedQuery,
  getSavedWorkflowSelectionState,
  mergeSavedWorkflowPickerItems,
  shouldFetchNextSavedWorkflowPickerPage,
} from './savedWorkflowFieldUtils';

const workflows = [
  {
    category: 'user' as const,
    call_saved_workflow_compatibility: { is_callable: true, message: null, reason: 'ok' },
    description: '',
    is_public: false,
    name: 'Alpha Workflow',
    workflow_id: 'workflow-a',
  },
  {
    category: 'default' as const,
    call_saved_workflow_compatibility: {
      is_callable: false,
      message: 'The workflow must contain exactly one workflow_return node.',
      reason: 'missing_workflow_return',
    },
    description: '',
    is_public: true,
    name: 'Beta Workflow',
    workflow_id: 'workflow-b',
  },
];

describe('savedWorkflowFieldUtils', () => {
  it('builds named picker options and disables incompatible workflows', () => {
    expect(buildSavedWorkflowOptions(workflows)).toEqual([
      { disabled: false, label: 'Alpha Workflow', value: 'workflow-a' },
      { disabled: true, label: 'Beta Workflow', value: 'workflow-b' },
    ]);
  });

  it('keeps a selected workflow visible when it is outside the current page', () => {
    const selected = { ...workflows[0], name: 'Paged Workflow', workflow_id: 'workflow-z' };

    expect(getSavedWorkflowSelectionState(workflows, 'workflow-z', selected)).toEqual({
      status: 'selected',
      workflow: selected,
    });
    expect(getSavedWorkflowSelectionState(workflows, 'missing')).toEqual({
      status: 'missing',
      workflowId: 'missing',
    });
  });

  it('queries owned/default and shared callable workflows separately', () => {
    expect(getSavedWorkflowPickerOwnedQuery('landscape')).toMatchObject({
      categories: ['user', 'default'],
      callable: true,
      isPublic: undefined,
      query: 'landscape',
    });
    expect(getSavedWorkflowPickerSharedQuery('landscape')).toMatchObject({
      categories: ['user'],
      callable: true,
      isPublic: true,
      query: 'landscape',
    });
  });

  it('merges owned and shared pages without duplicate workflow ids', () => {
    const shared = { ...workflows[0], is_public: true, name: 'Shared Workflow', workflow_id: 'workflow-shared' };

    expect(mergeSavedWorkflowPickerItems([workflows[0]], [workflows[1], workflows[0], shared])).toEqual([
      workflows[0],
      workflows[1],
      shared,
    ]);
  });

  it('fetches another picker page only while an idle query has one', () => {
    expect(shouldFetchNextSavedWorkflowPickerPage({ hasNextPage: true, isFetching: false })).toBe(true);
    expect(shouldFetchNextSavedWorkflowPickerPage({ hasNextPage: false, isFetching: false })).toBe(false);
    expect(shouldFetchNextSavedWorkflowPickerPage({ hasNextPage: true, isFetching: true })).toBe(false);
  });
});
