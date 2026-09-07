import type {
  QueueBackendItem,
  QueueBackendPort,
  QueueEnqueueGenerateRequest,
  QueueEnqueueResult,
  QueueEnqueueWorkflowRequest,
  QueueResultImage,
  QueueResultImageOptions,
  TerminalQueueItemStatus,
} from '@features/queue/core/types';
import type { BackendConnectionStatus } from '@platform/transport/types';

import {
  activeProgressTargetStore,
  type ActiveProgressTargetSink,
} from '@features/queue/data/activeProgressTargetStore';
import {
  isTerminalBackendStatus,
  parseQueueItemOrigin,
  parseQueueItemOriginProjectId,
  type InvocationCompleteEvent,
  type InvocationErrorEvent,
  type InvocationProgressEvent,
  type InvocationStartedEvent,
  type QueueItemStatusChangedEvent,
  type QueueItemsCanceledEvent,
} from '@features/queue/data/events';
import {
  progressImageStore,
  type ProgressImageSink,
  type ProgressImageTarget,
} from '@features/queue/data/progressImageStore';
import { queueItemProgressStore, type QueueItemProgressSink } from '@features/queue/data/progressStore';
import { mapWithConcurrency } from '@platform/core/concurrency';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { ApiError } from '@platform/transport/http';

const GALLERY_REFRESH_COALESCE_MS = 400;
const SAFETY_SWEEP_INTERVAL_MS = 30_000;
const TERMINAL_EVENT_BUFFER_LIMIT = 256;
const BACKEND_READ_CONCURRENCY = 16;

/**
 * Queue's view of model-load activity derived from socket events. The
 * production adapter is Models' modelLoadActivitySink, injected by the App
 * composition root (see app/QueueRuntimeAdapter); tests inject a double.
 */
export interface QueueModelLoadPort {
  completed(payload: unknown): void;
  reset(): void;
  started(payload: unknown): void;
}

export interface QueueNodeExecutionPort {
  clearAll(): void;
  completed(event: InvocationCompleteEvent): void;
  failed(event: InvocationErrorEvent): void;
  progress(nodeId: string, percentage: number | null, message: string): void;
  settleRunning(): void;
  started(event: InvocationStartedEvent): void;
}

export type QueueCoordinatorBackendPort = Pick<
  QueueBackendPort,
  | 'cancelQueueItems'
  | 'cancelQueueItemsByBatchIds'
  | 'emit'
  | 'enqueueGenerate'
  | 'enqueueWorkflow'
  | 'getItem'
  | 'getEnqueueReceipt'
  | 'getResultImages'
  | 'listItems'
  | 'on'
  | 'onConnectionChange'
  | 'readProgressPreviews'
>;

export interface QueueCoordinatorCallbacks {
  /** Fired when one backend item in a local batch completes, before the whole local batch necessarily settles. */
  onBackendItemComplete?(localQueueItemId: string, backendItemId: number): void | Promise<void>;
  /** Fired when one backend item in a local batch is canceled. */
  onBackendItemCancelled?(localQueueItemId: string, backendItemId: number): void;
  /** Coalesced signal that completed generations may have added gallery images. */
  onGalleryRefresh(): void;
}

type TerminalOutcome = { status: 'completed' } | { status: 'failed'; error: string } | { status: 'canceled' };

/** Thrown by `waitForResults` when the backend reports the run was canceled. */
export class QueueItemCancelledError extends Error {
  constructor(localQueueItemId: string) {
    super(`Queue item ${localQueueItemId} was canceled.`);
    this.name = 'QueueItemCancelledError';
  }
}

/** Thrown when an enqueue response definitively reports zero accepted items. */
export class QueueEnqueueNotAcceptedError extends Error {
  constructor(workKind: 'generation' | 'workflow') {
    super(`The backend queue did not accept this ${workKind}. The queue may be full.`);
    this.name = 'QueueEnqueueNotAcceptedError';
  }
}

export interface ReconcileInput {
  id: string;
  projectId?: string;
  status: 'pending' | 'running';
  backendItemIds?: number[];
  backendBatchId?: string;
}

