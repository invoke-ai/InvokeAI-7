import type { InfiniteData } from '@tanstack/react-query';

import {
  getLibraryWorkflowRecord,
  listLibraryWorkflows,
  type ListWorkflowsParams,
  type WorkflowLibraryPage,
  type WorkflowRecordDTO,
} from './api';

export const savedWorkflowDetailQueryKey = (workflowId: string) =>
  ['workflow', 'call-saved', 'detail', workflowId] as const;

export const isSavedWorkflowDetailQueryKey = (
  queryKey: readonly unknown[]
): queryKey is readonly ['workflow', 'call-saved', 'detail', string] =>
  queryKey[0] === 'workflow' &&
  queryKey[1] === 'call-saved' &&
  queryKey[2] === 'detail' &&
  typeof queryKey[3] === 'string' &&
  queryKey[3].length > 0;

type SavedWorkflowDetailQueryLike = {
  state: {
    data?: unknown;
    fetchStatus: 'fetching' | 'paused' | 'idle';
    isInvalidated: boolean;
    status: 'pending' | 'error' | 'success';
  };
};

export const shouldFetchSavedWorkflowDetail = (query: SavedWorkflowDetailQueryLike | undefined): boolean =>
  query === undefined ||
  (query.state.status === 'success' && query.state.isInvalidated && query.state.fetchStatus === 'idle');

export const getSavedWorkflowDetailQueryStatus = (
  query: SavedWorkflowDetailQueryLike | undefined
): 'missing' | 'loading' | 'ready' | 'error' => {
  if (!query) {
    return 'missing';
  }

  if (query.state.status === 'error') {
    return 'error';
  }

  if (query.state.status !== 'success' || query.state.fetchStatus !== 'idle') {
    return 'loading';
  }

  return query.state.data ? 'ready' : 'error';
};

export const savedWorkflowDetailQueryOptions = (workflowId: string) => ({
  queryKey: savedWorkflowDetailQueryKey(workflowId),
  queryFn: ({ signal }: { signal: AbortSignal }): Promise<WorkflowRecordDTO> =>
    getLibraryWorkflowRecord(workflowId, signal),
  retry: false,
  staleTime: 30_000,
});

export const savedWorkflowPickerQueryOptions = (params: ListWorkflowsParams) => ({
  queryKey: ['workflow', 'call-saved', 'picker', params] as const,
  queryFn: ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }): Promise<WorkflowLibraryPage> =>
    listLibraryWorkflows({ ...params, page: pageParam, signal }),
  initialPageParam: 0,
  getNextPageParam: (lastPage: WorkflowLibraryPage): number | undefined =>
    lastPage.page + 1 < lastPage.pages ? lastPage.page + 1 : undefined,
});

export const getWorkflowPagesItems = (
  data: InfiniteData<WorkflowLibraryPage, unknown> | undefined
): WorkflowLibraryPage['items'] => data?.pages.flatMap((page) => page.items) ?? [];
