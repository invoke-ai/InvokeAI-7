import { invalidateGallery } from '@features/gallery/queries';
import { modelLoadActivitySink } from '@features/models';
import { nodeExecutionStore } from '@features/nodes';
import {
  createProductionQueueRuntime,
  createProductionQueueReceiptAcknowledgements,
  getRemoteSyntheticBackendItemId,
  parseRemoteProgressMessage,
  subscribeRecoveredRemoteBridges,
  type InvocationProgressEvent,
} from '@features/queue';
import { createWorkflowRunCaptureSink } from '@features/workflow/queries';
import { ensureInvocationTemplatesLoaded } from '@features/workflow/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { absolutizeApiUrl, apiFetchJson, getApiErrorMessage } from '@platform/transport/http';
import { socketHub } from '@platform/transport/socketHub';
import { useQueryClient } from '@tanstack/react-query';
import {
  forgetCanvasRemotePreview,
  recordCanvasRemotePreview,
  resetCanvasRemotePreviews,
} from '@workbench/canvasRemotePreviews';
import { getOpenProject, getProjectSyncSnapshot } from '@workbench/projects/syncStore';
import {
  createAccountOwnedQueueRecallCache,
  type QueueRecallCache,
} from '@workbench/queue-integration/queueRecallCache';
import { createAccountOwnedQueueRunJournal, type QueueRunJournal } from '@workbench/queue-integration/queueRunJournal';
import { createQueueRunLockPort } from '@workbench/queue-integration/queueRunLocks';
import { withQueueRecallCache } from '@workbench/queue-integration/queueRunPersistence';
import { useWorkbenchCommands, useWorkbenchQueries, useWorkbenchSubscription } from '@workbench/WorkbenchContext';

interface RemoteCanvasImageDTO {
  image_name: string;
  image_url: string;
  thumbnail_url: string;
  height: number;
  width: number;
}

