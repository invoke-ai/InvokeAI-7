import type { ProjectGraphState } from '@features/workflow/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { createProjectGraph } from '@features/workflow/utility';
import { accountLifecycle } from '@platform/state/accountLifecycle';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { act, Profiler, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowUiAdapter } from './WorkflowUiContext';

import { workflowLibrarySyncStore } from './library/workflowLibrarySyncStore';
import { WorkflowUiProvider } from './WorkflowUiContext';
import { WorkflowDialogHost } from './WorkflowWidgetChrome';

const deferred = <T,>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
};

// Stub heavy dialog leaves to isolate autosave wiring.
vi.mock('./editor/AddNodeDialog', () => ({ AddNodeDialog: () => null }));
vi.mock('./library/WorkflowLibraryDialog', () => ({ WorkflowLibraryDialog: () => null }));
vi.mock('./PendingLibraryWorkflowLoader', () => ({ PendingWorkflowLoader: () => null }));

import { onWorkflowLibraryCacheInvalidated } from '@features/workflow/queries';

const { updateLibraryWorkflowMock } = vi.hoisted(() => ({ updateLibraryWorkflowMock: vi.fn() }));

vi.mock('@features/workflow/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateLibraryWorkflow: updateLibraryWorkflowMock,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const createMutablePort = <Snapshot,>(initialSnapshot: Snapshot) => {
  let snapshot = initialSnapshot;
  const listeners = new Set<() => void>();
  return {
    port: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setSnapshot: (next: Snapshot) => {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

const createGraphWithDuplicateWorkflowReturns = (): ProjectGraphState => ({
  ...createProjectGraph('workflow-1'),
  libraryWorkflowId: 'library-workflow-1',
  nodes: [
    { data: { type: 'workflow_return' }, id: 'return-1', position: { x: 0, y: 0 }, type: 'invocation' },
    { data: { type: 'workflow_return' }, id: 'return-2', position: { x: 100, y: 0 }, type: 'invocation' },
  ] as unknown as ProjectGraphState['nodes'],
});

/**
 * Exercise real StrictMode cleanup/remount so autosaver creation and disposal share a lifecycle and cannot leave a
 * permanently disposed instance.
 */
describe('WorkflowDialogHost library autosave under StrictMode', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    queryClient = new QueryClient();
    updateLibraryWorkflowMock.mockReset();
    updateLibraryWorkflowMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  it('still autosaves a bound workflow after a graph edit', async () => {
    const cacheInvalidated = vi.fn();
    const stopListening = onWorkflowLibraryCacheInvalidated(cacheInvalidated);

    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited name' },
      });
    });

    // Past the 2s debounce.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );
    // Let the autosaver's save promise settle.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        })
    );

    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);
    expect(updateLibraryWorkflowMock).toHaveBeenCalledWith(
      'library-workflow-1',
      expect.objectContaining({ name: 'Edited name' }),
      expect.any(AbortSignal)
    );
    // The library dialog must not keep serving the pre-save payload.
    expect(cacheInvalidated).toHaveBeenCalledTimes(1);
    stopListening();
  });

  it('rejects an autosave when the graph has duplicate workflow returns', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Invalid duplicate-return edit' },
      });
    });
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );

    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledTimes(1);
  });

  it('does not repeat the duplicate-return autosave notification for every edit', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    const editAndWaitForAutosave = async (name: string) => {
      await act(() => {
        project.setSnapshot({
          ...project.port.getSnapshot(),
          projectGraph: { ...boundGraph, name },
        });
      });
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2100);
          })
      );
    };

    await editAndWaitForAutosave('First invalid edit');
    await editAndWaitForAutosave('Second invalid edit');

    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
  });

  it('does not notify when disposing a pending duplicate-return autosave', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Pending invalid edit' },
      });
    });
    await act(() => root.render(null));

    expect(notifications.error).not.toHaveBeenCalled();
    expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
  });

  it('re-arms duplicate-return notifications after valid saves and deduped reverts', async () => {
    const boundGraph = createGraphWithDuplicateWorkflowReturns();
    const validGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    const waitForAutosave = async () => {
      await act(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2100);
          })
      );
    };

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: { ...boundGraph, name: 'Invalid edit' } });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: validGraph });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: { ...boundGraph, name: 'Invalid again' } });
    });
    await waitForAutosave();

    expect(notifications.error).toHaveBeenCalledTimes(2);

    await act(() => {
      project.setSnapshot({ ...project.port.getSnapshot(), projectGraph: validGraph });
    });
    await waitForAutosave();

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Invalid after revert' },
      });
    });
    await waitForAutosave();

    expect(notifications.error).toHaveBeenCalledTimes(3);
    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);
  });

  /** Notify autosave through the project store subscription without rerendering the dialog host on graph edits. */
  it('schedules an autosave for graph edits made outside React renders', async () => {
    workflowLibrarySyncStore.setSnapshot({ status: 'idle' });

    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    let renderCount = 0;
    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test-only render probe, not app code
    const countRender = () => {
      renderCount += 1;
    };

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <Profiler id="dialog-host" onRender={countRender}>
                  <WorkflowDialogHost />
                </Profiler>
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    // Only the edit dispatched below is under test; the mount itself renders
    // (StrictMode doubles it).
    renderCount = 0;

    // Dispatch directly through the store to test imperative edits without prop-driven rerenders.
    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited outside React' },
      });
    });

    expect(renderCount).toBe(0);
    expect(workflowLibrarySyncStore.getSnapshot().status).toBe('dirty');
  });

  /**
   * Fence status callbacks across account rotation: aborted saves reject after the new account's synchronous idle
   * reset.
   */
  it('does not park a stale save error in the sync store after an account switch', async () => {
    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });

    const request = deferred<void>();

    updateLibraryWorkflowMock.mockReturnValue(request.promise);

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    await act(() => {
      root.render(
        <StrictMode>
          <ChakraProvider value={system}>
            <QueryClientProvider client={queryClient}>
              <WorkflowUiProvider adapter={adapter}>
                <WorkflowDialogHost />
              </WorkflowUiProvider>
            </QueryClientProvider>
          </ChakraProvider>
        </StrictMode>
      );
    });

    await act(() => {
      project.setSnapshot({
        ...project.port.getSnapshot(),
        projectGraph: { ...boundGraph, name: 'Edited before switch' },
      });
    });

    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2100);
        })
    );

    expect(updateLibraryWorkflowMock).toHaveBeenCalledTimes(1);

    try {
      accountLifecycle.activate('workflow-dialog-host-test-account', ':user:workflow-dialog-host-test-account');

      expect(workflowLibrarySyncStore.getSnapshot().status).toBe('idle');

      // Resolve after rotation to exercise scope-check rejection without leaking an error status into the new
      // account.
      await act(async () => {
        request.resolve();
        await request.promise.catch(() => undefined);
        // Give the save's `.then`/`.catch` continuation a turn to run.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(workflowLibrarySyncStore.getSnapshot().status).toBe('idle');
    } finally {
      accountLifecycle.invalidate();
    }
  });

  it('does not flush a pending old-account edit after the account switches', async () => {
    const boundGraph = { ...createProjectGraph('workflow-1'), libraryWorkflowId: 'library-workflow-1' };
    const project = createMutablePort({
      galleryValues: {},
      id: 'project-1',
      isWorkflowRunning: false,
      projectGraph: boundGraph,
      workflowValues: {},
    });
    const notifications = { error: vi.fn(), info: vi.fn(), success: vi.fn() };

    accountLifecycle.activate('workflow-dialog-host-old-account', ':user:workflow-dialog-host-old-account');

    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- intentionally stable for this render lifetime
    const adapter = {
      commands: {
        bindLibraryWorkflow: vi.fn(),
        editGraph: vi.fn(),
        redo: vi.fn(),
        replace: vi.fn(),
        undo: vi.fn(),
      },
      getProjectGraph: () => project.port.getSnapshot().projectGraph,
      notifications,
      project: project.port,
      widgets: { open: vi.fn(), patchValues: vi.fn() },
    } as unknown as WorkflowUiAdapter;

    root = createRoot(host);

    try {
      await act(() => {
        root.render(
          <StrictMode>
            <ChakraProvider value={system}>
              <QueryClientProvider client={queryClient}>
                <WorkflowUiProvider adapter={adapter}>
                  <WorkflowDialogHost />
                </WorkflowUiProvider>
              </QueryClientProvider>
            </ChakraProvider>
          </StrictMode>
        );
      });

      await act(() => {
        project.setSnapshot({
          ...project.port.getSnapshot(),
          projectGraph: { ...boundGraph, name: 'Old account edit' },
        });
      });

      accountLifecycle.activate('workflow-dialog-host-new-account', ':user:workflow-dialog-host-new-account');
      await act(() => root.render(null));
      await Promise.resolve();

      expect(updateLibraryWorkflowMock).not.toHaveBeenCalled();
    } finally {
      accountLifecycle.invalidate();
    }
  });
});
