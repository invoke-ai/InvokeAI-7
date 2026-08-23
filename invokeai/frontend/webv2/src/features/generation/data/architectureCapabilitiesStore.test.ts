import fixture from '@features/generation/core/__fixtures__/architectureCapabilities.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getArchitectureCapabilities: vi.fn() }));

vi.mock('./architectureCapabilitiesApi', () => api);

const rows = fixture as unknown[];

describe('architecture capabilities store', () => {
  beforeEach(() => {
    vi.resetModules();
    api.getArchitectureCapabilities.mockReset();
  });

  it('fills the core registry rather than the snapshot', async () => {
    // The rows have exactly one home: policy accessors read them synchronously from all over the
    // app, including graph builders at enqueue time.
    api.getArchitectureCapabilities.mockResolvedValue(rows);
    const store = await import('./architectureCapabilitiesStore');
    const registry = await import('@features/generation/core/architectureCapabilities');

    expect(registry.hasArchitectureCapabilities()).toBe(false);
    await store.refreshArchitectureCapabilities();

    expect(store.getArchitectureCapabilitiesSnapshot()).toEqual({ error: null, status: 'loaded' });
    expect(registry.getArchitectureGenerationConfig('sd-1')?.defaults.steps).toBe(30);
  });

  it('dedupes concurrent refreshes', async () => {
    api.getArchitectureCapabilities.mockResolvedValue(rows);
    const store = await import('./architectureCapabilitiesStore');

    const first = store.refreshArchitectureCapabilities();
    expect(store.refreshArchitectureCapabilities()).toBe(first);
    await first;

    expect(store.getArchitectureCapabilitiesSnapshot().status).toBe('loaded');
  });

  it('reports a failure and leaves the registry empty', async () => {
    api.getArchitectureCapabilities.mockRejectedValue(new Error('outage'));
    const store = await import('./architectureCapabilitiesStore');
    const registry = await import('@features/generation/core/architectureCapabilities');

    await store.refreshArchitectureCapabilities();

    expect(store.getArchitectureCapabilitiesSnapshot()).toEqual({ error: 'outage', status: 'error' });
    expect(registry.hasArchitectureCapabilities()).toBe(false);
  });

  it('retries after an error but not after success', async () => {
    api.getArchitectureCapabilities.mockRejectedValueOnce(new Error('outage')).mockResolvedValue(rows);
    const store = await import('./architectureCapabilitiesStore');

    store.ensureArchitectureCapabilitiesLoaded();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getArchitectureCapabilitiesSnapshot().status).toBe('error');

    // One failed load must not stick...
    await store.refreshArchitectureCapabilities();
    expect(store.getArchitectureCapabilitiesSnapshot().status).toBe('loaded');

    // ...and a loaded table is never refetched: it is static per backend build.
    store.ensureArchitectureCapabilitiesLoaded();
    expect(api.getArchitectureCapabilities).toHaveBeenCalledTimes(2);
  });

  it('clears the registry as well as the snapshot when the account changes', async () => {
    // The addition to the starters-store template: the rows live outside this store, so clearing
    // only the snapshot would leave the previous account's table readable behind an idle status.
    api.getArchitectureCapabilities.mockResolvedValue(rows);
    const lifecycle = await import('@platform/state/accountLifecycle');
    const store = await import('./architectureCapabilitiesStore');
    const registry = await import('@features/generation/core/architectureCapabilities');

    await store.refreshArchitectureCapabilities();
    expect(registry.hasArchitectureCapabilities()).toBe(true);

    lifecycle.accountLifecycle.invalidate();

    expect(store.getArchitectureCapabilitiesSnapshot()).toEqual({ error: null, status: 'idle' });
    expect(registry.hasArchitectureCapabilities()).toBe(false);
  });
});
