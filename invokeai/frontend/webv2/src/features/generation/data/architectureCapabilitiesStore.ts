import {
  resetArchitectureCapabilities,
  setArchitectureCapabilities,
} from '@features/generation/core/architectureCapabilities';
import {
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';
import { createTrailingSingleFlight } from '@platform/state/singleFlight';
import { getApiErrorMessage } from '@platform/transport/http';

import { getArchitectureCapabilities } from './architectureCapabilitiesApi';

/**
 * Load state for the architecture capability table.
 *
 * The rows themselves live in the core registry, not in this snapshot: generation policy is read
 * from synchronous accessors all over the app, including from graph builders at enqueue time, so
 * there must be exactly one place holding the table. This store owns only *whether* it is there.
 *
 * Fetched once. The table is static per backend build -- it is derived from
 * `invokeai/backend/architectures/defs/`, not from installed models -- so nothing revalidates it.
 */

export interface ArchitectureCapabilitiesSnapshot {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
}

const EMPTY_SNAPSHOT: ArchitectureCapabilitiesSnapshot = { error: null, status: 'idle' };
const store = createExternalStore<ArchitectureCapabilitiesSnapshot>(EMPTY_SNAPSHOT);

const refreshFlight = createTrailingSingleFlight();

registerAccountOwnedResource({
  clear: () => {
    refreshFlight.reset();
    store.setSnapshot(EMPTY_SNAPSHOT);
    // The registry is module state outside this store, so clearing the snapshot alone would leave
    // the previous account's table readable behind a status that says nothing is loaded.
    resetArchitectureCapabilities();
  },
  name: 'architecture-capabilities',
});

export const refreshArchitectureCapabilities = (): Promise<void> =>
  refreshFlight.run(() => {
    const owner = captureAccountScope();
    store.patchSnapshot({ status: store.getSnapshot().status === 'loaded' ? 'loaded' : 'loading' });

    return getArchitectureCapabilities(owner.signal)
      .then((rows) => {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        setArchitectureCapabilities(rows);
        store.patchSnapshot({ error: null, status: 'loaded' });
      })
      .catch((error: unknown) => {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        store.patchSnapshot({
          error: getApiErrorMessage(error, 'Failed to load model capabilities.'),
          status: store.getSnapshot().status === 'loaded' ? 'loaded' : 'error',
        });
      });
  });

/** Fetch on first use or retry after an error, so one failed load never sticks. */
export const ensureArchitectureCapabilitiesLoaded = (): void => {
  const { status } = store.getSnapshot();

  if (status === 'idle' || status === 'error') {
    void refreshArchitectureCapabilities();
  }
};

export const getArchitectureCapabilitiesSnapshot = (): ArchitectureCapabilitiesSnapshot => store.getSnapshot();

export const subscribeArchitectureCapabilities = store.subscribe;

export const useArchitectureCapabilitiesSelector = store.useSelector;