export type ReconcileOutcome =
  /** A pending item the backend already accepted before the reload; do not re-enqueue. */
  | { kind: 'adopted'; backendItemIds: number[]; backendBatchId?: string; missingBackendItemIds?: number[] }
  /** A running item whose backend items were found again; its results are awaitable. */
  | { kind: 'resumed'; backendItemIds?: number[]; missingBackendItemIds?: number[] }
  /** A running item whose backend items no longer exist (queue cleared or pruned). */
  | { kind: 'missing'; backendItemIds?: number[]; backendBatchId?: string }
  /** A pending item the backend has never seen; submit it normally. */
  | { kind: 'enqueue' };

export interface CancelRunRequest {
  backendBatchId?: string;
  backendItemIds?: number[];
}

export interface QueueCoordinator {
  connect(): void;
  detachRun(localQueueItemId: string): void;
  dispose(): void;
  /**
   * Match persisted pending/running queue items against the live backend queue
   * so a reload neither double-submits nor orphans work. Adopted and resumed
   * items are tracked and can be awaited with `waitForResults`.
   */
  reconcile(items: ReconcileInput[]): Promise<Map<string, ReconcileOutcome>>;
  /** Enqueue a generate batch and track its backend items for event-driven settlement. */
  submitGenerate(localQueueItemId: string, request: QueueEnqueueGenerateRequest): Promise<QueueEnqueueResult>;
  /** Enqueue a compiled workflow graph and track its backend items the same way. */
  submitWorkflow(localQueueItemId: string, request: QueueEnqueueWorkflowRequest): Promise<QueueEnqueueResult>;
  /**
   * Resolve once every backend item of the run reaches a terminal status —
   * driven by socket events, with a slow safety sweep as the only polling.
   * Resolves with the result images, throws on failure, and throws
   * `QueueItemCancelledError` on backend-side cancellation.
   */
  waitForResults(
    localQueueItemId: string,
    queuedAt: string,
    options?: QueueResultImageOptions
  ): Promise<QueueResultImage[]>;
  cancelRun(request: CancelRunRequest): Promise<void>;
}

interface RunState {
  backendItemIds: number[];
  backendBatchId?: string;
  outcomePromises: Promise<TerminalOutcome>[];
}

interface RunProgressState {
  activeBackendItemId?: number;
  backendItemIds: number[];
  cancelledBackendItemIds: Set<number>;
  completedBackendItemIds: Set<number>;
  message: string;
  percentage: number | null;
}

interface WaitState {
  localQueueItemId: string;
  settle: (outcome: TerminalOutcome) => void;
}

const toTerminalOutcome = (
  status: TerminalQueueItemStatus,
  error?: string | null,
  errorType?: string | null
): TerminalOutcome => {
  if (status === 'completed') {
    return { status: 'completed' };
  }

  if (status === 'failed') {
    return { error: error ?? errorType ?? 'Generation failed.', status: 'failed' };
  }

  return { status: 'canceled' };
};

