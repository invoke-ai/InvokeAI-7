import { describe, expect, it, vi } from 'vitest';

import { createDeferredResource } from './deferredResource';

describe('deferred resource', () => {
  it('loads once and shares the promise and value', async () => {
    const loader = vi.fn(() => Promise.resolve('value'));
    const resource = createDeferredResource(loader);

    const first = resource.load();
    const second = resource.load();

    expect(first).toBe(second);
    await expect(first).resolves.toBe('value');
    expect(resource.load()).toBe(first);
    expect(loader).toHaveBeenCalledOnce();
    expect(resource.getStatus()).toBe('loaded');
  });

  it('caches a rejected load and starts exactly one new attempt on retry', async () => {
    const failure = new Error('chunk unavailable');
    const loader = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce('value');
    const resource = createDeferredResource(loader);

    const failed = resource.load();
    await expect(failed).rejects.toBe(failure);
    expect(resource.load()).toBe(failed);
    expect(resource.getStatus()).toBe('failed');

    const retry = resource.retry();
    expect(resource.retry()).toBe(retry);
    await expect(retry).resolves.toBe('value');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('routes a validation failure through the same failure state', async () => {
    const resource = createDeferredResource(
      () => Promise.resolve('value'),
      () => {
        throw new TypeError('wrong shape');
      }
    );

    await expect(resource.load()).rejects.toThrow('wrong shape');
    expect(resource.getStatus()).toBe('failed');
  });

  it('preloads without leaking a rejected promise', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('offline'));
    const resource = createDeferredResource(loader);

    resource.preload();
    await vi.waitFor(() => expect(resource.getStatus()).toBe('failed'));
    expect(loader).toHaveBeenCalledOnce();
  });

  // React's `use()` reads these fields off the thenable before deciding whether
  // to suspend. Without them a settled promise still costs a suspension on first
  // read — `use()` cannot inspect a native promise synchronously, so it attaches
  // a callback and throws. That suspension shows a fallback, and once a fallback
  // is on screen React withholds the resolved tree for FALLBACK_THROTTLE_MS
  // (300ms) to avoid a flash. That throttle was the entire measured cost of
  // switching layout and of opening a dialog, long after the chunk had finished
  // downloading, so these three fields are load-bearing rather than decorative.
  describe('exposes its settled state on the promise for React `use()`', () => {
    it('marks the promise pending, then fulfilled with the value', async () => {
      const resource = createDeferredResource(() => Promise.resolve('value'));

      const pending = resource.load() as Promise<string> & { status?: string; value?: string };
      expect(pending.status).toBe('pending');

      await pending;

      expect(pending.status).toBe('fulfilled');
      expect(pending.value).toBe('value');
    });

    it('marks the promise rejected with the reason', async () => {
      const error = new Error('offline');
      const resource = createDeferredResource(() => Promise.reject(error));

      const pending = resource.load() as Promise<never> & { reason?: unknown; status?: string };
      await expect(pending).rejects.toThrow('offline');

      expect(pending.status).toBe('rejected');
      expect(pending.reason).toBe(error);
    });

    it('keeps the settled state on the promise handed to later callers', async () => {
      const resource = createDeferredResource(() => Promise.resolve('value'));

      await resource.load();
      const again = resource.load() as Promise<string> & { status?: string; value?: string };

      expect(again.status).toBe('fulfilled');
      expect(again.value).toBe('value');
    });
  });
});
