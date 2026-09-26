import type { QueueActiveSession, QueueProgressSession } from '@features/queue/contracts';
import type { ReactNode } from 'react';

import {
  getFollowedProgressSession,
  getRemoteProgressIdentity,
  getRemoteProgressTarget,
  parseRemoteProgressMessage,
  getRecoveredRemoteSessions,
  getQueueActiveSessions,
  getQueueProgressSessions,
  isGalleryProgressItem,
} from '@features/queue/contracts';
import {
  useActiveProgressTargets,
  useFollowedProgressTargets,
  useGeneratingRemotePreviewIds,
  useRemoteBridgeSessions,
} from '@features/queue/react';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { createContext, use, useMemo, useState } from 'react';

interface LivePreviewFollow {
  sessions: QueueActiveSession[];
  gallerySessions: QueueProgressSession[];
  pinnedSessionId: string | null;
  /** A deliberate saved Gallery selection temporarily takes priority over live rendering. */
  viewingSaved: boolean;
  /**
   * Shared live target: pinned, then newest-started running session, then first settling session in gallery order,
   * else null.
   */
  followedSessionId: string | null;
  /** Turns live-follow on and pins `sessionId` when a live thumbnail or navigation step is selected. */
  follow(sessionId: string): void;
  pin(sessionId: string): void;
  showAll(): void;
  /** A Gallery click opens saved media without stopping the running generations. */
  showSaved(): void;
}

const LivePreviewFollowContext = createContext<LivePreviewFollow | null>(null);

/** Owned by the mounted Workbench, never persisted with project documents. */
export const LivePreviewFollowProvider = ({ children }: { children: ReactNode }) => {
  const { projectId, items, enabled } = useActiveProjectSelector((project) => ({
    projectId: project.id,
    items: project.queue.items,
    enabled: project.settings.showProgressImagesInViewer,
  }));
  const running = useActiveProgressTargets();
  const followed = useFollowedProgressTargets();
  const recovered = useRemoteBridgeSessions();
  const sessions = useMemo(() => {
    const galleryItems = items.filter(isGalleryProgressItem);
    const active = getQueueActiveSessions(galleryItems, running, followed);
    const activeIds = new Set(active.map((session) => session.id));
    return [
      ...active,
      ...getRecoveredRemoteSessions(galleryItems, projectId, recovered).filter((session) => !activeIds.has(session.id)),
    ];
  }, [items, projectId, running, followed, recovered]);
  const gallerySessions = useMemo(
    () => getQueueProgressSessions(items.filter(isGalleryProgressItem), sessions),
    [items, sessions]
  );
  const [selection, setSelection] = useState<{
    projectId: string;
    sessionId: string | null;
    viewingSaved: boolean;
  }>({
    projectId,
    sessionId: null,
    viewingSaved: false,
  });
  const isStale =
    selection.projectId !== projectId ||
    (!selection.viewingSaved && !enabled) ||
    (selection.viewingSaved && sessions.length === 0) ||
    (selection.sessionId !== null &&
      !sessions.some((session) => session.id === selection.sessionId && session.state === 'running'));
  if (isStale && (selection.sessionId !== null || selection.viewingSaved || selection.projectId !== projectId)) {
    setSelection({ projectId, sessionId: null, viewingSaved: false });
  }
  const viewingSaved = !isStale && selection.viewingSaved;
  const pinnedSessionId = isStale || viewingSaved ? null : selection.sessionId;
  // Follow the newest rendering session; queued remotes remain visible in Gallery/Canvas only.
  const generatingRemoteIds = useGeneratingRemotePreviewIds();
  const recoveredGeneratingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of recovered) {
      const remote = typeof event.message === 'string' ? parseRemoteProgressMessage(event.message) : null;
      if (remote && remote.state === 'running' && remote.message !== `Remote ${remote.slot} queued`) {
        const target = getRemoteProgressTarget(remote.queueItemId, remote.slot, remote.backendItemId);
        ids.add(`${target.queueItemId}:${target.itemIndex}`);
      }
    }
    return ids;
  }, [recovered]);
  const previewSessions = useMemo(
    () =>
      sessions.filter(
        (session) =>
          getRemoteProgressIdentity(session) === null ||
          generatingRemoteIds.has(session.id) ||
          recoveredGeneratingIds.has(session.id)
      ),
    [generatingRemoteIds, recoveredGeneratingIds, sessions]
  );
  const previewGallerySessions = useMemo(
    () =>
      gallerySessions.filter(
        (session) =>
          getRemoteProgressIdentity(session) === null ||
          generatingRemoteIds.has(session.id) ||
          recoveredGeneratingIds.has(session.id)
      ),
    [gallerySessions, generatingRemoteIds, recoveredGeneratingIds]
  );
  const newestRunningSessionId = previewSessions.filter((session) => session.state === 'running').at(-1)?.id ?? null;
  const preferredSessionId = pinnedSessionId ?? newestRunningSessionId;
  const followedSessionId =
    enabled && !viewingSaved
      ? (getFollowedProgressSession(previewGallerySessions, preferredSessionId)?.id ?? null)
      : null;
  const { account } = useWorkbenchCommands();
  const value = useMemo<LivePreviewFollow>(
    () => ({
      sessions,
      gallerySessions,
      pinnedSessionId,
      followedSessionId,
      viewingSaved,
      follow: (sessionId) => {
        account.updateProjectPreferences({ showProgressImagesInViewer: true });
        setSelection({ projectId, sessionId, viewingSaved: false });
      },
      pin: (sessionId) => setSelection({ projectId, sessionId, viewingSaved: false }),
      showAll: () => setSelection({ projectId, sessionId: null, viewingSaved: false }),
      showSaved: () => setSelection({ projectId, sessionId: null, viewingSaved: true }),
    }),
    [account, sessions, gallerySessions, followedSessionId, pinnedSessionId, projectId, viewingSaved]
  );
  return <LivePreviewFollowContext value={value}>{children}</LivePreviewFollowContext>;
};

export const useLivePreviewFollow = (): LivePreviewFollow => {
  const context = use(LivePreviewFollowContext);
  if (!context) {
    throw new Error('Live preview requires its Workbench provider.');
  }
  return context;
};
