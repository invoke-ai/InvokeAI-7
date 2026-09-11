import {
  getArchitectureCapabilitiesRevision,
  onArchitectureCapabilitiesChanged,
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
  /**
   * Identity of the table in the core registry; `0` while there is none.
   *
   * This is the whole subscription contract for the many readers that call the synchronous policy
   * accessors during render or at enqueue time: subscribe to this, and re-read when it changes.
   * `status` cannot serve that purpose -- it describes this store's request, not the registry, and
   * a reader gated on it would miss a table seeded by anything but a fetch.
   */
  revision: number;
}

const EMPTY_SNAPSHOT: ArchitectureCapabilitiesSnapshot = { error: null, revision: 0, status: 'idle' };
const store = createExternalStore<ArchitectureCapabilitiesSnapshot>(EMPTY_SNAPSHOT);

// The registry is the authority; this store publishes it. Mirroring here rather than alongside each
// write means every path that fills or drops the table reaches subscribers, including tests that
// seed it directly.
onArchitectureCapabilitiesChanged(() => store.patchSnapshot({ revision: getArchitectureCapabilitiesRevision() }));

const refreshFlight = createTrailingSingleFlight();

/** Whether anything in this session has asked for the table; see the account-change re-arm below. */
let isRequested = false;

registerAccountOwnedResource({
  clear: () => {
    refreshFlight.reset();
    // The registry is module state outside this store, so clearing the snapshot alone would leave
    // the previous account's table readable behind a status that says nothing is loaded. Dropped
    // before the snapshot, so no subscriber is ever woken to read the old table at revision 0.
    resetArchitectureCapabilities();
    store.setSnapshot(EMPTY_SNAPSHOT);

    // `activate` rotates the scope *before* clearing, so the incoming account is already current
    // here. Re-arm rather than wait to be asked again: the app kicks the fetch once, at boot, from
    // a mount effect that does not re-run, and the long-lived subscribers below never re-subscribe.
    // A boot-time load that raced sign-in was aborted by that rotation; this is what replaces it.
    if (isRequested && captureAccountScope().accountId !== null) {
      void refreshArchitectureCapabilities();
    }
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
  isRequested = true;

  const { status } = store.getSnapshot();

  if (status === 'idle' || status === 'error') {
    void refreshArchitectureCapabilities();
  }
};

export const getArchitectureCapabilitiesSnapshot = (): ArchitectureCapabilitiesSnapshot => store.getSnapshot();

export const subscribeArchitectureCapabilities = store.subscribe;

export const useArchitectureCapabilitiesSelector = store.useSelector;
