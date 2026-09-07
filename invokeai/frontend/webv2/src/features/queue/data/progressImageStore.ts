import type { QueueProgressImage } from '@features/queue/core/progressImage';
import type { QueueItemProgressTarget } from '@features/queue/core/types';

import { registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore, createKeyedTransientStore } from '@platform/state/externalStore';

/**
 * The most recent denoising preview image from `invocation_progress` events,
 * as a b64 data URL. Cleared when the run settles so consumers (the editor's
 * Current Image node, progress surfaces) fall back to the last real output.
 *
 * Next to the live frames, two small bounded sets of frames are *held* per
 * local queue item when one of its backend items completes:
 *
 * - the bridge frame, shown while the batch's next slot is live but has not
 *   produced a frame of its own yet (model load, text encoding) — a sequential
 *   batch used to drop to an empty card between items;
 * - the swap frame, shown in place of the finished image until the browser has
 *   decoded it, so the denoise→done boundary changes only the pixels inside
 *   the frame. Consumed on that first decode and expired shortly after, so
 *   browsing back to the image later never replays the low-resolution frame.
 *
 * Everything here survives a socket drop on purpose: the run continues on the
 * backend and its durable outcome is reconciled over HTTP, so wiping the last
 * frame on disconnect only ever produced a blank card until the next event.
 */

export type ProgressImageSnapshot = QueueProgressImage;

export type ProgressImageTarget = QueueItemProgressTarget;

export type LatestProgressImageSnapshot = ProgressImageSnapshot & { target?: ProgressImageTarget };

/** Held frames are latent-grid JPEG data URLs, a few KB each. */
const HELD_FRAME_LIMIT = 8;

/**
 * Long enough to cover the finished image's fetch and decode on a slow link,
 * short enough that a later deliberate visit to the image never hits it.
 */
export const SWAP_FRAME_TTL_MS = 10_000;

const latestSnapshotStore = createExternalStore<{ latestSnapshot: LatestProgressImageSnapshot | null }>({
  latestSnapshot: null,
});
/**
 * A swap frame is bound to the image names its backend item delivered once
 * routing lands (`bindSwapImages`); until then, and for any other image of the
 * same batch, it must not be painted — item 3's denoise frame over item 1.
 */
interface SwapFrame {
  image: ProgressImageSnapshot;
  imageNames: readonly string[] | null;
}

const snapshotsByTarget = createKeyedTransientStore<string, ProgressImageSnapshot>();
/** Insertion order is recency: `set` re-inserts, so the last entry is the most recently updated slot. */
const targetsByKey = new Map<string, ProgressImageTarget>();
const bridgeFrames = createKeyedTransientStore<string, ProgressImageSnapshot>();
const swapFrames = createKeyedTransientStore<string, SwapFrame>();
const swapExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const getTargetKey = ({ itemIndex, queueItemId }: ProgressImageTarget): string => `${queueItemId}:${itemIndex}`;

const isLatestTarget = (target: ProgressImageTarget): boolean =>
  latestSnapshotStore.getSnapshot().latestSnapshot?.target?.queueItemId === target.queueItemId &&
  latestSnapshotStore.getSnapshot().latestSnapshot?.target?.itemIndex === target.itemIndex;

/** Drop the oldest held entries past the cap. Insertion order is age: `hold` re-inserts. */
const evictOldest = <Value>(
  store: { entries: () => Array<[string, Value]> },
  drop: (queueItemId: string) => void
): void => {
  const entries = store.entries();

  for (let index = 0; index < entries.length - HELD_FRAME_LIMIT; index += 1) {
    const entry = entries[index];

    if (entry) {
      drop(entry[0]);
    }
  }
};

const dropBridge = (queueItemId: string): void => {
  bridgeFrames.delete(queueItemId);
};

const dropSwap = (queueItemId: string): void => {
  const timer = swapExpiryTimers.get(queueItemId);

  if (timer !== undefined) {
    clearTimeout(timer);
    swapExpiryTimers.delete(queueItemId);
  }

  swapFrames.delete(queueItemId);
};

const holdBridge = (queueItemId: string, image: ProgressImageSnapshot): void => {
  dropBridge(queueItemId);
  bridgeFrames.set(queueItemId, image);
  evictOldest(bridgeFrames, dropBridge);
};

const holdSwap = (queueItemId: string, image: ProgressImageSnapshot): void => {
  dropSwap(queueItemId);
  swapFrames.set(queueItemId, { image, imageNames: null });
  swapExpiryTimers.set(
    queueItemId,
    setTimeout(() => dropSwap(queueItemId), SWAP_FRAME_TTL_MS)
  );
  evictOldest(swapFrames, dropSwap);
};

