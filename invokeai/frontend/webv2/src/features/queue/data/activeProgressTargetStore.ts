import type { QueueItemProgressTarget } from '@features/queue/core/types';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/**
 * The slots currently reporting progress, plus the ones settling.
 *
 * A list rather than a single value because of multi-GPU: with `generation_devices`
 * (default `auto`) the backend runs one session per GPU, so a batch of four across
 * two GPUs has two slots live at once. Holding only the most recent target meant
 * concurrent sessions overwrote each other on every progress frame, and the preview
 * flipped between them several times a second.
 *
 * Order is the order sessions started, which keeps the single-target accessor below
 * stable for as long as that session runs.
 *
 * A *settling* slot is one whose backend item has completed but whose result has
 * not landed in the gallery yet — two HTTP round trips away. Single-slot surfaces
 * keep following it so the last denoise frame stays up until the finished image
 * can take over; multi-slot surfaces (the tile grid) stop counting it, or a
 * single-GPU batch would flash into a two-tile grid at every item boundary.
 */
export interface ActiveProgressTargetSink {
  clear(target?: QueueItemProgressTarget): void;
  set(target: QueueItemProgressTarget): void;
  settle(target: QueueItemProgressTarget): void;
}

interface ActiveProgressTargetsSnapshot {
  settlingTargets: QueueItemProgressTarget[];
  targets: QueueItemProgressTarget[];
}

const store = createExternalStore<ActiveProgressTargetsSnapshot>({ settlingTargets: [], targets: [] });

const isSameTarget = (left: QueueItemProgressTarget, right: QueueItemProgressTarget): boolean =>
  left.queueItemId === right.queueItemId && left.itemIndex === right.itemIndex;

const includes = (targets: QueueItemProgressTarget[], target: QueueItemProgressTarget): boolean =>
  targets.some((candidate) => isSameTarget(candidate, target));

const without = (targets: QueueItemProgressTarget[], target: QueueItemProgressTarget): QueueItemProgressTarget[] =>
  targets.filter((candidate) => !isSameTarget(candidate, target));

export const activeProgressTargetStore: ActiveProgressTargetSink = {
  clear(target) {
    const { settlingTargets, targets } = store.getSnapshot();

    if (!target) {
      if (targets.length > 0 || settlingTargets.length > 0) {
        store.patchSnapshot({ settlingTargets: [], targets: [] });
      }

      return;
    }

    const remaining = without(targets, target);
    const remainingSettling = without(settlingTargets, target);

    store.patchSnapshot({
      ...(remaining.length !== targets.length ? { targets: remaining } : {}),
      ...(remainingSettling.length !== settlingTargets.length ? { settlingTargets: remainingSettling } : {}),
    });
  },
  set(target) {
    const { settlingTargets, targets } = store.getSnapshot();

    // Progress frames arrive many times a second per session; re-appending an
    // already-tracked target would publish a fresh array identity every frame and
    // re-render every consumer.
    if (includes(targets, target)) {
      return;
    }

    store.patchSnapshot({
      targets: [...targets, target],
      // A settled slot reporting progress again is running again.
      ...(includes(settlingTargets, target) ? { settlingTargets: without(settlingTargets, target) } : {}),
    });
  },
  settle(target) {
    const { settlingTargets, targets } = store.getSnapshot();

    // A slot that never reported progress was never followed; nothing to keep up.
    if (!includes(targets, target)) {
      return;
    }

    store.patchSnapshot({
      settlingTargets: includes(settlingTargets, target) ? settlingTargets : [...settlingTargets, target],
      targets: without(targets, target),
    });
  },
};

registerAccountOwnedResource({
  clear: () => activeProgressTargetStore.clear(),
  name: 'queue-active-progress-target',
});

/**
 * Running slots first: a settling slot is only worth following while nothing is
 * running, or a concurrent session's live stream would sit unseen behind a
 * static frame for the whole routing window.
 */
const selectFollowedTargets = ({
  settlingTargets,
  targets,
}: ActiveProgressTargetsSnapshot): QueueItemProgressTarget[] =>
  settlingTargets.length === 0 ? targets : [...targets, ...settlingTargets];

/**
 * The slot to follow where a surface can only show one.
 *
 * The oldest still-running slot rather than the most recent to report: following the
 * most recent is what made the preview flip between concurrent sessions. Behaviour is
 * identical to the previous single-value store whenever one session runs at a time,
 * which is every single-GPU install — except that a completed slot stays followed
 * until its result lands.
 */
export const useActiveProgressTarget = (): QueueItemProgressTarget | null =>
  store.useSelector((snapshot) => selectFollowedTargets(snapshot)[0] ?? null);

/** Every slot currently running, in the order its session started. */
export const useActiveProgressTargets = (): QueueItemProgressTarget[] =>
  store.useSelector((snapshot) => snapshot.targets);

/** Every followable slot — running ones first, then settling ones. */
export const useFollowedProgressTargets = (): QueueItemProgressTarget[] => store.useSelector(selectFollowedTargets);

export const getActiveProgressTargets = (): QueueItemProgressTarget[] => store.getSnapshot().targets;

export const getFollowedProgressTargets = (): QueueItemProgressTarget[] => selectFollowedTargets(store.getSnapshot());
