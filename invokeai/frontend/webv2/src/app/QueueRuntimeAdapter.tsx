import { invalidateGallery } from '@features/gallery/queries';
import { modelLoadActivitySink } from '@features/models';
import { nodeExecutionStore } from '@features/nodes';
import { createProductionQueueRuntime, createProductionQueueReceiptAcknowledgements } from '@features/queue';
import { createWorkflowRunCaptureSink } from '@features/workflow/queries';
import { ensureInvocationTemplatesLoaded } from '@features/workflow/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { useQueryClient } from '@tanstack/react-query';
import { getOpenProject, getProjectSyncSnapshot } from '@workbench/projects/syncStore';
import {
  createAccountOwnedQueueRecallCache,
  type QueueRecallCache,
} from '@workbench/queue-integration/queueRecallCache';
import { createAccountOwnedQueueRunJournal, type QueueRunJournal } from '@workbench/queue-integration/queueRunJournal';
import { createQueueRunLockPort } from '@workbench/queue-integration/queueRunLocks';
import { withQueueRecallCache } from '@workbench/queue-integration/queueRunPersistence';
import { useWorkbenchCommands, useWorkbenchQueries, useWorkbenchSubscription } from '@workbench/WorkbenchContext';

/** App-owned production composition of Queue, Workbench, Gallery, Workflow, Nodes, and Models adapters. */
export const QueueRuntimeAdapter = () => {
  const { notifications, queue } = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const queryClient = useQueryClient();
  const subscribe = useWorkbenchSubscription();

  useMountEffect(() => {
    const owner = captureAccountScope();
    let isDisposed = false;
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

            // Virtual destinations (date buckets, `generated`/`assets`) cannot hold
            // attachments: the transport no-ops for them, which would otherwise read
            // back as every video failing. The image path ignores this the same way.
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
            // The video transport confirms per item and never throws on non-fatal errors;
            // surface unconfirmed refs so the queue runtime can record the failure instead
            // of leaving the videos silently in Uncategorized (e.g. board deleted mid-run).
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
        // Closes the loop on a library-bound run: its final output becomes the
        // workflow's cover image and stamps `last_run_at` on the record.
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
