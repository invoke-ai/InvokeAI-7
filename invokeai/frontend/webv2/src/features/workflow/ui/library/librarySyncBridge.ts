/**
 * Expose the mounted autosaver's markSynced without importing chrome; load/save paths use it to prevent immediate
 * echo autosaves.
 */

type MarkSyncedFn = (serialized: Record<string, unknown>) => void;

let markSyncedImpl: MarkSyncedFn | null = null;

export const registerLibraryGraphSyncedHandler = (fn: MarkSyncedFn): void => {
  markSyncedImpl = fn;
};

export const releaseLibraryGraphSyncedHandler = (fn: MarkSyncedFn): void => {
  if (markSyncedImpl === fn) {
    markSyncedImpl = null;
  }
};

export const markLibraryGraphSynced: MarkSyncedFn = (serialized) => markSyncedImpl?.(serialized);
