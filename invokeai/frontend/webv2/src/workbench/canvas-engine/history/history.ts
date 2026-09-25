/**
 * Engine-owned opaque undo/redo entries account for pixel and structural edits. Evict oldest entries beyond {@link
 * HISTORY_MAX_ENTRIES} or {@link HISTORY_BYTE_BUDGET} across both stacks. During replay `isApplying` prevents
 * recording and `push` is a no-op, avoiding recursive history.
 */

import { collectRestorableAssetRefs } from '@workbench/mediaReferences';

/** Max number of undo entries retained before the oldest is evicted. */
export const HISTORY_MAX_ENTRIES = 64;

/** Max total bytes retained across the undo + redo stacks before the oldest is evicted (256 MB). */
export const HISTORY_BYTE_BUDGET = 256 * 1024 * 1024;

export interface HeldAssetRefs {
  readonly images: readonly string[];
  readonly videos: readonly string[];
}

/** For entries that restore pixels or selection state only. */
export const NO_HELD_ASSET_REFS: HeldAssetRefs = { images: [], videos: [] };

/** Media names captured by an undo entry, including sources no longer in the live document. */
export const collectHistoryMediaRefs = (...values: unknown[]): HeldAssetRefs => {
  const { images, videos } = collectRestorableAssetRefs(...values);
  return { images: [...images], videos: [...videos] };
};

/** One reversible step. `bytes` is the (approximate) memory the entry pins, for the budget. */
export interface HistoryEntry {
  /** Human-readable label (e.g. "Brush stroke"). */
  readonly label: string;
  /** Approximate retained size in bytes (e.g. before+after ImageData byteLength). */
  readonly bytes: number;
  /**
   * Media names this entry can restore after they leave the current document; cleanup keeps them while the entry is
   * on either stack.
   */
  readonly heldAssetRefs: HeldAssetRefs;
  /**
   * Opts into failure-atomic replay. When true, History moves this entry only
   * after `undo`/`redo` returns successfully, so a preparation failure remains
   * exactly retryable. The callback must leave its domain unchanged on throw.
   *
   * Legacy entries default to move-before-replay semantics: a throw is treated
   * as post-application observer failure and the entry stays on its destination
   * stack, preventing a retry from applying the same mutation twice.
   */
  readonly replayFailureAtomic?: boolean;
  /** Releases resources retained only by this entry when it is permanently dropped. */
  readonly dispose?: () => void;
  /** Reverts the change. Must not push new history entries. */
  undo(): void;
  /** Re-applies the change. Must not push new history entries. */
  redo(): void;
}

/** Options for {@link createHistory}. */
export interface CreateHistoryOptions {
  /** Undo-entry cap (default {@link HISTORY_MAX_ENTRIES}). */
  maxEntries?: number;
  /** Total-byte cap across both stacks (default {@link HISTORY_BYTE_BUDGET}). */
  byteBudget?: number;
}

