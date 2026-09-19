import type { WorkflowInvocationNode } from '@features/workflow/contracts';

import { describe, expect, it } from 'vitest';

import { shouldShowCallSavedWorkflowLoadingHint } from './InvocationFlowNode';

const node = (type: string, status?: WorkflowInvocationNode['data']['callSavedWorkflowStatus']) =>
  ({ data: { type, callSavedWorkflowStatus: status } }) as WorkflowInvocationNode;

describe('shouldShowCallSavedWorkflowLoadingHint', () => {
  it('shows the hint only while a selected child workflow is loading', () => {
    expect(shouldShowCallSavedWorkflowLoadingHint(node('call_saved_workflow', 'loading'))).toBe(true);
    expect(shouldShowCallSavedWorkflowLoadingHint(node('call_saved_workflow', 'ready'))).toBe(false);
    expect(shouldShowCallSavedWorkflowLoadingHint(node('call_saved_workflow', 'error'))).toBe(false);
    expect(shouldShowCallSavedWorkflowLoadingHint(node('call_saved_workflow'))).toBe(false);
    expect(shouldShowCallSavedWorkflowLoadingHint(node('other', 'loading'))).toBe(false);
  });
});
