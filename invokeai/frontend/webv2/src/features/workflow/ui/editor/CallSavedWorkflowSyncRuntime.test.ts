import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferredCallSavedWorkflowReconciler } from './CallSavedWorkflowSyncRuntime';

describe('createDeferredCallSavedWorkflowReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers and coalesces synchronous notifications', () => {
    const reconcile = vi.fn();
    const scheduler = createDeferredCallSavedWorkflowReconciler(reconcile);

    scheduler.schedule();
    scheduler.schedule();

    expect(reconcile).not.toHaveBeenCalled();

    vi.runAllTimers();

    expect(reconcile).toHaveBeenCalledOnce();
  });

  it('cancels pending reconciliation on disposal', () => {
    const reconcile = vi.fn();
    const scheduler = createDeferredCallSavedWorkflowReconciler(reconcile);

    scheduler.schedule();
    scheduler.dispose();
    vi.runAllTimers();

    expect(reconcile).not.toHaveBeenCalled();
  });
});