/** The imperative history handle. */
export interface History {
  /** Records a new entry (clearing the redo stack) and enforces the budgets. No-op while applying. */
  push(entry: HistoryEntry): void;
  /**
   * Replaces the latest undo entry for coalescing, adjusts bytes and clears redo. Falls back to {@link push} if
   * empty; no-op during replay.
   */
  amendLast(entry: HistoryEntry): void;
  /** Reverts the most recent entry (moving it onto the redo stack). No-op when empty or already applying. */
  undo(): void;
  /** Re-applies the most recently undone entry (moving it back onto the undo stack). No-op when empty or applying. */
  redo(): void;
  /** True when there is at least one entry that can be undone. */
  canUndo(): boolean;
  /** True when there is at least one entry that can be redone. */
  canRedo(): boolean;
  /** True while an entry's `undo`/`redo` is executing (re-entrancy guard). */
  isApplying(): boolean;
  /** Drops both stacks (document replace / project switch / snapshot restore). */
  clear(): void;
  /** Current retained bytes across undo and redo stacks. */
  byteSize(): number;
  /** Whether one entry can remain undoable after normal oldest-entry eviction. */
  canRetain(bytes: number): boolean;
  /** Evicts oldest entries until retained bytes are at or below `budgetBytes`. */
  trimToBytes(budgetBytes: number): void;
  /**
   * Labels of every retained step: `past` oldest-first (its last element is
   * what `undo()` reverts), `future` next-redo-first. Fresh arrays per call.
   */
  entries(): { past: readonly string[]; future: readonly string[] };
  /** Union of media references retained by undo and redo entries. */
  heldAssetRefs(): HeldAssetRefs;
  /** Subscribes to every stack mutation (push, amend, undo, redo, clear, eviction). Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Creates a bounded history stack. */
export const createHistory = (opts: CreateHistoryOptions = {}): History => {
  const maxEntries = Math.max(1, opts.maxEntries ?? HISTORY_MAX_ENTRIES);
  const byteBudget = Math.max(0, opts.byteBudget ?? HISTORY_BYTE_BUDGET);

  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const listeners = new Set<() => void>();

  const disposeEntry = (entry: HistoryEntry): void => {
    try {
      entry.dispose?.();
    } catch {
      // Stack ownership has already ended. Resource cleanup cannot restore the
      // entry and must not prevent the remaining history from being released.
    }
  };

  // Running byte totals, kept in sync with the stacks so eviction is O(1) per drop.
  let undoBytes = 0;
  let redoBytes = 0;
  // Re-entrancy flag: true while replaying an entry.
  let applying = false;

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Stack mutation is already complete. One faulty observer must neither
        // report a false operation failure nor block later subscribers.
      }
    }
  };

  const clearRedo = (): void => {
    if (redoStack.length === 0) {
      return;
    }
    const discarded = redoStack.splice(0);
    discarded.forEach(disposeEntry);
    redoBytes = 0;
  };

  /** Evicts the oldest undo entries until BOTH budgets are satisfied. */
  const enforceBudgets = (): void => {
    while (undoStack.length > maxEntries && undoStack.length > 0) {
      const evicted = undoStack.shift();
      if (evicted) {
        undoBytes -= evicted.bytes;
        disposeEntry(evicted);
      }
    }
    while (undoBytes + redoBytes > byteBudget && undoStack.length > 0) {
      const evicted = undoStack.shift();
      if (evicted) {
        undoBytes -= evicted.bytes;
        disposeEntry(evicted);
      }
    }
  };

  const entries = (): { past: readonly string[]; future: readonly string[] } => ({
    future: redoStack.map((entry) => entry.label).reverse(),
    past: undoStack.map((entry) => entry.label),
  });

  // Reused while the stacks hold the same entries, so an unchanged union keeps its identity for the hold lease.
  let heldUnion: { parts: HeldAssetRefs[]; refs: HeldAssetRefs } | null = null;
  const heldAssetRefs = (): HeldAssetRefs => {
    const parts = [...undoStack, ...redoStack].map((entry) => entry.heldAssetRefs);
    if (
      heldUnion &&
      heldUnion.parts.length === parts.length &&
      parts.every((part, i) => part === heldUnion!.parts[i])
    ) {
      return heldUnion.refs;
    }
    const images = new Set<string>();
    const videos = new Set<string>();
    for (const part of parts) {
      part.images.forEach((name) => images.add(name));
      part.videos.forEach((name) => videos.add(name));
    }
    heldUnion = { parts, refs: { images: [...images], videos: [...videos] } };
    return heldUnion.refs;
  };

  const push = (entry: HistoryEntry): void => {
    // Replaying an entry must never record a new one; drop it defensively.
    if (applying) {
      disposeEntry(entry);
      return;
    }
    clearRedo();
    undoStack.push(entry);
    undoBytes += entry.bytes;
    enforceBudgets();
    notify();
  };

  const amendLast = (entry: HistoryEntry): void => {
    if (applying) {
      disposeEntry(entry);
      return;
    }
    if (undoStack.length === 0) {
      push(entry);
      return;
    }
    clearRedo();
    const replaced = undoStack.pop();
    if (replaced) {
      undoBytes -= replaced.bytes;
      disposeEntry(replaced);
    }
    undoStack.push(entry);
    undoBytes += entry.bytes;
    enforceBudgets();
    notify();
  };

  const undo = (): void => {
    if (applying || undoStack.length === 0) {
      return;
    }
    const entry = undoStack.at(-1);
    if (!entry) {
      return;
    }
    if (!entry.replayFailureAtomic) {
      // Legacy replay may mutate before observer failure: move first to prevent duplicate retries. A replay-time
      // clear owns reset and notification.
      undoStack.pop();
      undoBytes -= entry.bytes;
      redoStack.push(entry);
      redoBytes += entry.bytes;
      let replayError: unknown;
      let didThrow = false;
      applying = true;
      try {
        entry.undo();
      } catch (error) {
        replayError = error;
        didThrow = true;
      } finally {
        applying = false;
      }
      if (redoStack.at(-1) === entry) {
        notify();
      }
      if (didThrow) {
        // Preserve the callback's exact exception value for legacy callers.
        // eslint-disable-next-line no-throw-literal
        throw replayError;
      }
      return;
    }
    applying = true;
    try {
      entry.undo();
    } finally {
      applying = false;
    }
    // A replay callback may intentionally clear history (for example a
    // synchronous document replacement). Let that reset win; never resurrect
    // the entry onto the opposite stack after its original stack changed.
    if (undoStack.at(-1) !== entry) {
      return;
    }
    // Fallible replay moves entries only after success, preserving stacks and byte totals for an exact retry.
    undoStack.pop();
    undoBytes -= entry.bytes;
    redoStack.push(entry);
    redoBytes += entry.bytes;
    notify();
  };

  const redo = (): void => {
    if (applying || redoStack.length === 0) {
      return;
    }
    const entry = redoStack.at(-1);
    if (!entry) {
      return;
    }
    if (!entry.replayFailureAtomic) {
      redoStack.pop();
      redoBytes -= entry.bytes;
      undoStack.push(entry);
      undoBytes += entry.bytes;
      let replayError: unknown;
      let didThrow = false;
      applying = true;
      try {
        entry.redo();
      } catch (error) {
        replayError = error;
        didThrow = true;
      } finally {
        applying = false;
      }
      if (undoStack.at(-1) === entry) {
        notify();
      }
      if (didThrow) {
        // Preserve the callback's exact exception value for legacy callers.
        // eslint-disable-next-line no-throw-literal
        throw replayError;
      }
      return;
    }
    applying = true;
    try {
      entry.redo();
    } finally {
      applying = false;
    }
    if (redoStack.at(-1) !== entry) {
      return;
    }
    redoStack.pop();
    redoBytes -= entry.bytes;
    undoStack.push(entry);
    undoBytes += entry.bytes;
    notify();
  };

  const clear = (): void => {
    if (undoStack.length === 0 && redoStack.length === 0) {
      return;
    }
    const discarded = [...undoStack, ...redoStack];
    undoStack.length = 0;
    redoStack.length = 0;
    discarded.forEach(disposeEntry);
    undoBytes = 0;
    redoBytes = 0;
    notify();
  };

  const trimToBytes = (budgetBytes: number): void => {
    const budget = Math.max(0, budgetBytes);
    let changed = false;
    while (undoBytes + redoBytes > budget && undoStack.length > 0) {
      const evicted = undoStack.shift();
      if (evicted) {
        undoBytes -= evicted.bytes;
        disposeEntry(evicted);
        changed = true;
      }
    }
    while (undoBytes + redoBytes > budget && redoStack.length > 0) {
      const evicted = redoStack.shift();
      if (evicted) {
        redoBytes -= evicted.bytes;
        disposeEntry(evicted);
        changed = true;
      }
    }
    if (changed) {
      notify();
    }
  };

  return {
    amendLast,
    byteSize: () => undoBytes + redoBytes,
    entries,
    heldAssetRefs,
    canRetain: (bytes) => Number.isFinite(bytes) && Math.max(0, Math.ceil(bytes)) <= byteBudget,
    canRedo: () => redoStack.length > 0,
    canUndo: () => undoStack.length > 0,
    clear,
    isApplying: () => applying,
    push,
    redo,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    trimToBytes,
    undo,
  };
};