/** App-owned production composition of Queue, Workbench, Gallery, Workflow, Nodes, and Models adapters. */
export const QueueRuntimeAdapter = () => {
  const { canvas, notifications, queue } = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const queryClient = useQueryClient();
  const subscribe = useWorkbenchSubscription();

  useMountEffect(() => {
    const owner = captureAccountScope();
    let isDisposed = false;

    // Remote completion can arrive after the local backend queue item has settled.
    // The workbench's own Canvas staging action accepts such late alternatives.
    resetCanvasRemotePreviews();
    const stagedRemoteImageKeys = new Set<string>();
    const terminalRemoteCanvasKeys = new Set<string>();
    const handleRemoteCanvasResult = (event: InvocationProgressEvent): void => {
      if (isDisposed || !isAccountScopeCurrent(owner)) {
        return;
      }
      const remote = typeof event.message === 'string' ? parseRemoteProgressMessage(event.message) : null;
      if (!remote || (owner.accountId !== 'single-user' && event.user_id !== owner.accountId)) {
        return;
      }
      const remoteKey = `${remote.queueItemId}:${remote.backendItemId ?? 0}:${remote.slot}`;
      if (remote.state !== 'running') {
        terminalRemoteCanvasKeys.add(remoteKey);
        if (terminalRemoteCanvasKeys.size > 256) {
          terminalRemoteCanvasKeys.delete(terminalRemoteCanvasKeys.values().next().value!);
        }
      } else if (terminalRemoteCanvasKeys.has(remoteKey)) {
        // An older reconnect snapshot must not revive a completed Canvas slot.
        return;
      }

      const project = queries
        .getSnapshot()
        .projects.find((candidate) => candidate.queue.items.some((item) => item.id === remote.queueItemId));
      const item = project?.queue.items.find((candidate) => candidate.id === remote.queueItemId);
      if (
        !project ||
        !item ||
        item.snapshot.destination !== 'canvas' ||
        item.status === 'cancelled' ||
        project.canvas.documentRevision !== item.snapshot.canvas.documentRevision
      ) {
        return;
      }

      recordCanvasRemotePreview(remote);
      if (remote.state !== 'completed' || !remote.imageNames?.length) {
        // A completed remote with no image names cannot become a Canvas
        // candidate. Do not leave its placeholder showing Generating forever.
        if (remote.state === 'completed') {
          forgetCanvasRemotePreview(remote.queueItemId, remote.slot, remote.backendItemId);
        }
        return;
      }

      for (const imageName of remote.imageNames) {
        const key = `${remote.queueItemId}:${remote.backendItemId ?? 0}:${remote.slot}:${imageName}`;
        if (stagedRemoteImageKeys.has(key)) {
          continue;
        }
        stagedRemoteImageKeys.add(key);
        void apiFetchJson<RemoteCanvasImageDTO>(`/api/v1/images/i/${encodeURIComponent(imageName)}`, {
          signal: owner.signal,
        })
          .then((image) => {
            if (isDisposed || !isAccountScopeCurrent(owner)) {
              return;
            }
            const current = queries.getSnapshot().projects.find((candidate) => candidate.id === project.id);
            const queued = current?.queue.items.find((candidate) => candidate.id === remote.queueItemId);
            if (
              !current ||
              !queued ||
              queued.snapshot.destination !== 'canvas' ||
              queued.status === 'cancelled' ||
              current.canvas.documentRevision !== queued.snapshot.canvas.documentRevision
            ) {
              forgetCanvasRemotePreview(remote.queueItemId, remote.slot, remote.backendItemId);
              return;
            }
            const bbox = queued.snapshot.canvas.document.bbox;
            canvas.appendStagingCandidate({
              projectId: current.id,
              candidate: {
                height: image.height,
                imageName: image.image_name,
                imageUrl: absolutizeApiUrl(image.image_url),
                placement: {
                  height: image.height,
                  opacity: 1,
                  width: image.width,
                  x: bbox.x,
                  y: bbox.y,
                },
                queuedAt: queued.snapshot.submittedAt,
                sourceBackendItemId: getRemoteSyntheticBackendItemId(
                  remote.queueItemId,
                  remote.slot,
                  remote.backendItemId
                ),
                sourceQueueItemId: remote.queueItemId,
                thumbnailUrl: absolutizeApiUrl(image.thumbnail_url),
                width: image.width,
              },
            });
            // The real candidate has replaced this remote's temporary slot.
            // Remove the completed entry now: otherwise Discard All deletes the
            // candidate and exposes the old R1 Generating placeholder again.
            forgetCanvasRemotePreview(remote.queueItemId, remote.slot, remote.backendItemId);
          })
          .catch((error: unknown) => {
            stagedRemoteImageKeys.delete(key);
            forgetCanvasRemotePreview(remote.queueItemId, remote.slot, remote.backendItemId);
            if (!isDisposed && isAccountScopeCurrent(owner)) {
              notifications.reportError({
                area: 'queue-results',
                message: getApiErrorMessage(error, 'Could not stage a remote Canvas result'),
                namespace: 'queue',
                projectId: project.id,
              });
            }
          });
      }
    };
    const detachRemoteCanvasResults = socketHub.on('invocation_progress', (payload: never) => {
      handleRemoteCanvasResult(payload as InvocationProgressEvent);
    });
    const detachRecoveredRemoteCanvasResults = subscribeRecoveredRemoteBridges(({ events }) => {
      for (const event of events) {
        handleRemoteCanvasResult(event);
      }
    });
    let journal: QueueRunJournal | undefined;
    let recallCache: QueueRecallCache | undefined;
    let runtime: ReturnType<typeof createProductionQueueRuntime> | undefined;
    let receiptAcknowledgements: ReturnType<typeof createProductionQueueReceiptAcknowledgements> | undefined;
    const startRuntime = async (runJournal?: QueueRunJournal) => {
      const cache = await createAccountOwnedQueueRecallCache(owner).catch(() => undefined);
      if (isDisposed || !isAccountScopeCurrent(owner)) {
        runJournal?.close();
        cache?.close();
        return;
      }
      journal = runJournal;
      recallCache = cache;
      if (runJournal && cache) {
        runJournal = withQueueRecallCache(runJournal, cache, (projectId, queueItemId) =>
          queries
            .getSnapshot()
            .projects.find((project) => project.id === projectId)
            ?.queue.items.find((item) => item.id === queueItemId)
        );
      }
      if (runJournal) {
        receiptAcknowledgements = createProductionQueueReceiptAcknowledgements(
          runJournal,
          () => !isDisposed && isAccountScopeCurrent(owner)
        );
        void receiptAcknowledgements.flush();
      }
      runtime = createProductionQueueRuntime({
        destinations: {
          addImagesToGalleryBoard: async (boardId, imageNames) => {
            assertAccountScopeCurrent(owner);
            const { galleryOrganization } = await import('@features/gallery');

            assertAccountScopeCurrent(owner);
            await galleryOrganization.addToBoard(boardId, imageNames, owner.signal);
            assertAccountScopeCurrent(owner);
          },
          addVideosToGalleryBoard: async (boardId, videoNames) => {
            assertAccountScopeCurrent(owner);
            const { galleryItemOrganization, isGalleryBoardAttachable } = await import('@features/gallery');

            // Skip virtual destinations: attachment transport no-ops would otherwise be reported as video
            // failures.
            if (!isGalleryBoardAttachable(boardId)) {
              return;
            }

            assertAccountScopeCurrent(owner);
            const result = await galleryItemOrganization.moveToBoard(
              videoNames.map((name) => ({ kind: 'video' as const, name })),
              boardId,
              owner.signal
            );
            assertAccountScopeCurrent(owner);
            // Report unconfirmed video attachments; transport does not throw non-fatal failures.
            if (result.failed.length > 0) {
              throw new Error(
                `${result.failed.length} of ${videoNames.length} video(s) could not be added to the board.`
              );
            }
          },
        },
        async ensureProjectPersisted(projectId) {
          assertAccountScopeCurrent(owner);
          const sync = getProjectSyncSnapshot().projects[projectId];
          if (sync?.conflict?.kind === 'deleted') {
            return 'refused';
          }
          if (sync?.revision && sync.revision > 0) {
            return 'ready';
          }
          if (sync?.conflict || sync?.schemaRefusal) {
            return 'refused';
          }
          const project = getOpenProject(projectId);
          if (!project) {
            return 'retry';
          }
          const outcome = await project.flush();
          assertAccountScopeCurrent(owner);
          return outcome.kind === 'acknowledged' ? 'ready' : outcome.kind === 'unsynced' ? 'retry' : 'refused';
        },
        ensureTemplatesLoaded: ensureInvocationTemplatesLoaded,
        history: {
          commands: {
            ...queue,
            recordError: notifications.reportError,
            refreshBackendData: () => void invalidateGallery(queryClient),
          },
          getSnapshot: () => {
            const snapshot = queries.getSnapshot();

            return {
              connectionStatus: snapshot.backendConnection.status,
              isHydrated: snapshot.hasHydrated,
              projects: snapshot.projects,
            };
          },
          subscribe,
        },
        journal: runJournal
          ? {
              ...runJournal,
              async record(projectId, item) {
                const result = await runJournal.record(projectId, item);
                void receiptAcknowledgements?.flush();
                return result;
              },
              async settle(projectId, queueItemId) {
                const result = await runJournal.settle(projectId, queueItemId);
                void receiptAcknowledgements?.flush();
                return result;
              },
            }
          : undefined,
        locks: createQueueRunLockPort(owner.storageSuffix),
        modelLoads: modelLoadActivitySink,
        nodeExecution: nodeExecutionStore,
        workflowRuns: createWorkflowRunCaptureSink(),
      });
      runtime.start();
    };

    void createAccountOwnedQueueRunJournal(owner)
      .then(startRuntime)
      .catch((error: unknown) => {
        if (!isDisposed && isAccountScopeCurrent(owner)) {
          notifications.reportError({
            area: 'queue-recovery',
            message: error instanceof Error ? error.message : String(error),
            namespace: 'queue',
          });
          startRuntime();
        }
      });

    return () => {
      isDisposed = true;
      detachRemoteCanvasResults();
      detachRecoveredRemoteCanvasResults();
      resetCanvasRemotePreviews();
      receiptAcknowledgements?.dispose();
      if (runtime) {
        void runtime.dispose().finally(() => {
          journal?.close();
          recallCache?.close();
        });
      } else {
        journal?.close();
        recallCache?.close();
      }
    };
  });

  return null;
};
