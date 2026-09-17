import type { QueueActiveSession, QueueProgressSession } from '@features/queue/contracts';
import type { ReactNode } from 'react';

import { getQueueActiveSessions, getQueueProgressSessions, isGalleryProgressItem } from '@features/queue/contracts';
import { useActiveProgressTargets, useFollowedProgressTargets } from '@features/queue/react';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { createContext, use, useMemo, useState } from 'react';

interface LivePreviewFollow {
  sessions: QueueActiveSession[];
  gallerySessions: QueueProgressSession[];
  pinnedSessionId: string | null;
  pin(sessionId: string): void;
  showAll(): void;
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
  const sessions = useMemo(
    () => getQueueActiveSessions(items.filter(isGalleryProgressItem), running, followed),
    [items, running, followed]
  );
  const gallerySessions = useMemo(
    () => getQueueProgressSessions(items.filter(isGalleryProgressItem), sessions),
    [items, sessions]
  );
  const [selection, setSelection] = useState<{ projectId: string; sessionId: string | null }>({
    projectId,
    sessionId: null,
  });
  const isStale =
    selection.projectId !== projectId ||
    !enabled ||
    (selection.sessionId !== null &&
      !sessions.some((session) => session.id === selection.sessionId && session.state === 'running'));
  if (isStale && (selection.sessionId !== null || selection.projectId !== projectId)) {
    setSelection({ projectId, sessionId: null });
  }
  const pinnedSessionId = isStale ? null : selection.sessionId;
  const value = useMemo<LivePreviewFollow>(
    () => ({
      sessions,
      gallerySessions,
      pinnedSessionId,
      pin: (sessionId) => setSelection({ projectId, sessionId }),
      showAll: () => setSelection({ projectId, sessionId: null }),
    }),
    [sessions, gallerySessions, pinnedSessionId, projectId]
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
