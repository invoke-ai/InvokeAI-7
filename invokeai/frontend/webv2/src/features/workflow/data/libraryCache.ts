import {
  assertAccountScopeCurrent,
  captureAccountScope,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';

import { getLibraryWorkflow, listLibraryWorkflows, type ListWorkflowsParams, type WorkflowLibraryPage } from './api';

/**
 * Serve cached library pages immediately and revalidate; local mutations invalidate ordering and pagination
 * together.
 */

const pageCache = new Map<string, WorkflowLibraryPage>();
const workflowCache = new Map<string, Record<string, unknown>>();

/** `JSON.stringify` on a sorted copy avoids delimiter collisions between tag values. */
const getTagsKey = (tags: string[] | undefined): string => JSON.stringify([...(tags ?? [])].sort());

const getPageKey = (params: ListWorkflowsParams): string =>
  `${params.category}|${params.page}|${params.perPage ?? 20}|${params.query?.trim() ?? ''}|${getTagsKey(params.tags)}`;

export const getCachedWorkflowPage = (params: ListWorkflowsParams): WorkflowLibraryPage | null =>
  pageCache.get(getPageKey(params)) ?? null;

/** Fetches a page and stores it; callers show `getCachedWorkflowPage` while this resolves. */
export const listLibraryWorkflowsCached = async (params: ListWorkflowsParams): Promise<WorkflowLibraryPage> => {
  const owner = captureAccountScope();
  const signal = params.signal ? AbortSignal.any([params.signal, owner.signal]) : owner.signal;
  const result = await listLibraryWorkflows({ ...params, signal });

  assertAccountScopeCurrent(owner);
  signal.throwIfAborted();
  pageCache.set(getPageKey(params), result);

  return result;
};

/** Workflow payloads are immutable per save; cache hits skip the fetch entirely. */
export const getLibraryWorkflowCached = async (
  workflowId: string,
  externalSignal?: AbortSignal
): Promise<Record<string, unknown>> => {
  const owner = captureAccountScope();
  const signal = externalSignal ? AbortSignal.any([externalSignal, owner.signal]) : owner.signal;

  signal.throwIfAborted();
  const cached = workflowCache.get(workflowId);

  if (cached) {
    assertAccountScopeCurrent(owner);
    return cached;
  }

  const result = await getLibraryWorkflow(workflowId, signal);

  assertAccountScopeCurrent(owner);
  signal.throwIfAborted();
  workflowCache.set(workflowId, result);

  return result;
};

type WorkflowLibraryCacheInvalidationListener = (workflowId?: string) => void;

const invalidationListeners = new Set<WorkflowLibraryCacheInvalidationListener>();

/** Registers a listener fired at the end of every `invalidateWorkflowLibraryCache()` call. */
export const onWorkflowLibraryCacheInvalidated = (listener: WorkflowLibraryCacheInvalidationListener): (() => void) => {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
};

export const invalidateWorkflowLibraryCache = (workflowId?: string): void => {
  pageCache.clear();
  workflowCache.clear();

  for (const listener of invalidationListeners) {
    listener(workflowId);
  }
};

registerAccountOwnedResource({
  clear: invalidateWorkflowLibraryCache,
  name: 'workflow-library',
});
