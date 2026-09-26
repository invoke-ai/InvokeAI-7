import { useAuthSession, useCapabilities } from '@features/identity';
import {
  cancelRemoteGeneration,
  expandGalleryRemoteProgressSessions,
  getRemoteOnlyDispatchDisplay,
  getRecoveredRemoteSessions,
  getRemoteQueueProgressItems,
} from '@features/queue';
import { getQueueActiveSessions, getQueueProgressSessions } from '@features/queue/contracts';
import {
  getQueueItemAccess,
  QueueUiProvider,
  useActiveProgressTargets,
  useFollowedProgressTargets,
  useRemoteBridgeSessions,
  type QueueUiAdapter,
} from '@features/queue/react';
import { useWorkbenchPreferences } from '@workbench/settings/store';
import { useNotify } from '@workbench/useNotify';
import { useOpenWorkbenchWidget } from '@workbench/useOpenWorkbenchWidget';
import { useActiveProjectSelector, useWorkbenchSelector } from '@workbench/WorkbenchContext';
import { lazy, useMemo, type ReactNode } from 'react';

const importQueueItemActions = () => import('@workbench/queue-integration/QueueItemActions');
const QueueItemActions = lazy(() => importQueueItemActions().then((module) => ({ default: module.QueueItemActions })));

export const QueueUiAdapterProvider = ({ children }: { children: ReactNode }) => {
  const notify = useNotify();
  const activeProjectId = useActiveProjectSelector((project) => project.id);
  const projectQueueItems = useActiveProjectSelector((project) => project.queue.items);
  const running = useActiveProgressTargets();
  const followed = useFollowedProgressTargets();
  const recovered = useRemoteBridgeSessions();
  const remoteQueueProgressItems = useMemo(() => {
    const active = getQueueActiveSessions(projectQueueItems, running, followed);
    const activeIds = new Set(active.map((session) => session.id));
    const recoveredActive = getRecoveredRemoteSessions(projectQueueItems, activeProjectId, recovered, 'all').filter(
      (session) => !activeIds.has(session.id)
    );
    const sessions = expandGalleryRemoteProgressSessions(
      getQueueProgressSessions(projectQueueItems, [...active, ...recoveredActive]),
      projectQueueItems,
      'all'
    );
    return getRemoteQueueProgressItems(
      projectQueueItems,
      sessions,
      new Set(recoveredActive.map((session) => session.id))
    );
  }, [activeProjectId, projectQueueItems, running, followed, recovered]);
  const { canManageModels } = useCapabilities();
  const session = useAuthSession();
  const { queueJobsScope } = useWorkbenchPreferences();
  const openWorkbenchWidget = useOpenWorkbenchWidget();
  const isConnected = useWorkbenchSelector((snapshot) => snapshot.backendConnection.status === 'connected');
  const adapter = useMemo<QueueUiAdapter>(() => {
    const viewer = {
      currentUserId: session.user?.user_id ?? null,
      isAdmin: session.user?.is_admin === true,
      multiuserEnabled: session.multiuserEnabled,
    };

    return {
      activeProjectId,
      ItemActions: QueueItemActions,
      canManageProcessor: canManageModels,
      canManageItem: (item) => getQueueItemAccess(item, viewer).canManage,
      canViewItemDetails: (item) => getQueueItemAccess(item, viewer).canViewDetails,
      isConnected,
      notify,
      openQueue: () => openWorkbenchWidget('queue'),
      preloadItemActions: () => void importQueueItemActions(),
      queueJobsScope,
      remoteQueueProgressItems,
      getRemoteOnlyDispatchDisplay: (item) => getRemoteOnlyDispatchDisplay(item, projectQueueItems),
      cancelRemoteGeneration: (queueItemId) => {
        if (!remoteQueueProgressItems.some((item) => item.queueItemId === queueItemId)) {
          return Promise.reject(new Error('The remote generation is no longer active in this project.'));
        }
        return cancelRemoteGeneration(queueItemId);
      },
    };
  }, [
    activeProjectId,
    canManageModels,
    isConnected,
    notify,
    openWorkbenchWidget,
    queueJobsScope,
    projectQueueItems,
    remoteQueueProgressItems,
    session,
  ]);

  return <QueueUiProvider adapter={adapter}>{children}</QueueUiProvider>;
};
