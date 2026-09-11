import type { SocketHub } from '@platform/transport/socketHub';
import type { WorkbenchCommands, WorkbenchQueries } from '@workbench/workbenchStore';

import type {
  createRecallParametersRuntime,
  PendingRecallEvent,
  RecallParametersRuntime,
} from './recallParametersRuntime';

interface RecallParametersRuntimeModule {
  createRecallParametersRuntime: typeof createRecallParametersRuntime;
}

/**
 * Keeps the recall runtime, and the gallery and model lookups it needs, out of
 * the editor's boot graph: the runtime module loads on the first recall event,
 * and events that arrive while it loads are handed over in order, each with the
 * project that was active when it arrived. A failed load is reported and the
 * next event retries it.
 */
export const attachRecallParametersRuntime = ({
  commands,
  getSessionUserId,
  hub,
  load = () => import('./recallParametersRuntime'),
  queries,
}: {
  commands: Pick<WorkbenchCommands, 'generation' | 'notifications'>;
  getSessionUserId?: () => string | null;
  hub: Pick<SocketHub, 'on'>;
  load?: () => Promise<RecallParametersRuntimeModule>;
  queries: Pick<WorkbenchQueries, 'getProject' | 'getSnapshot'>;
}): RecallParametersRuntime => {
  let disposed = false;
  let loading: Promise<void> | null = null;
  let runtime: RecallParametersRuntime | null = null;
  const pending: PendingRecallEvent[] = [];

  let detachBuffer: (() => void) | null = hub.on('recall_parameters_updated', (payload: unknown) => {
    pending.push({ payload, projectId: queries.getSnapshot().activeProject.id });
    loading ??= load()
      .then((module) => {
        if (disposed) {
          return;
        }

        // Hand-over and live subscription share one tick, so no event can
        // slip between the buffered ones and the runtime's own listener.
        detachBuffer?.();
        detachBuffer = null;
        runtime = module.createRecallParametersRuntime({
          commands,
          getSessionUserId,
          hub,
          queries,
          replay: pending.splice(0),
        });
      })
      .catch((error: unknown) => {
        loading = null;
        pending.length = 0;

        if (!disposed) {
          commands.notifications.reportError({
            area: 'recall-parameters',
            message: error instanceof Error ? error.message : String(error),
            namespace: 'generation',
            projectId: queries.getSnapshot().activeProject.id,
          });
        }
      });
  });

  return {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      pending.length = 0;
      detachBuffer?.();
      detachBuffer = null;
      runtime?.dispose();
      runtime = null;
    },
  };
};
