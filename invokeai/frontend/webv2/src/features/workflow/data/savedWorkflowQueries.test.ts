import { describe, expect, it } from 'vitest';

import {
  getSavedWorkflowDetailQueryStatus,
  isSavedWorkflowDetailQueryKey,
  savedWorkflowDetailQueryOptions,
  shouldFetchSavedWorkflowDetail,
} from './savedWorkflowQueries';

describe('saved workflow detail query policy', () => {
  it('recognizes only detail query keys with a workflow id', () => {
    expect(isSavedWorkflowDetailQueryKey(['workflow', 'call-saved', 'detail', 'workflow-1'])).toBe(true);
    expect(isSavedWorkflowDetailQueryKey(['workflow', 'call-saved', 'picker', 'workflow-1'])).toBe(false);
    expect(isSavedWorkflowDetailQueryKey(['workflow', 'call-saved', 'detail'])).toBe(false);
  });

  it('fetches missing or invalidated detail queries but never retries an error from cache notifications', () => {
    expect(shouldFetchSavedWorkflowDetail(undefined)).toBe(true);
    expect(
      shouldFetchSavedWorkflowDetail({ state: { fetchStatus: 'idle', isInvalidated: true, status: 'success' } })
    ).toBe(true);
    expect(
      shouldFetchSavedWorkflowDetail({ state: { fetchStatus: 'idle', isInvalidated: false, status: 'success' } })
    ).toBe(false);
    expect(
      shouldFetchSavedWorkflowDetail({ state: { fetchStatus: 'fetching', isInvalidated: true, status: 'pending' } })
    ).toBe(false);
    expect(
      shouldFetchSavedWorkflowDetail({ state: { fetchStatus: 'idle', isInvalidated: true, status: 'error' } })
    ).toBe(false);
  });

  it('classifies detail query state for reconciliation', () => {
    expect(getSavedWorkflowDetailQueryStatus(undefined)).toBe('missing');
    expect(
      getSavedWorkflowDetailQueryStatus({ state: { fetchStatus: 'fetching', isInvalidated: false, status: 'pending' } })
    ).toBe('loading');
    expect(
      getSavedWorkflowDetailQueryStatus({ state: { fetchStatus: 'idle', isInvalidated: false, status: 'error' } })
    ).toBe('error');
    expect(
      getSavedWorkflowDetailQueryStatus({
        state: { data: { workflow_id: 'workflow-1' }, fetchStatus: 'idle', isInvalidated: false, status: 'success' },
      })
    ).toBe('ready');
  });

  it('does not retry a failed detail lookup', () => {
    expect(savedWorkflowDetailQueryOptions('workflow-1').retry).toBe(false);
  });
});