export const createQueueCoordinator = (
  callbacks: QueueCoordinatorCallbacks,
  options: {
    /** One adapter owns Queue HTTP commands and realtime events. */
    backend: QueueCoordinatorBackendPort;
    activeProgressTarget?: ActiveProgressTargetSink;
    galleryRefreshCoalesceMs?: number;
    modelLoads: QueueModelLoadPort;
    nodeExecution: QueueNodeExecutionPort;
    progress?: QueueItemProgressSink;
    progressImage?: ProgressImageSink;
    sweepIntervalMs?: number;
  }
): QueueCoordinator => {
  const owner = captureAccountScope();
  const backend = options.backend;
  const activeProgressTarget = options.activeProgressTarget ?? activeProgressTargetStore;
  const progress = options.progress ?? queueItemProgressStore;
  const modelLoads = options.modelLoads;
  const nodeExecution = options.nodeExecution;
  const progressImage = options.progressImage ?? progressImageStore;
  const galleryRefreshCoalesceMs = options.galleryRefreshCoalesceMs ?? GALLERY_REFRESH_COALESCE_MS;
  const sweepIntervalMs = options.sweepIntervalMs ?? SAFETY_SWEEP_INTERVAL_MS;

  const runs = new Map<string, RunState>();
  const runProgress = new Map<string, RunProgressState>();
  const waits = new Map<number, WaitState>();
  /**
   * Terminal events that arrived for items nobody tracks yet. Closes the race
   * where a very fast generation finishes between `enqueue_batch` resolving
   * and the run being registered.
   */
  const recentTerminalOutcomes = new Map<number, TerminalOutcome>();
  const latestStatusSequences = new Map<number, number>();
  /**
   * Per backend item, the session and revision of the last accepted preview
   * frame. Socket delivery is ordered, so this only bites when a second source
   * — the reconnect snapshot the backend is to grow — races the live stream.
   */
  const latestFrameGates = new Map<number, { revision: number | null; sessionId: string }>();

  const detachers: Array<() => void> = [];
  let isAttached = false;
  let isDisposed = false;
  let galleryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let isSweeping = false;
  let isSweepRequested = false;
  const isActive = (): boolean => !isDisposed && isAccountScopeCurrent(owner);

  const scheduleGalleryRefresh = (): void => {
    if (!isActive() || galleryRefreshTimer !== null) {
      return;
    }

    galleryRefreshTimer = setTimeout(() => {
      galleryRefreshTimer = null;

      if (isActive()) {
        callbacks.onGalleryRefresh();
      }
    }, galleryRefreshCoalesceMs);
  };

  const bufferTerminalOutcome = (backendItemId: number, outcome: TerminalOutcome): void => {
    if (!isActive()) {
      return;
    }

    recentTerminalOutcomes.delete(backendItemId);
    recentTerminalOutcomes.set(backendItemId, outcome);

    while (recentTerminalOutcomes.size > TERMINAL_EVENT_BUFFER_LIMIT) {
      const oldestId = recentTerminalOutcomes.keys().next().value;

      if (oldestId === undefined) {
        return;
      }

      recentTerminalOutcomes.delete(oldestId);
    }
  };

  const publishRunProgress = (localQueueItemId: string): void => {
    if (!isActive()) {
      return;
    }

    const state = runProgress.get(localQueueItemId);

    if (!state) {
      return;
    }

    const terminalBackendItemIds = new Set([...state.completedBackendItemIds, ...state.cancelledBackendItemIds]);
    const activeBackendItemId =
      state.activeBackendItemId !== undefined && !terminalBackendItemIds.has(state.activeBackendItemId)
        ? state.activeBackendItemId
        : undefined;
    // activeItemIndex means "slot currently executing" — omitted while the
    // item merely waits in the queue, so idle slots never present as live.
    const activeItemIndex =
      activeBackendItemId !== undefined
        ? Math.max(1, state.backendItemIds.indexOf(activeBackendItemId) + 1)
        : undefined;

    progress.set(localQueueItemId, {
      activeItemIndex,
      completedItemCount: terminalBackendItemIds.size,
      message: state.message,
      percentage: state.percentage,
      totalItemCount: state.backendItemIds.length,
    });
  };

  const getProgressImageTarget = (localQueueItemId: string, backendItemId: number): ProgressImageTarget => {
    const backendItemIds = runProgress.get(localQueueItemId)?.backendItemIds ?? [backendItemId];
    const itemIndex = backendItemIds.indexOf(backendItemId);

    return { itemIndex: itemIndex === -1 ? 1 : itemIndex + 1, queueItemId: localQueueItemId };
  };

  const settleWait = (backendItemId: number, outcome: TerminalOutcome): void => {
    const wait = waits.get(backendItemId);

    if (!wait) {
      bufferTerminalOutcome(backendItemId, outcome);
      return;
    }

    waits.delete(backendItemId);
    latestFrameGates.delete(backendItemId);
    const progressTarget = getProgressImageTarget(wait.localQueueItemId, backendItemId);
    const releaseProgressSlot = (): void => {
      if (isActive()) {
        activeProgressTarget.clear(progressTarget);
        progressImage.clear(progressTarget);
      }
    };
    const state = runProgress.get(wait.localQueueItemId);

    if (state) {
      if (state.activeBackendItemId === backendItemId) {
        state.activeBackendItemId = undefined;
        state.message = '';
        state.percentage = null;
      }
      if (outcome.status === 'completed') {
        state.completedBackendItemIds.add(backendItemId);
      }
      if (outcome.status === 'canceled') {
        state.cancelledBackendItemIds.add(backendItemId);
      }
      publishRunProgress(wait.localQueueItemId);
    }

    if (outcome.status === 'completed') {
      // Held before routing starts: the finished image swaps in over this frame
      // once the browser has decoded it, and the batch's next slot shows it
      // until a frame of its own arrives.
      progressImage.hold(progressTarget);
      const routingPromise = callbacks.onBackendItemComplete?.(wait.localQueueItemId, backendItemId);

      if (routingPromise) {
        // The slot stays followed until routing lands. Released on the terminal
        // event, Preview fell out of live-follow two HTTP round trips before the
        // finished image could be selected, and showed the previous selection
        // in between.
        activeProgressTarget.settle(progressTarget);
        void Promise.resolve(routingPromise)
          .finally(releaseProgressSlot)
          .catch(() => undefined);
      } else {
        releaseProgressSlot();
      }
    } else {
      releaseProgressSlot();
    }

    if (outcome.status === 'canceled') {
      callbacks.onBackendItemCancelled?.(wait.localQueueItemId, backendItemId);
    }

    wait.settle(outcome);
  };

  const settleFromQueueItem = (queueItem: QueueBackendItem): void => {
    if (isTerminalBackendStatus(queueItem.status)) {
      settleWait(queueItem.id, toTerminalOutcome(queueItem.status, queueItem.errorMessage, queueItem.errorType));
    }
  };

  const isTrackedEvent = (event: { item_id: number }): boolean => waits.has(event.item_id);

  const trackBackendItem = (localQueueItemId: string, backendItemId: number): Promise<TerminalOutcome> => {
    const bufferedOutcome = recentTerminalOutcomes.get(backendItemId);

    if (bufferedOutcome) {
      recentTerminalOutcomes.delete(backendItemId);

      return Promise.resolve(bufferedOutcome);
    }

    return new Promise<TerminalOutcome>((settle) => {
      waits.set(backendItemId, { localQueueItemId, settle });
    });
  };

  const beginRun = (localQueueItemId: string, backendItemIds: number[], backendBatchId?: string): void => {
    if (!isActive()) {
      throw new QueueItemCancelledError(localQueueItemId);
    }

    runs.set(localQueueItemId, {
      backendBatchId,
      backendItemIds,
      outcomePromises: backendItemIds.map((backendItemId) => trackBackendItem(localQueueItemId, backendItemId)),
    });

    runProgress.set(localQueueItemId, {
      backendItemIds,
      cancelledBackendItemIds: new Set(),
      completedBackendItemIds: new Set(),
      message: '',
      percentage: null,
    });
    publishRunProgress(localQueueItemId);
  };

  /**
   * Slow safety net for events lost to disconnects; runs on reconnect, on the
   * tab becoming visible, and on a long interval. A request made while one is in
   * flight runs again afterwards rather than being dropped: the visibility sweep
   * often fires while the network is still coming back and the reconnect sweep
   * a second later is the one that can actually reach the backend.
   */
  const sweep = async (): Promise<void> => {
    if (!isActive() || waits.size === 0) {
      return;
    }

    if (isSweeping) {
      isSweepRequested = true;
      return;
    }

    isSweeping = true;

    try {
      await Promise.all(
        [...waits.keys()].map(async (backendItemId) => {
          try {
            const queueItem = await backend.getItem(backendItemId);

            if (isActive()) {
              settleFromQueueItem(queueItem);
            }
          } catch (error) {
            if (isActive() && error instanceof ApiError && error.status === 404) {
              settleWait(backendItemId, {
                error: `Queue item ${backendItemId} is no longer on the backend queue.`,
                status: 'failed',
              });
            }
          }
        })
      );
    } finally {
      isSweeping = false;

      if (isSweepRequested) {
        isSweepRequested = false;
        void sweep();
      }
    }
  };

  /**
   * Ask the backend for the latest preview frame of every running item and feed
   * each through the socket handler, where the revision gate drops anything the
   * live stream already delivered. Covers the frames lost while a hidden tab's
   * socket was down, and the frames a reloaded page never saw. Best effort: the
   * backend also replays them on `subscribe_queue`, and a failure here only means
   * waiting for the next step.
   */
  const refreshProgressPreviews = async (): Promise<void> => {
    if (!isActive() || waits.size === 0 || !backend.readProgressPreviews) {
      return;
    }

    let previews: Awaited<ReturnType<NonNullable<typeof backend.readProgressPreviews>>>;

    try {
      previews = await backend.readProgressPreviews();
    } catch {
      return;
    }

    if (!isActive()) {
      return;
    }

    for (const preview of previews) {
      // Structurally the socket payload; the port cannot name the event type.
      handleProgress(preview as unknown as InvocationProgressEvent);
    }
  };

  const handleStatusChanged = (event: QueueItemStatusChangedEvent): void => {
    if (!isActive()) {
      return;
    }

    const sequence = event.status_sequence;
    const previousSequence = latestStatusSequences.get(event.item_id);
    if (sequence !== null && previousSequence !== undefined && sequence < previousSequence) {
      return;
    }
    if (sequence !== null) {
      latestStatusSequences.set(event.item_id, sequence);
    }

    if (!isTerminalBackendStatus(event.status)) {
      // Back to the queue (a workflow-call parent waiting on its child, a retry):
      // whatever frames follow belong to a new leg, and after a backend restart
      // their revisions start over.
      if (event.status === 'pending' || event.status === 'waiting') {
        latestFrameGates.delete(event.item_id);
      }

      return;
    }

    if (!isTrackedEvent(event)) {
      bufferTerminalOutcome(event.item_id, toTerminalOutcome(event.status, event.error_message, event.error_type));
      return;
    }

    nodeExecution.settleRunning();
    settleWait(event.item_id, toTerminalOutcome(event.status, event.error_message, event.error_type));

    if (event.status === 'completed') {
      scheduleGalleryRefresh();
    }
  };

  const handleItemsCanceled = (event: QueueItemsCanceledEvent): void => {
    if (!isActive()) {
      return;
    }

    for (const itemId of event.canceled_item_ids) {
      if (waits.has(itemId)) {
        settleWait(itemId, { status: 'canceled' });
      }
    }
  };

  /**
   * Whether a frame is older than one already shown for its backend item;
   * records it as the newest when it is not. A new session on the same item
   * starts over.
   */
  const isStaleFrame = (event: InvocationProgressEvent): boolean => {
    const revision = event.revision ?? null;
    const gate = latestFrameGates.get(event.item_id);

    if (
      gate &&
      gate.sessionId === event.session_id &&
      revision !== null &&
      gate.revision !== null &&
      revision <= gate.revision
    ) {
      return true;
    }

    latestFrameGates.set(event.item_id, { revision, sessionId: event.session_id });

    return false;
  };

  const handleProgress = (event: InvocationProgressEvent): void => {
    if (!isActive()) {
      return;
    }

    const wait = waits.get(event.item_id);

    if (!wait) {
      return;
    }

    if (event.image?.dataURL && isStaleFrame(event)) {
      return;
    }

    nodeExecution.progress(event.invocation_source_id, event.percentage, event.message);

    const target = getProgressImageTarget(wait.localQueueItemId, event.item_id);
    activeProgressTarget.set(target);

    if (event.image?.dataURL) {
      progressImage.set({ dataUrl: event.image.dataURL, height: event.image.height, width: event.image.width }, target);
    }

    const state = runProgress.get(wait.localQueueItemId);

    if (state) {
      state.activeBackendItemId = event.item_id;
      state.message = event.message;
      state.percentage = event.percentage;
      publishRunProgress(wait.localQueueItemId);
    } else {
      progress.set(wait.localQueueItemId, { message: event.message, percentage: event.percentage });
    }
  };

  /**
   * React to the shared socket's connection lifecycle. The Platform hub owns
   * transport mechanics only; this Queue coordinator clears its transient
   * per-node and model-load state and, on (re)connect, schedules a gallery
   * refresh and missed-event sweep.
   *
   * The followed slot and its last frame deliberately survive a drop: the run
   * continues on the backend and the sweep reconciles its durable outcome, so
   * wiping them only ever produced a blank card — until the next event if the
   * run was still going, or for good if it finished while disconnected.
   */
  const handleConnectionChange = (status: BackendConnectionStatus): void => {
    if (!isActive()) {
      return;
    }

    progress.clearAll?.();
    nodeExecution.clearAll();
    modelLoads.reset();

    if (status === 'connected') {
      scheduleGalleryRefresh();
      void sweep();
    }
  };

  /** Attach generation listeners to the shared socket hub. */
  const connect = (): void => {
    if (!isActive() || isAttached) {
      return;
    }

    isAttached = true;

    detachers.push(
      backend.on('queue_item_status_changed', handleStatusChanged),
      backend.on('queue_items_canceled', handleItemsCanceled),
      backend.on('invocation_progress', handleProgress),
      backend.on('invocation_started', (event: InvocationStartedEvent) => {
        if (!isActive() || !isTrackedEvent(event)) {
          return;
        }

        nodeExecution.started(event);
      }),
      backend.on('invocation_complete', (event: InvocationCompleteEvent) => {
        if (!isActive() || !isTrackedEvent(event)) {
          return;
        }

        nodeExecution.completed(event);
      }),
      backend.on('invocation_error', (event: InvocationErrorEvent) => {
        if (!isActive() || !isTrackedEvent(event)) {
          return;
        }

        nodeExecution.failed(event);
      }),
      backend.on('model_load_started', (payload: never) => {
        if (isActive()) {
          modelLoads.started(payload);
        }
      }),
      backend.on('model_load_complete', (payload: never) => {
        if (isActive()) {
          modelLoads.completed(payload);
        }
      })
    );

    // Fires synchronously with the current status, so attaching after the hub
    // has already connected still triggers the initial clear + sweep.
    detachers.push(backend.onConnectionChange(handleConnectionChange));

    // A hidden tab's socket is often dropped by the server (its pings are
    // timer-throttled) and socket.io reconnects on its own backoff once the tab
    // is back. The outcome is on the backend already, so sweep on the
    // visibility edge itself rather than waiting for the reconnect edge.
    if (typeof document !== 'undefined') {
      const visibilityDocument = document;
      const handleVisibilityChange = (): void => {
        if (visibilityDocument.visibilityState === 'visible') {
          void sweep();
          void refreshProgressPreviews();
        }
      };

      visibilityDocument.addEventListener('visibilitychange', handleVisibilityChange);
      detachers.push(() => visibilityDocument.removeEventListener('visibilitychange', handleVisibilityChange));
    }

    sweepTimer = setInterval(() => {
      void sweep();
    }, sweepIntervalMs);
  };

  /** Detach generation listeners; the hub keeps the socket alive. */
  const dispose = (): void => {
    isDisposed = true;
    activeProgressTarget.clear();
    progressImage.clear();
    progress.clearAll?.();
    nodeExecution.clearAll();
    modelLoads.reset();

    for (const detach of detachers) {
      detach();
    }

    detachers.length = 0;

    if (galleryRefreshTimer !== null) {
      clearTimeout(galleryRefreshTimer);
      galleryRefreshTimer = null;
    }

    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }

    // A disposed coordinator can never observe another event, so pending
    // waits settle as canceled (raw, no completion/cancel side effects) —
    // otherwise `waitForResults` awaiters hang forever. The backend run
    // itself continues; a later `reconcile` re-adopts it.
    for (const wait of waits.values()) {
      wait.settle({ status: 'canceled' });
    }

    waits.clear();
    runs.clear();
    runProgress.clear();
    recentTerminalOutcomes.clear();
    latestStatusSequences.clear();
    latestFrameGates.clear();
  };

  const reconcile = async (items: ReconcileInput[]): Promise<Map<string, ReconcileOutcome>> => {
    const outcomes = new Map<string, ReconcileOutcome>();

    if (!isActive() || items.length === 0) {
      return outcomes;
    }

    const resolvedItems = await mapWithConcurrency(items, BACKEND_READ_CONCURRENCY, async (item) => {
      if (item.backendItemIds?.length || !item.projectId || !backend.getEnqueueReceipt) {
        return item;
      }
      const receipt = await backend.getEnqueueReceipt(item.projectId, item.id);
      return receipt ? { ...item, backendBatchId: receipt.batchId, backendItemIds: receipt.itemIds } : item;
    });
    const canReadExactItems = resolvedItems.every(
      (item) => item.backendItemIds?.length || (item.projectId && backend.getEnqueueReceipt)
    );
    const backendItems = canReadExactItems
      ? (
          await mapWithConcurrency(
            [...new Set(resolvedItems.flatMap((item) => item.backendItemIds ?? []))],
            BACKEND_READ_CONCURRENCY,
            async (itemId) => {
              try {
                return await backend.getItem(itemId);
              } catch (error) {
                if (error instanceof ApiError && error.status === 404) {
                  return undefined;
                }

                throw error;
              }
            }
          )
        ).filter((item) => item !== undefined)
      : await backend.listItems();

    if (!isActive()) {
      return outcomes;
    }

    const backendItemsById = new Map(backendItems.map((item) => [item.id, item]));

    for (const item of resolvedItems) {
      const matchesIdentity = (backendItem: QueueBackendItem | undefined): backendItem is QueueBackendItem =>
        backendItem !== undefined &&
        parseQueueItemOrigin(backendItem.origin) === item.id &&
        (item.projectId === undefined || parseQueueItemOriginProjectId(backendItem.origin) === item.projectId);
      const knownBackendItems = item.backendItemIds?.length
        ? item.backendItemIds.map((backendItemId) => backendItemsById.get(backendItemId))
        : backendItems.filter(matchesIdentity);
      const foundBackendItems = knownBackendItems.filter(matchesIdentity);
      const missingBackendItemIds = item.backendItemIds?.filter(
        (_backendItemId, index) => !matchesIdentity(knownBackendItems[index])
      );

      if (foundBackendItems.length === 0) {
        // A pending item with no backend trace was never accepted and is safe
        // to submit; a running item with (partially) vanished backend items is
        // unrecoverable.
        outcomes.set(
          item.id,
          item.status === 'pending' && !item.backendItemIds?.length
            ? { kind: 'enqueue' }
            : {
                ...(item.backendBatchId ? { backendBatchId: item.backendBatchId } : {}),
                ...(item.backendItemIds?.length ? { backendItemIds: item.backendItemIds } : {}),
                kind: 'missing',
              }
        );
        continue;
      }

      const backendItemIds = foundBackendItems.map((backendItem) => backendItem.id);
      const backendBatchId = item.backendBatchId ?? foundBackendItems[0]?.batchId;

      beginRun(item.id, backendItemIds, backendBatchId);

      for (const backendItem of foundBackendItems) {
        settleFromQueueItem(backendItem);
      }

      outcomes.set(
        item.id,
        item.status === 'running'
          ? {
              kind: 'resumed',
              ...(missingBackendItemIds?.length ? { backendItemIds, missingBackendItemIds } : {}),
            }
          : {
              backendBatchId,
              backendItemIds,
              kind: 'adopted',
              ...(missingBackendItemIds?.length ? { missingBackendItemIds } : {}),
            }
      );
    }

    // A reloaded page has no frame for a run it just re-adopted; the socket only
    // brings the next step's.
    void refreshProgressPreviews();

    return outcomes;
  };

  /** Start tracking the accepted backend items. */
  const adoptEnqueueResult = (
    localQueueItemId: string,
    result: QueueEnqueueResult,
    workKind: 'generation' | 'workflow'
  ): QueueEnqueueResult => {
    if (result.enqueued === 0) {
      throw new QueueEnqueueNotAcceptedError(workKind);
    }

    beginRun(localQueueItemId, result.itemIds, result.batchId);

    return result;
  };

  const submitGenerate = async (
    localQueueItemId: string,
    request: QueueEnqueueGenerateRequest
  ): Promise<QueueEnqueueResult> => {
    if (!isActive()) {
      throw new QueueItemCancelledError(localQueueItemId);
    }

    return adoptEnqueueResult(localQueueItemId, await backend.enqueueGenerate(request), 'generation');
  };

  const submitWorkflow = async (
    localQueueItemId: string,
    request: QueueEnqueueWorkflowRequest
  ): Promise<QueueEnqueueResult> => {
    if (!isActive()) {
      throw new QueueItemCancelledError(localQueueItemId);
    }

    return adoptEnqueueResult(localQueueItemId, await backend.enqueueWorkflow(request), 'workflow');
  };

  const waitForResults = async (
    localQueueItemId: string,
    queuedAt: string,
    options?: QueueResultImageOptions
  ): Promise<QueueResultImage[]> => {
    if (!isActive()) {
      throw new QueueItemCancelledError(localQueueItemId);
    }

    const run = runs.get(localQueueItemId);

    if (!run) {
      throw new Error(`Queue item ${localQueueItemId} has no tracked backend run.`);
    }

    try {
      const outcomes = await Promise.all(run.outcomePromises);
      const failure = outcomes.find((outcome) => outcome.status === 'failed');

      if (failure) {
        throw new Error(failure.error);
      }

      const completedBackendItemIds = run.backendItemIds.filter(
        (_backendItemId, index) => outcomes[index]?.status === 'completed'
      );

      if (completedBackendItemIds.length === 0 && outcomes.some((outcome) => outcome.status === 'canceled')) {
        throw new QueueItemCancelledError(localQueueItemId);
      }

      const imagesPerItem = await mapWithConcurrency(
        completedBackendItemIds,
        BACKEND_READ_CONCURRENCY,
        (backendItemId) =>
          options
            ? backend.getResultImages(backendItemId, localQueueItemId, queuedAt, options)
            : backend.getResultImages(backendItemId, localQueueItemId, queuedAt)
      );

      return imagesPerItem.flat();
    } finally {
      runs.delete(localQueueItemId);
      runProgress.delete(localQueueItemId);
      if (isActive()) {
        progress.clear(localQueueItemId);
      }
    }
  };

  const cancelRun = async ({ backendBatchId, backendItemIds }: CancelRunRequest): Promise<void> => {
    try {
      if (backendBatchId) {
        await backend.cancelQueueItemsByBatchIds([backendBatchId]);
        return;
      }

      if (backendItemIds?.length) {
        await backend.cancelQueueItems(backendItemIds);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        return;
      }

      throw error;
    }
  };

  const detachRun = (localQueueItemId: string): void => {
    const run = runs.get(localQueueItemId);
    for (const backendItemId of run?.backendItemIds ?? []) {
      const wait = waits.get(backendItemId);
      if (wait?.localQueueItemId === localQueueItemId) {
        waits.delete(backendItemId);
        latestFrameGates.delete(backendItemId);
        wait.settle({ status: 'canceled' });
      }
    }
    runs.delete(localQueueItemId);
    runProgress.delete(localQueueItemId);
    for (let itemIndex = 1; itemIndex <= (run?.backendItemIds.length ?? 0); itemIndex += 1) {
      const target = { itemIndex, queueItemId: localQueueItemId };
      activeProgressTarget.clear(target);
      progressImage.clear(target);
    }
    progressImage.clearHeld(localQueueItemId);
    progress.clear(localQueueItemId);
  };

  return { cancelRun, connect, detachRun, dispose, reconcile, submitGenerate, submitWorkflow, waitForResults };
};
