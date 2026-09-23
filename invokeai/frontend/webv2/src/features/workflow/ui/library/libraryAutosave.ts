/**
 * Deduplicate serialized content and retry failures only on edits/flush. Report saved only without newer edits.
 * Dispose flushes silently; hard tab closes can still lose debounced writes.
 */

export type LibrarySyncStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface LibraryAutosaverDeps {
  read(): { libraryWorkflowId: string | undefined; serialized: Record<string, unknown> };
  save(workflowId: string, serialized: Record<string, unknown>): Promise<void>;
  onStatus(status: LibrarySyncStatus): void;
  /** Idle window before a save (default 2000ms). */
  debounceMs?: number;
  timers?: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(handle: number): void;
  };
}

export const DEFAULT_LIBRARY_AUTOSAVE_DEBOUNCE_MS = 2000;

export const createLibraryAutosaver = (deps: LibraryAutosaverDeps) => {
  const debounceMs = deps.debounceMs ?? DEFAULT_LIBRARY_AUTOSAVE_DEBOUNCE_MS;
  const timers = deps.timers ?? {
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  };

  let timerHandle: number | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSavedJson: string | null = null;
  let disposed = false;
  /**
   * Increment revision per edit; stale successes remain dirty while failures still report error rather than
   * claiming unwritten work is safe.
   */
  let editGeneration = 0;

  const clearTimer = (): void => {
    if (timerHandle !== null) {
      timers.clearTimeout(timerHandle);
      timerHandle = null;
    }
  };

  const runSave = (): Promise<void> => {
    if (inFlight) {
      // Chain a rereading, deduplicating pass after active saves so mid-save edits persist without endless reruns.
      return inFlight.then(() => runSave());
    }

    const { libraryWorkflowId, serialized } = deps.read();

    if (!libraryWorkflowId) {
      return Promise.resolve();
    }

    const json = JSON.stringify(serialized);

    if (json === lastSavedJson) {
      if (!disposed) {
        deps.onStatus('saved');
      }
      return Promise.resolve();
    }

    if (!disposed) {
      deps.onStatus('saving');
    }

    const generationAtCapture = editGeneration;

    inFlight = deps
      .save(libraryWorkflowId, serialized)
      .then(() => {
        // `json` did reach the server, so it is still the dedupe baseline even
        // when newer edits exist — the next pass compares against it and saves
        // only the difference.
        lastSavedJson = json;
        if (!disposed) {
          deps.onStatus(editGeneration === generationAtCapture ? 'saved' : 'dirty');
        }
      })
      .catch(() => {
        if (!disposed) {
          deps.onStatus('error');
        }
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return {
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      // Flush pending edits on disposal while muting status callbacks.
      const hasPendingEdit = timerHandle !== null;
      clearTimer();
      if (hasPendingEdit) {
        void runSave();
      }
    },
    flush: (): Promise<void> => {
      if (disposed) {
        return Promise.resolve();
      }
      clearTimer();
      return runSave();
    },
    /** Marks the last save as matching `serialized` — call after load/bind so the loaded state is not re-saved. */
    markSynced: (serialized: Record<string, unknown>): void => {
      lastSavedJson = JSON.stringify(serialized);
    },
    notifyGraphChanged: (): void => {
      if (disposed || !deps.read().libraryWorkflowId) {
        return;
      }
      editGeneration += 1;
      deps.onStatus('dirty');
      clearTimer();
      timerHandle = timers.setTimeout(() => {
        timerHandle = null;
        void runSave();
      }, debounceMs);
    },
  };
};
