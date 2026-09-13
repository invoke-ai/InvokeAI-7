import type { SocketHub } from '@platform/transport/socketHub';
import type { WorkbenchCommands, WorkbenchQueries } from '@workbench/workbenchStore';

import { ensureModelsLoaded, getModelsSnapshot } from '@features/models';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { getProjectWidgetValues } from '@workbench/widgetState';

import { executeRecallParameters } from './executeRecallParameters';
import { isRecallParametersUpdatedEvent } from './recallParameters';

export interface RecallParametersRuntime {
  dispose(): void;
}

/** A raw socket payload with the project that was active when it arrived. */
export interface PendingRecallEvent {
  payload: unknown;
  projectId: string;
}

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Applies `POST /api/v1/recall` updates, delivered as `recall_parameters_updated`
 * socket events, to the project that was active when each event arrived.
 *
 * Events are applied strictly in arrival order: applying one awaits model and
 * image lookups, and an `append` that overlapped an in-flight replace must see
 * the replaced list rather than race it. `replay` events (buffered before this
 * runtime existed) go first.
 */
export const createRecallParametersRuntime = ({
  commands,
  getSessionUserId = () => null,
  hub,
  queries,
  replay = [],
}: {
  commands: Pick<WorkbenchCommands, 'generation' | 'notifications'>;
  /**
   * The signed-in user in multi-user mode, or `null` to accept every event.
   * Admin sockets also receive other users' recall events, which must not
   * rewrite the admin's own panel.
   */
  getSessionUserId?: () => string | null;
  hub: Pick<SocketHub, 'on'>;
  queries: Pick<WorkbenchQueries, 'getProject' | 'getSnapshot'>;
  replay?: readonly PendingRecallEvent[];
}): RecallParametersRuntime => {
  let disposed = false;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = ({ payload, projectId }: PendingRecallEvent) => {
    if (disposed || !isRecallParametersUpdatedEvent(payload)) {
      return;
    }

    const sessionUserId = getSessionUserId();
    if (sessionUserId !== null && payload.user_id !== sessionUserId) {
      return;
    }

    const owner = captureAccountScope();
    const { parameters } = payload;
    const reportError = (error: unknown) => {
      if (!disposed && isAccountScopeCurrent(owner)) {
        commands.notifications.reportError({
          area: 'recall-parameters',
          message: toErrorMessage(error),
          namespace: 'generation',
          projectId,
        });
      }
    };

    chain = chain
      .then(async () => {
        if (disposed || !isAccountScopeCurrent(owner)) {
          return;
        }

        // The models store never rejects; a failed catalog fetch is recorded as
        // its error status, which would otherwise read as "no model selected".
        await ensureModelsLoaded();
        if (disposed || !isAccountScopeCurrent(owner)) {
          return;
        }

        const snapshot = getModelsSnapshot();
        if (snapshot.status === 'error') {
          reportError(snapshot.error ?? 'Failed to load models.');
          return;
        }

        await executeRecallParameters({
          commands,
          getGenerateValues: () => {
            const project = queries.getProject(projectId);
            return project ? getProjectWidgetValues(project, 'generate') : null;
          },
          models: snapshot.models,
          owner,
          parameters,
          projectId,
        });
      })
      // One failing event must not wedge the chain for every later one.
      .catch(reportError);
  };

  for (const pending of replay) {
    enqueue(pending);
  }

  const detach = hub.on('recall_parameters_updated', (payload: unknown) => {
    enqueue({ payload, projectId: queries.getSnapshot().activeProject.id });
  });

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      detach();
    },
  };
};
