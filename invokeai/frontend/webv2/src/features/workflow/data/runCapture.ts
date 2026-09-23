import type { QueueWorkflowRunCompletedEvent, QueueWorkflowRunSink } from '@features/queue/contracts';
import type { AccountScope } from '@platform/state/accountLifecycle';

import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';

import { setLibraryWorkflowThumbnail, touchLibraryWorkflowLastRunAt } from './api';
import { getLibraryWorkflowCached, invalidateWorkflowLibraryCache } from './libraryCache';

/**
 * Best-effort capture decorates successful runs with cover/last-run metadata; failures stay silent and must not
 * affect run success.
 */

export interface RunCaptureDeps {
  /** Downloads the gallery thumbnail bytes for one result image. */
  fetchThumbnailBlob(imageName: string, signal: AbortSignal): Promise<Blob>;
  getWorkflow(workflowId: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
  invalidateCache(): void;
  setThumbnail(workflowId: string, image: Blob, signal?: AbortSignal): Promise<void>;
  touchLastRunAt(workflowId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Load gallery URL ownership lazily to avoid its UI dependencies in Queue bundles; fetch media with the existing
 * path-scoped cookie.
 */
const fetchThumbnailBlob = async (imageName: string, signal: AbortSignal): Promise<Blob> => {
  const { galleryImageUrls } = await import('@features/gallery/utility');
  const response = await fetch(galleryImageUrls.thumbnail(imageName), { credentials: 'same-origin', signal });

  if (!response.ok) {
    throw new Error(`Thumbnail request for ${imageName} failed with status ${response.status}.`);
  }

  return response.blob();
};

const PRODUCTION_DEPS: RunCaptureDeps = {
  fetchThumbnailBlob,
  getWorkflow: getLibraryWorkflowCached,
  invalidateCache: invalidateWorkflowLibraryCache,
  setThumbnail: setLibraryWorkflowThumbnail,
  touchLastRunAt: touchLibraryWorkflowLastRunAt,
};

/**
 * Bundled defaults ship in `meta.category: 'default'` and are read-only for the
 * account, so a run of one must not write a thumbnail or a last-run stamp.
 */
const isUserWorkflow = (workflow: Record<string, unknown>): boolean => {
  const meta = workflow.meta;

  return typeof meta === 'object' && meta !== null && (meta as { category?: unknown }).category === 'user';
};

interface PendingCapture {
  event: QueueWorkflowRunCompletedEvent;
  /** The scope the run settled under; a later account owns none of its writes. */
  owner: AccountScope;
}

export const createWorkflowRunCaptureSink = (overrides?: Partial<RunCaptureDeps>): QueueWorkflowRunSink => {
  const deps: RunCaptureDeps = { ...PRODUCTION_DEPS, ...overrides };
  // Serialize captures per library record while allowing different workflows to upload independently.
  const draining = new Map<string, Promise<void>>();
  // At most one queued capture per record: while one is uploading, a newer run
  // supersedes any other run still waiting, because only the newest output
  // should end up as the cover.
  const pending = new Map<string, PendingCapture>();

  const capture = async ({ event, owner }: PendingCapture): Promise<void> => {
    const { imageNames, libraryWorkflowId } = event;
    const imageName = imageNames[imageNames.length - 1];

    if (!imageName || !isAccountScopeCurrent(owner)) {
      return;
    }

    const workflow = await deps.getWorkflow(libraryWorkflowId, owner.signal);

    if (!isAccountScopeCurrent(owner) || !isUserWorkflow(workflow)) {
      return;
    }

    const blob = await deps.fetchThumbnailBlob(imageName, owner.signal);

    if (!isAccountScopeCurrent(owner)) {
      return;
    }

    await deps.setThumbnail(libraryWorkflowId, blob, owner.signal);

    if (!isAccountScopeCurrent(owner)) {
      return;
    }

    // Ordered after the upload so a library row never advertises a fresh run
    // against a stale cover.
    await deps.touchLastRunAt(libraryWorkflowId, owner.signal);

    if (isAccountScopeCurrent(owner)) {
      deps.invalidateCache();
    }
  };

  const drain = async (libraryWorkflowId: string): Promise<void> => {
    for (let next = pending.get(libraryWorkflowId); next !== undefined; next = pending.get(libraryWorkflowId)) {
      pending.delete(libraryWorkflowId);

      try {
        await capture(next);
      } catch {
        // A failed capture must not prevent later completed runs from trying again.
      }
    }

    draining.delete(libraryWorkflowId);
  };

  return {
    onWorkflowRunCompleted: (event) => {
      if (event.imageNames.length === 0) {
        return;
      }

      pending.set(event.libraryWorkflowId, { event, owner: captureAccountScope() });

      if (!draining.has(event.libraryWorkflowId)) {
        draining.set(event.libraryWorkflowId, drain(event.libraryWorkflowId));
      }
    },
  };
};
