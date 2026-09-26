import type { QueueItemReadModel } from '@features/queue/core/types';
import type { RemoteOnlyDispatchDisplay } from '@features/queue/data/remoteOnlyDispatchDisplay';
import type { RemoteQueueProgressItem } from '@features/queue/data/remoteWorkersDispatch';

import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

export interface QueueUiNotificationPort {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
  success(title: string, description?: string): void;
}

/** This UI port preserves dependency direction: Queue cannot import Workbench. */
export interface QueueUiAdapter {
  ItemActions: ComponentType<{ item: QueueItemReadModel }>;
  activeProjectId: string | null;
  canManageProcessor: boolean;
  canManageItem(item: QueueItemReadModel): boolean;
  canViewItemDetails(item: QueueItemReadModel): boolean;
  isConnected: boolean;
  notify: QueueUiNotificationPort;
  openQueue(): void;
  /**
   * Warms the `ItemActions` chunk ahead of the first expand. Optional: an
   * adapter that supplies `ItemActions` eagerly has nothing to preload.
   */
  preloadItemActions?(): void;
  queueJobsScope: 'active-project' | 'all';
  /** Browser-account-owned, display-only remotes; never counted as backend items. */
  remoteQueueProgressItems?: RemoteQueueProgressItem[];
  /** Original parameters for our remote-only kickoff, never the serialized graph. */
  getRemoteOnlyDispatchDisplay?(item: QueueItemReadModel): RemoteOnlyDispatchDisplay | null;
  cancelRemoteGeneration?(queueItemId: string): Promise<void>;
}

const QueueUiContext = createContext<QueueUiAdapter | null>(null);

export const QueueUiProvider = ({ adapter, children }: { adapter: QueueUiAdapter; children: ReactNode }) => (
  <QueueUiContext.Provider value={adapter}>{children}</QueueUiContext.Provider>
);

export const useQueueUi = (): QueueUiAdapter => {
  const adapter = useContext(QueueUiContext);

  if (!adapter) {
    throw new Error('Queue UI requires an App-composed QueueUiProvider.');
  }

  return adapter;
};
