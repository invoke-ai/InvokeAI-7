import { describe, expect, it, vi } from 'vitest';

import { createDeferredCommit } from './deferredCommit';
import { createDeferredResource } from './deferredResource';

const deferred = <T>() => {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolveWith) => {
    settle = resolveWith;
  });

  return { promise, settle };
};

describe('deferred commit', () => {
  it('holds the intent until the resource resolves', async () => {
    const module = deferred<string>();
    const resource = createDeferredResource(() => module.promise);
    const apply = vi.fn();
    const commit = createDeferredCommit<string>(() => resource, apply);

    commit.request('appearance');

    expect(apply).not.toHaveBeenCalled();
    expect(commit.isPending()).toBe(true);

    module.settle('loaded');
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith('appearance'));
    expect(commit.isPending()).toBe(false);
  });

  // Waiting a tick for a value that is already in hand is exactly what the
  // fallback throttle costs elsewhere; a repeat interaction has to stay
  // synchronous or this indirection makes things worse, not better.
  it('applies synchronously once the resource is loaded', async () => {
    const resource = createDeferredResource(() => Promise.resolve('loaded'));
    const apply = vi.fn();
    const commit = createDeferredCommit<void>(() => resource, apply);

    await resource.load();
    commit.request();

    expect(apply).toHaveBeenCalledOnce();
  });

  it('applies synchronously when there is no resource to wait for', () => {
    const apply = vi.fn();
    const commit = createDeferredCommit<void>(() => null, apply);

    commit.request();

    expect(apply).toHaveBeenCalledOnce();
  });

  // A module that will not load must not swallow the interaction: opening
  // anyway lets the caller's boundary report the failure, where doing nothing
  // reads as a dead control.
  it('applies synchronously after the resource has failed', async () => {
    const resource = createDeferredResource(() => Promise.reject(new Error('offline')));
    const apply = vi.fn();
    const commit = createDeferredCommit<void>(() => resource, apply);

    await expect(resource.load()).rejects.toThrow('offline');
    commit.request();

    expect(apply).toHaveBeenCalledOnce();
  });

  it('drops an intent that was cancelled while its resource was loading', async () => {
    const module = deferred<string>();
    const resource = createDeferredResource(() => module.promise);
    const apply = vi.fn();
    const commit = createDeferredCommit<void>(() => resource, apply);

    commit.request();
    commit.cancel();
    expect(commit.isPending()).toBe(false);

    module.settle('loaded');
    await resource.load();
    await Promise.resolve();

    expect(apply).not.toHaveBeenCalled();
  });

  it('applies only the latest intent when several are requested in flight', async () => {
    const module = deferred<string>();
    const resource = createDeferredResource(() => module.promise);
    const apply = vi.fn();
    const commit = createDeferredCommit<string>(() => resource, apply);

    commit.request('appearance');
    commit.request('hotkeys');

    module.settle('loaded');
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    expect(apply).toHaveBeenCalledWith('hotkeys');
  });
});
