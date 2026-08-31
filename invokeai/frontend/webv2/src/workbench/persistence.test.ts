import type { WorkbenchState } from '@workbench/projectContracts';

import { registerImageCluster } from '@features/gallery/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createLocalStorageWorkbenchPersistence,
  hydratePersistedWorkbenchSnapshot,
  serializeWorkbenchPersistenceSnapshot,
} from './persistence';
import { createInitialWorkbenchState, workbenchReducer } from './workbenchState.testing';

const storage = new Map<string, string>();
const localStorageWorkbenchPersistence = createLocalStorageWorkbenchPersistence('');

vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string): string | null => storage.get(key) ?? null,
    removeItem: (key: string): void => {
      storage.delete(key);
    },
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
  },
});

beforeEach(() => {
  storage.clear();
});

describe('workbench persistence migration', () => {
  it('accepts current versioned workbench snapshots', () => {
    const state = createInitialWorkbenchState();
    const snapshot = hydratePersistedWorkbenchSnapshot({ savedAt: '2026-06-09T00:00:00.000Z', state, version: 1 });

    expect(snapshot).toEqual({ savedAt: '2026-06-09T00:00:00.000Z', state, version: 1 });
  });

  it('migrates legacy schemaVersion snapshots to the authoritative version field', () => {
    const state = createInitialWorkbenchState();
    const snapshot = hydratePersistedWorkbenchSnapshot({
      savedAt: '2026-06-09T00:00:00.000Z',
      schemaVersion: 1,
      state,
    });

    expect(snapshot?.version).toBe(1);
    expect(snapshot?.state.projects).toHaveLength(1);
  });

  it('drops legacy error logs from persisted snapshots', () => {
    const state = { ...createInitialWorkbenchState(), errorLog: ['old error'] };
    const snapshot = hydratePersistedWorkbenchSnapshot({ savedAt: '2026-06-09T00:00:00.000Z', state, version: 1 });

    expect(snapshot?.state).not.toHaveProperty('errorLog');
  });

  it('rejects unsupported persistence snapshots', () => {
    expect(hydratePersistedWorkbenchSnapshot({ state: createInitialWorkbenchState(), version: 999 })).toBeNull();
    expect(hydratePersistedWorkbenchSnapshot({ state: { projects: [] }, version: 1 })).toBeNull();
  });

  it('maps the trusted live snapshot to a versioned untrusted storage contract', () => {
    const state = createInitialWorkbenchState();
    const persisted = serializeWorkbenchPersistenceSnapshot({
      savedAt: '2026-06-09T00:00:00.000Z',
      state,
      version: 1,
    });

    expect(persisted).toEqual({ savedAt: '2026-06-09T00:00:00.000Z', state, version: 1 });
    expect(hydratePersistedWorkbenchSnapshot(persisted)?.state).toEqual(state);
  });

  it('does not persist a search only this session can resolve, nor the page it left behind', async () => {
    // The footer paginates the RANKING while a similarity search is on
    // screen, so this page is a rank page. Cluster members live in an
    // in-memory registry the next session cannot read, so the ranking is gone
    // over there — and a rank page read as a board page lands the grid on an
    // unrelated slice.
    const state = createInitialWorkbenchState();
    const project = state.projects[0];
    const galleryEntry = Object.entries(project?.widgetInstances ?? {}).find(
      ([, instance]) => instance.typeId === 'gallery'
    );

    expect(galleryEntry).toBeDefined();

    const [galleryInstanceId, galleryInstance] = galleryEntry!;
    const values = {
      ...galleryInstance.state.values,
      galleryPage: 3,
      paginationMode: 'paginated',
      selectedImagePage: 3,
      selectedImageQuery: {
        boardId: 'none',
        galleryView: 'images',
        imageOrderDir: 'DESC',
        page: 3,
        paginationMode: 'paginated',
        searchTerm: '',
      },
      semanticImageQuery: { clusterId: 'cluster-1', kind: 'cluster', label: 'beaches' },
    };
    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench({
      ...state,
      projects: [
        {
          ...project!,
          widgetInstances: {
            ...project!.widgetInstances,
            [galleryInstanceId]: { ...galleryInstance, state: { ...galleryInstance.state, values } },
          },
        },
      ],
    });
    const persistedValues = snapshot.state.projects[0]?.widgetInstances[galleryInstanceId]?.state.values;

    expect(persistedValues?.semanticImageQuery).toBeNull();
    expect(persistedValues?.galleryPage).toBe(0);
    // The selection's page is stamped from the gallery's, so under a ranking
    // it is a rank page too — dropping only the grid's would leave Preview
    // anchored 180 rows from what the grid shows.
    expect(persistedValues?.selectedImagePage).toBe(0);
    expect((persistedValues?.selectedImageQuery as { page: number } | undefined)?.page).toBe(0);
  });

  it('drops a stored search that no longer parses, and the page it left', async () => {
    // A value that cannot be read back is a search that is gone, whatever
    // kind it claims: the page indexing its results is as stranded as one
    // left by a reference this realm cannot resolve.
    const state = createInitialWorkbenchState();
    const project = state.projects[0];
    const galleryEntry = Object.entries(project?.widgetInstances ?? {}).find(
      ([, instance]) => instance.typeId === 'gallery'
    );
    const [galleryInstanceId, galleryInstance] = galleryEntry!;
    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench({
      ...state,
      projects: [
        {
          ...project!,
          widgetInstances: {
            ...project!.widgetInstances,
            [galleryInstanceId]: {
              ...galleryInstance,
              state: {
                ...galleryInstance.state,
                values: {
                  ...galleryInstance.state.values,
                  galleryPage: 3,
                  paginationMode: 'paginated',
                  semanticImageQuery: { kind: 'text', query: '' },
                },
              },
            },
          },
        },
      ],
    });
    const persistedValues = snapshot.state.projects[0]?.widgetInstances[galleryInstanceId]?.state.values;

    expect(persistedValues?.semanticImageQuery).toBeNull();
    expect(persistedValues?.galleryPage).toBe(0);
  });

  it('drops a session-scoped search on save even while this session can still resolve it', async () => {
    // In the owning session the registry entry is live, so a test of whether
    // the reference resolves would strip nothing — and the realm reading this
    // back cannot resolve it. The save path has to ask what the value IS.
    const clusterId = registerImageCluster(['a.png', 'b.png'], 'beaches');
    const state = createInitialWorkbenchState();
    const project = state.projects[0];
    const galleryEntry = Object.entries(project?.widgetInstances ?? {}).find(
      ([, instance]) => instance.typeId === 'gallery'
    );
    const [galleryInstanceId, galleryInstance] = galleryEntry!;
    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench({
      ...state,
      projects: [
        {
          ...project!,
          widgetInstances: {
            ...project!.widgetInstances,
            [galleryInstanceId]: {
              ...galleryInstance,
              state: {
                ...galleryInstance.state,
                values: {
                  ...galleryInstance.state.values,
                  galleryPage: 3,
                  paginationMode: 'paginated',
                  semanticImageQuery: { clusterId, kind: 'cluster', label: 'beaches' },
                },
              },
            },
          },
        },
      ],
    });
    const persistedValues = snapshot.state.projects[0]?.widgetInstances[galleryInstanceId]?.state.values;

    expect(persistedValues?.semanticImageQuery).toBeNull();
    expect(persistedValues?.galleryPage).toBe(0);
  });

  it('drops an infinite window anchor from the local cache on its own', async () => {
    // The cache is what an offline boot restores from. It has not been
    // through adoption, so the strip here is the only thing between a
    // persisted anchor and a gallery reopened stranded mid-board.
    const state = createInitialWorkbenchState();
    const project = state.projects[0];
    const galleryEntry = Object.entries(project?.widgetInstances ?? {}).find(
      ([, instance]) => instance.typeId === 'gallery'
    );
    const [galleryInstanceId, galleryInstance] = galleryEntry!;
    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench({
      ...state,
      projects: [
        {
          ...project!,
          widgetInstances: {
            ...project!.widgetInstances,
            [galleryInstanceId]: {
              ...galleryInstance,
              state: { ...galleryInstance.state, values: { ...galleryInstance.state.values, galleryPage: 5 } },
            },
          },
        },
      ],
    });
    const persistedValues = snapshot.state.projects[0]?.widgetInstances[galleryInstanceId]?.state.values;

    expect(persistedValues?.galleryPage).toBe(0);
  });

  it('keeps a paginated page whose search survives the reload', async () => {
    // A text search is rebuilt from the persisted value, so the page the user
    // was reading is still a page of the same list.
    const state = createInitialWorkbenchState();
    const project = state.projects[0];
    const galleryEntry = Object.entries(project?.widgetInstances ?? {}).find(
      ([, instance]) => instance.typeId === 'gallery'
    );
    const [galleryInstanceId, galleryInstance] = galleryEntry!;
    const values = {
      ...galleryInstance.state.values,
      galleryPage: 3,
      paginationMode: 'paginated',
      semanticImageQuery: { kind: 'text', query: 'sunset' },
    };
    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench({
      ...state,
      projects: [
        {
          ...project!,
          widgetInstances: {
            ...project!.widgetInstances,
            [galleryInstanceId]: { ...galleryInstance, state: { ...galleryInstance.state, values } },
          },
        },
      ],
    });
    const persistedValues = snapshot.state.projects[0]?.widgetInstances[galleryInstanceId]?.state.values;

    expect(persistedValues?.semanticImageQuery).toEqual({ kind: 'text', query: 'sunset' });
    expect(persistedValues?.galleryPage).toBe(3);
  });

  it('drops corrupt localStorage snapshots instead of throwing', async () => {
    storage.set('invokeai:v7:webv2:workbench', '{not json');

    await expect(localStorageWorkbenchPersistence.loadWorkbench()).resolves.toBeNull();
    expect(storage.has('invokeai:v7:webv2:workbench')).toBe(false);
  });

  it('does not persist transient toast notifications', async () => {
    const state = workbenchReducer(createInitialWorkbenchState(), {
      kind: 'success',
      message: 'Old toast',
      title: 'Saved before reload',
      type: 'recordNotice',
    });

    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench(state);

    expect(state.notifications).toHaveLength(1);
    expect(snapshot.state.notifications).toEqual([]);

    const raw = storage.get('invokeai:v7:webv2:workbench');
    const persisted = JSON.parse(raw ?? 'null') as { state: { notifications: unknown[] } };

    expect(persisted.state.notifications).toEqual([]);
  });

  it('persists empty project undo and redo stacks and normalizes legacy cache entries', async () => {
    let state = createInitialWorkbenchState();
    state = workbenchReducer(state, {
      sourceId: 'workflow',
      type: 'setInvocationSource',
    });
    expect(state.projects[0]?.undoRedo.past.length).toBeGreaterThan(0);

    const snapshot = await localStorageWorkbenchPersistence.saveWorkbench(state);
    expect(snapshot.state.projects[0]?.undoRedo).toEqual({ future: [], past: [] });

    const raw = storage.get('invokeai:v7:webv2:workbench');
    const hydrated = await localStorageWorkbenchPersistence.loadWorkbench();

    expect(raw).toBeDefined();
    expect(hydrated?.state.projects[0]?.undoRedo).toEqual({ future: [], past: [] });
  });

  it('treats localStorage quota failures as cache misses, not save failures', async () => {
    const originalSet = window.localStorage.setItem;

    try {
      window.localStorage.setItem = (key: string, value: string): void => {
        if (key === 'invokeai:v7:webv2:workbench') {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }

        originalSet.call(window.localStorage, key, value);
      };

      await expect(
        localStorageWorkbenchPersistence.saveWorkbench(createInitialWorkbenchState())
      ).resolves.toMatchObject({
        version: 1,
      });
    } finally {
      window.localStorage.setItem = originalSet;
    }
  });

  it('still attempts localStorage cache writes for large open workflow projects', async () => {
    const state = createInitialWorkbenchState();
    const project = state.projects[0]!;
    const largeState = {
      ...state,
      projects: [
        {
          ...project,
          projectGraph: {
            ...project.projectGraph,
            nodes: Array.from({ length: 300 }, (_, index) => ({
              data: { label: '', notes: '' },
              id: `node-${index}`,
              position: { x: 0, y: 0 },
              type: 'notes' as const,
            })),
          },
        },
      ],
    };

    await localStorageWorkbenchPersistence.saveWorkbench(largeState);

    expect(storage.has('invokeai:v7:webv2:workbench')).toBe(true);
  });

  it('keeps each constructed persistence adapter bound to its immutable account bucket', async () => {
    const accountA = createLocalStorageWorkbenchPersistence(':user:a');
    const accountB = createLocalStorageWorkbenchPersistence(':user:b');
    const stateA = createInitialWorkbenchState();
    const stateB = createInitialWorkbenchState();

    stateA.projects[0]!.name = 'Account A';
    stateB.projects[0]!.name = 'Account B';

    await accountA.saveWorkbench(stateA);
    await accountB.saveWorkbench(stateB);

    // This late A write still targets A even though B's adapter was constructed
    // and used in between.
    stateA.projects[0]!.name = 'Account A late save';
    await accountA.saveWorkbench(stateA);

    const persistedA = JSON.parse(storage.get('invokeai:v7:webv2:workbench:user:a') ?? 'null') as {
      state: WorkbenchState;
    };
    const persistedB = JSON.parse(storage.get('invokeai:v7:webv2:workbench:user:b') ?? 'null') as {
      state: WorkbenchState;
    };

    expect(persistedA.state.projects[0]?.name).toBe('Account A late save');
    expect(persistedB.state.projects[0]?.name).toBe('Account B');
  });
});
