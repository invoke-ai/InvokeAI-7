import { afterEach, describe, expect, it, vi } from 'vitest';

import { scheduleIdleTask } from './idle';

const originalRequestIdleCallback = globalThis.requestIdleCallback;
const originalCancelIdleCallback = globalThis.cancelIdleCallback;

afterEach(() => {
  globalThis.requestIdleCallback = originalRequestIdleCallback;
  globalThis.cancelIdleCallback = originalCancelIdleCallback;
  vi.useRealTimers();
});

describe('scheduleIdleTask', () => {
  it('runs the task through requestIdleCallback and cancels through its handle', () => {
    const request = vi.fn().mockReturnValue(7);
    const cancel = vi.fn();
    globalThis.requestIdleCallback = request as unknown as typeof requestIdleCallback;
    globalThis.cancelIdleCallback = cancel as unknown as typeof cancelIdleCallback;
    const task = vi.fn();

    const dispose = scheduleIdleTask(task);
    request.mock.calls[0]?.[0]();
    expect(task).toHaveBeenCalledOnce();

    dispose();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it('falls back to a macrotask where requestIdleCallback is missing', () => {
    vi.useFakeTimers();
    // @ts-expect-error -- the fallback exists precisely for engines without it.
    delete globalThis.requestIdleCallback;
    const task = vi.fn();

    scheduleIdleTask(task);
    vi.runAllTimers();

    expect(task).toHaveBeenCalledOnce();
  });

  it('cancels the fallback before it runs', () => {
    vi.useFakeTimers();
    // @ts-expect-error -- the fallback exists precisely for engines without it.
    delete globalThis.requestIdleCallback;
    const task = vi.fn();

    scheduleIdleTask(task)();
    vi.runAllTimers();

    expect(task).not.toHaveBeenCalled();
  });
});
