import {
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';
import { apiFetchJson, getApiErrorMessage } from '@platform/transport/http';

/**
 * System information for the settings About section: the server's version and
 * its installed dependency versions (with the synthesized `CUDA` entry), plus
 * — for admins — the redacted runtime config, mirroring the legacy About
 * modal's blob. Pull-based: nothing here changes without a server restart.
 */

export interface AboutInfoSnapshot {
  /** The server's app version, or null while unknown. */
  version: string | null;
  /** Installed distributions by name, sorted by the backend. Empty until loaded. */
  dependencies: Record<string, string>;
  /** Admin-only redacted runtime config; null for non-admins. */
  runtimeConfig: Record<string, unknown> | null;
  loadState: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
}

const EMPTY_SNAPSHOT: AboutInfoSnapshot = {
  dependencies: {},
  error: null,
  loadState: 'idle',
  runtimeConfig: null,
  version: null,
};

const store = createExternalStore<AboutInfoSnapshot>(EMPTY_SNAPSHOT);

let inflight: Promise<void> | null = null;

registerAccountOwnedResource({
  clear: () => {
    inflight = null;
    store.setSnapshot(EMPTY_SNAPSHOT);
  },
  name: 'about-info',
});

interface RuntimeConfigResponse {
  config?: Record<string, unknown> | null;
}

export const refreshAboutInfo = (includeRuntimeConfig: boolean): Promise<void> => {
  if (inflight) {
    return inflight;
  }

  const owner = captureAccountScope();

  if (store.getSnapshot().loadState === 'idle') {
    store.patchSnapshot({ loadState: 'loading' });
  }

  const refresh = Promise.all([
    apiFetchJson<{ version: string }>('/api/v1/app/version', { signal: owner.signal }),
    apiFetchJson<Record<string, string>>('/api/v1/app/app_deps', { signal: owner.signal }),
    // Admin-only; a non-admin shows the blob without it rather than an error.
    includeRuntimeConfig
      ? apiFetchJson<RuntimeConfigResponse>('/api/v1/app/runtime_config', { signal: owner.signal }).catch(() => null)
      : Promise.resolve(null),
  ])
    .then(([version, dependencies, runtimeConfig]) => {
      if (!isAccountScopeCurrent(owner)) {
        return;
      }

      store.patchSnapshot({
        dependencies,
        error: null,
        loadState: 'loaded',
        runtimeConfig: runtimeConfig?.config ?? null,
        version: version.version,
      });
    })
    .catch((error: unknown) => {
      if (!isAccountScopeCurrent(owner)) {
        return;
      }

      store.patchSnapshot({
        error: getApiErrorMessage(error, 'Failed to load system information'),
        loadState: 'error',
      });
    })
    .finally(() => {
      if (inflight === refresh) {
        inflight = null;
      }
    });

  inflight = refresh;

  return inflight;
};

export const useAboutInfo = (): AboutInfoSnapshot => store.useSnapshot();