export const progressImageStore = {
  clear(target?: ProgressImageTarget): void {
    if (!target) {
      latestSnapshotStore.patchSnapshot({ latestSnapshot: null });
      snapshotsByTarget.clear();
      targetsByKey.clear();
      bridgeFrames.clear();

      for (const timer of swapExpiryTimers.values()) {
        clearTimeout(timer);
      }

      swapExpiryTimers.clear();
      swapFrames.clear();

      return;
    }

    const targetKey = getTargetKey(target);
    const didClearLatest = isLatestTarget(target);

    snapshotsByTarget.delete(targetKey);
    targetsByKey.delete(targetKey);

    if (didClearLatest) {
      // Another slot may still be live: a video rendering for minutes next to a
      // quick image batch. Falling to null here left the single-frame preview
      // blank until the video's next step, while the gallery cell — which reads
      // its own slot — kept showing the frame.
      latestSnapshotStore.patchSnapshot({ latestSnapshot: getMostRecentSnapshot() });
    }
  },
  /** Routing landed: these are the images the held swap frame may be painted over. */
  bindSwapImages(queueItemId: string, imageNames: readonly string[]): void {
    const entry = swapFrames.get(queueItemId);

    if (entry) {
      swapFrames.set(queueItemId, { image: entry.image, imageNames });
    }
  },
  /** Forget a queue item's held frames: its run is gone (detached or canceled). */
  clearHeld(queueItemId: string): void {
    dropBridge(queueItemId);
    dropSwap(queueItemId);
  },
  /**
   * Copy the slot's current frame into both held sets. The live frame itself
   * stays until the slot is cleared, so the single-slot preview keeps showing
   * it while the finished image is fetched.
   */
  hold(target: ProgressImageTarget): void {
    const image = snapshotsByTarget.get(getTargetKey(target));

    if (!image) {
      return;
    }

    holdBridge(target.queueItemId, image);
    holdSwap(target.queueItemId, image);
  },
  set(image: ProgressImageSnapshot, target?: ProgressImageTarget): void {
    latestSnapshotStore.patchSnapshot({ latestSnapshot: target ? { ...image, target } : image });

    if (target) {
      const targetKey = getTargetKey(target);

      snapshotsByTarget.set(targetKey, image);
      targetsByKey.delete(targetKey);
      targetsByKey.set(targetKey, target);
    }
  },
};

function getMostRecentSnapshot(): LatestProgressImageSnapshot | null {
  for (const [targetKey, target] of [...targetsByKey.entries()].reverse()) {
    const image = snapshotsByTarget.get(targetKey);

    if (image) {
      return { ...image, target };
    }
  }

  return null;
}

registerAccountOwnedResource({
  clear: () => progressImageStore.clear(),
  name: 'queue-progress-images',
});

export type ProgressImageSink = typeof progressImageStore;

/** The finished image has decoded on screen; the swap frame has done its job. */
export const consumeQueueItemSwapProgressImage = (queueItemId: string): void => {
  dropSwap(queueItemId);
};

export const getLatestProgressImage = (): LatestProgressImageSnapshot | null =>
  latestSnapshotStore.getSnapshot().latestSnapshot;

export const getQueueItemBridgeProgressImage = (queueItemId: string): ProgressImageSnapshot | null =>
  bridgeFrames.get(queueItemId) ?? null;

const selectSwapProgressImage = (entry: SwapFrame | undefined, imageName: string): ProgressImageSnapshot | null =>
  entry?.imageNames?.includes(imageName) ? entry.image : null;

export const getQueueItemSwapProgressImage = (queueItemId: string, imageName: string): ProgressImageSnapshot | null =>
  selectSwapProgressImage(swapFrames.get(queueItemId), imageName);

export const useProgressImage = (): LatestProgressImageSnapshot | null =>
  latestSnapshotStore.useSelector((snapshot) => snapshot.latestSnapshot);

export const useQueueItemProgressImage = (queueItemId: string, itemIndex: number): ProgressImageSnapshot | null =>
  snapshotsByTarget.useValue(getTargetKey({ itemIndex, queueItemId })) ?? null;

/** The frame to show for a slot of this queue item that has none of its own yet. */
export const useQueueItemBridgeProgressImage = (queueItemId: string): ProgressImageSnapshot | null =>
  bridgeFrames.useValue(queueItemId) ?? null;

/**
 * The frame to show in place of this just-finished image until it has decoded;
 * null once consumed or expired, for images the held frame did not produce, and
 * for images with no local run.
 */
export const useQueueItemSwapProgressImage = (
  queueItemId: string | null | undefined,
  imageName: string
): ProgressImageSnapshot | null => selectSwapProgressImage(swapFrames.useValue(queueItemId ?? ''), imageName);
