/**
 * Makes a {@link SelectionState} undoable: every selection-changing call is
 * bracketed by snapshots and recorded on the engine history as one step, so a
 * marquee, lasso, select-all, invert, deselect, or Select Object result reverts
 * on its own instead of taking the previous pixel edit with it.
 *
 * Replay restores snapshots directly and never re-enters this wrapper's
 * recording path; a call that leaves the selection unchanged records nothing.
 *
 * Zero React, zero import-time side effects.
 */

import type { History } from '@workbench/canvas-engine/history/history';
import type { Rect, SelectionOp } from '@workbench/canvas-engine/types';

import { isEmpty } from '@workbench/canvas-engine/math/rect';

import type { SelectionCommit, SelectionSnapshot, SelectionState } from './selectionState';

const COMMIT_LABELS: Record<SelectionOp, string> = {
  add: 'Add to selection',
  intersect: 'Intersect selection',
  replace: 'Select',
  subtract: 'Subtract from selection',
};

const sameRect = (left: Rect | null, right: Rect | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height);

const sameAlpha = (left: Uint8ClampedArray | null, right: Uint8ClampedArray | null): boolean => {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

const sameSnapshot = (left: SelectionSnapshot, right: SelectionSnapshot): boolean =>
  left.selected === right.selected &&
  left.commits.length === right.commits.length &&
  sameRect(left.rect, right.rect) &&
  sameRect(left.bounds, right.bounds) &&
  sameAlpha(left.alpha, right.alpha);

/** A degenerate replace (a lasso too small to close) deselects rather than selects. */
const commitLabel = (commit: SelectionCommit): string =>
  commit.op === 'replace' && isEmpty(commit.bounds) ? 'Deselect' : COMMIT_LABELS[commit.op];

/** Wraps `selection` so its mutations record on `history`; reads and replay pass through untouched. */
export const withSelectionHistory = (selection: SelectionState, history: History): SelectionState => {
  // Consecutive steps share their boundary capture; charge a plane once.
  let lastAfter: SelectionSnapshot | null = null;
  const record = (label: string, mutate: () => void): void => {
    if (history.isApplying()) {
      mutate();
      return;
    }
    const before = selection.snapshot();
    mutate();
    const after = selection.snapshot();
    if (sameSnapshot(before, after)) {
      return;
    }
    const beforeBytes = before === lastAfter ? 0 : (before.alpha?.byteLength ?? 0);
    lastAfter = after;
    history.push({
      bytes: beforeBytes + (after.alpha?.byteLength ?? 0),
      label,
      redo: () => selection.restore(after),
      undo: () => selection.restore(before),
    });
  };

  return {
    ...selection,
    clear: () => record('Deselect', () => selection.clear()),
    commit: (commit) => record(commitLabel(commit), () => selection.commit(commit)),
    invert: (domain) => record('Invert selection', () => selection.invert(domain)),
    replaceMask: (mask) => record('Select object', () => selection.replaceMask(mask)),
    selectAll: (domain) => record('Select all', () => selection.selectAll(domain)),
  };
};
