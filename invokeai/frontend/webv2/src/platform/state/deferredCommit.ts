import type { DeferredResource } from './deferredResource';

export interface DeferredCommit<TIntent = void> {
  /** Drops an intent that has not landed yet, so a later decision wins. */
  cancel: () => void;
  /** True while an intent is waiting on its resource. */
  isPending: () => boolean;
  /** Applies the intent once the resource is in hand, unless it was superseded. */
  request: (intent: TIntent) => void;
}

/**
 * Defers a state change until the module it will reveal is loaded.
 *
 * Committing first and loading second is what makes a lazily rendered surface
 * expensive: the new tree renders against a pending promise, suspends, and
 * commits a fallback — after which React withholds the resolved content for
 * `FALLBACK_THROTTLE_MS` (300ms) to avoid a flash. That throttle, not the
 * download, was the measured cost of switching layout and of opening a dialog.
 * Waiting here keeps the current screen up for the few milliseconds the module
 * actually needs and lets the change commit in one frame.
 *
 * An intent that is already superseded is dropped rather than applied late:
 * pressing Escape, or toggling twice, while a chunk is in flight must not be
 * undone by the load finishing afterwards.
 */
export const createDeferredCommit = <TIntent = void>(
  getResource: () => DeferredResource<unknown> | null,
  apply: (intent: TIntent) => void
): DeferredCommit<TIntent> => {
  let pendingId: number | null = null;
  let lastId = 0;

  return {
    cancel: () => {
      pendingId = null;
    },
    isPending: () => pendingId !== null,
    request: (intent) => {
      const resource = getResource();
      const status = resource?.getStatus();

      // Nothing left to wait for. Staying synchronous here matters: a repeat
      // open must not become a frame slower than it was before this indirection
      // existed, and a module that failed to load should reach its boundary
      // rather than silently swallow the interaction.
      if (!resource || status === 'loaded' || status === 'failed') {
        apply(intent);
        return;
      }

      lastId += 1;
      const id = lastId;
      pendingId = id;
      const commit = () => {
        if (pendingId !== id) {
          return;
        }
        pendingId = null;
        apply(intent);
      };

      void resource.load().then(commit, commit);
    },
  };
};
