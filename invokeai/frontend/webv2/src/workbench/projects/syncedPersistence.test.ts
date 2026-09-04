import type * as accountLifecycleModule from '@platform/state/accountLifecycle';
import type { Project, WorkbenchState } from '@workbench/projectContracts';

import { createWorkbenchPersistenceRuntime, type PersistenceClock } from '@workbench/persistenceRuntime';
import {
  createDraftProject,
  createInitialWorkbenchState,
  normalizeWorkbenchAccount,
  withAuthoritativeProjectBoard,
} from '@workbench/workbenchState';
import { createWorkbenchStore } from '@workbench/workbenchStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as libraryModule from './library';
import type * as persistenceModule from './syncedPersistence';

/**
 * Service-level tests for the library/session split: the open set drives
 * hydration, saving never deletes, and explicit deletes cannot be undone by
 * racing autosaves. The REST module is replaced by an in-memory server.
 */

const api = vi.hoisted(() => {
  interface MockRecord {
    project_id: string;
    /** Every project owns one, and the server is the only thing that decides which. */
    board_id: string;
    name: string;
    revision: number;
    minimum_canvas_schema_version: number;
    created_at: string;
    updated_at: string;
    data: Record<string, unknown>;
  }

  const records = new Map<string, MockRecord>();
  const clientState = new Map<string, string>();

  const conflictError = (): Error => Object.assign(new Error('conflict'), { __status: 409 });
  const notFoundError = (): Error => Object.assign(new Error('not found'), { __status: 404 });
  const schemaError = (minimum: number, maximum: number): Error =>
    Object.assign(new Error('unsupported schema'), { __maximum: maximum, __minimum: minimum });
  const toSummary = (record: MockRecord) => ({
    board_id: record.board_id,
    created_at: record.created_at,
    name: record.name,
    minimum_canvas_schema_version: record.minimum_canvas_schema_version,
    project_id: record.project_id,
    revision: record.revision,
    updated_at: record.updated_at,
  });
  const clone = (record: MockRecord): MockRecord => structuredClone(record);

  const mock = {
    __clientState: clientState,
    __records: records,
    __schemaError: schemaError,
    __seed: (data: Record<string, unknown>): void => {
      const id = data.id as string;

      records.set(id, {
        board_id: `board-for-${id}`,
        created_at: '2026-06-10 08:00:00.000',
        data: structuredClone(data),
        name: data.name as string,
        minimum_canvas_schema_version: 3,
        project_id: id,
        revision: 1,
        updated_at: '2026-06-10 08:00:00.000',
      });
    },
    createProject: vi.fn(
      (request: {
        project_id?: string;
        board_id?: string;
        name: string;
        data: Record<string, unknown>;
        minimum_canvas_schema_version?: number;
      }) => {
        const id = request.project_id ?? `generated-${records.size}`;

        if (records.has(id)) {
          return Promise.reject(conflictError());
        }

        const record: MockRecord = {
          board_id: request.board_id ?? `board-for-${id}`,
          created_at: '2026-06-10 09:00:00.000',
          data: structuredClone(request.data),
          name: request.name,
          minimum_canvas_schema_version: request.minimum_canvas_schema_version ?? 2,
          project_id: id,
          revision: 1,
          updated_at: '2026-06-10 09:00:00.000',
        };

        records.set(id, record);

        return Promise.resolve(clone(record));
      }
    ),
    deleteClientStateValue: vi.fn((key: string) => {
      clientState.delete(key);

      return Promise.resolve();
    }),
    deleteProject: vi.fn((projectId: string) => {
      records.delete(projectId);

      return Promise.resolve();
    }),
    getClientStateValue: vi.fn((key: string) => Promise.resolve(clientState.get(key) ?? null)),
    getProjectCanvasSchemaCompatibilityRefusal: (error: unknown) => {
      const refusal = error as { __maximum?: number; __minimum?: number };

      return refusal.__minimum === undefined || refusal.__maximum === undefined
        ? null
        : {
            maxCanvasSchemaVersion: refusal.__maximum,
            minimumCanvasSchemaVersion: refusal.__minimum,
          };
    },
    getProject: vi.fn((projectId: string) => {
      const record = records.get(projectId);

      return record ? Promise.resolve(clone(record)) : Promise.reject(notFoundError());
    }),
    isProjectConflictError: (error: unknown): boolean => (error as { __status?: number }).__status === 409,
    isProjectNotFoundError: (error: unknown): boolean => (error as { __status?: number }).__status === 404,
    listProjects: vi.fn(() => Promise.resolve([...records.values()].map(toSummary))),
    setClientStateValue: vi.fn((key: string, value: string) => {
      clientState.set(key, value);

      return Promise.resolve();
    }),
    updateProject: vi.fn(
      (
        projectId: string,
        request: {
          name: string;
          data: Record<string, unknown>;
          expected_revision: number;
          minimum_canvas_schema_version?: number;
        }
      ) => {
        const record = records.get(projectId);

        if (!record) {
          return Promise.reject(notFoundError());
        }

        if (record.revision !== request.expected_revision) {
          return Promise.reject(conflictError());
        }

        const updated: MockRecord = {
          ...record,
          data: structuredClone(request.data),
          minimum_canvas_schema_version: Math.max(
            record.minimum_canvas_schema_version,
            request.minimum_canvas_schema_version ?? record.minimum_canvas_schema_version
          ),
          name: request.name,
          revision: record.revision + 1,
          updated_at: '2026-06-10 10:00:00.000',
        };

        records.set(projectId, updated);

        return Promise.resolve(clone(updated));
      }
    ),
  };

  return mock;
});

vi.mock('./api', () => api);

const storage = new Map<string, string>();

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, reject, resolve };
};

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

const SESSION_KEY = 'webv2:workbench-account';

let persistence: typeof persistenceModule;
let library: typeof libraryModule;
let account: typeof accountLifecycleModule;
let service: persistenceModule.SyncedWorkbenchPersistence;
const defaultUpdateProject = api.updateProject.getMockImplementation()!;
const defaultSetClientStateValue = api.setClientStateValue.getMockImplementation()!;

const seedSessionBlob = (blob: Record<string, unknown>): void => {
  api.__clientState.set(SESSION_KEY, JSON.stringify(blob));
};

const seedServerProject = (name: string): Project => {
  const draft = { ...createDraftProject([]), name };

  api.__seed(persistence.serializeProjectDocument(draft));

  return draft;
};

const openServerProject = async (projectId: string): Promise<Project> => {
  const result = await service.hydrateProjectFromServer(projectId);

  if (result.status !== 'loaded') {
    throw new Error(`Expected "${projectId}" to load, got ${result.status}.`);
  }

  return result.project;
};

const stateWithProjects = (projects: Project[], activeProjectId = projects[0]?.id ?? ''): WorkbenchState => ({
  ...createInitialWorkbenchState(),
  activeProjectId,
  projects,
});

const setPersistedCanvasSchemaFloor = (projectId: string, floor: number): void => {
  const key = 'invokeai:v7:webv2:workbench-sync';
  const persisted = JSON.parse(storage.get(key) ?? '{}') as {
    minimumCanvasSchemaVersions?: Record<string, number>;
  };

  storage.set(
    key,
    JSON.stringify({
      ...persisted,
      minimumCanvasSchemaVersions: { ...persisted.minimumCanvasSchemaVersions, [projectId]: floor },
    })
  );
};

beforeEach(async () => {
  vi.resetModules();
  api.__records.clear();
  api.__clientState.clear();
  storage.clear();
  api.createProject.mockClear();
  api.deleteProject.mockClear();
  api.getProject.mockClear();
  api.listProjects.mockClear();
  api.updateProject.mockReset();
  api.updateProject.mockImplementation(defaultUpdateProject);
  api.setClientStateValue.mockReset();
  api.setClientStateValue.mockImplementation(defaultSetClientStateValue);

  account = await import('@platform/state/accountLifecycle');
  account.accountLifecycle.activate('single-user', '');
  persistence = await import('./syncedPersistence');
  service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
  library = await import('./library');
});

describe('loadWorkbench session hydration', () => {
  it('constructs isolated synchronization lifetimes instead of sharing pending state', async () => {
    const first = persistence.createSyncedWorkbenchPersistence();
    const second = persistence.createSyncedWorkbenchPersistence();
    api.listProjects.mockRejectedValueOnce(new Error('offline'));

    await first.loadWorkbench();

    expect(first.hasPendingChanges()).toBe(true);
    expect(second.hasPendingChanges()).toBe(false);
  });

  it('shares one backend import across StrictMode-style load replays', async () => {
    const state = createInitialWorkbenchState();
    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 })
    );

    const [first, replay] = await Promise.all([service.loadWorkbench(), service.loadWorkbench()]);

    expect(replay).toBe(first);
    expect(api.listProjects).toHaveBeenCalledTimes(1);
    expect(api.createProject).toHaveBeenCalledTimes(state.projects.length);
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('preserves both projects when a first-contact create collides with different server data', async () => {
    const state = createInitialWorkbenchState();
    const local = { ...state.projects[0]!, name: 'Local edit' };

    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state: stateWithProjects([local]), version: 1 })
    );
    api.createProject.mockImplementationOnce(() => {
      const server = { ...local, name: 'Racing server edit' };

      api.__seed(persistence.serializeProjectDocument(server));

      return Promise.reject(Object.assign(new Error('conflict'), { __status: 409 }));
    });

    const snapshot = await service.loadWorkbench();
    const recoveredRecord = [...api.__records.values()].find((record) => record.project_id !== local.id);

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.__records.get(local.id)).toMatchObject({ name: 'Racing server edit', revision: 1 });
    expect(recoveredRecord?.data).toMatchObject({ name: 'Local edit (recovered)', recoveryOf: local.id });
    expect(snapshot?.state.projects).toMatchObject([
      { id: local.id, name: 'Racing server edit' },
      { name: 'Local edit (recovered)', recoveryOf: local.id },
    ]);
  });

  it('retains local bytes when a first-contact create collision reveals a newer schema floor', async () => {
    const state = createInitialWorkbenchState();
    const local = { ...state.projects[0]!, name: 'Local work that must survive' };

    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state: stateWithProjects([local]), version: 1 })
    );
    api.createProject.mockImplementationOnce(() => {
      api.__seed(persistence.serializeProjectDocument({ ...local, name: 'Newer server project' }));
      api.__records.get(local.id)!.minimum_canvas_schema_version = 4;

      return Promise.reject(Object.assign(new Error('conflict'), { __status: 409 }));
    });
    api.getProject.mockRejectedValueOnce(api.__schemaError(4, 3));

    const snapshot = await service.loadWorkbench();
    const recoveredRecord = [...api.__records.values()].find((record) => record.project_id !== local.id);

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.__records.get(local.id)).toMatchObject({
      minimum_canvas_schema_version: 4,
      name: 'Newer server project',
    });
    expect(recoveredRecord?.data).toMatchObject({
      name: 'Local work that must survive (recovered)',
      recoveryOf: local.id,
    });
    expect(snapshot?.state.projects).toMatchObject([
      { name: 'Local work that must survive (recovered)', recoveryOf: local.id },
    ]);
  });

  it('honors a new-project request while importing legacy local projects', async () => {
    const state = createInitialWorkbenchState();
    const existingProjectId = state.activeProjectId;
    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 })
    );

    const snapshot = await service.loadWorkbench({ createNew: true });

    expect(snapshot?.state.projects).toHaveLength(state.projects.length + 1);
    expect(snapshot?.state.activeProjectId).not.toBe(existingProjectId);
    expect(service.hasPendingChanges()).toBe(true);
  });

  it('keeps the server account while importing legacy local projects', async () => {
    const local = createInitialWorkbenchState();
    const serverAccount = {
      ...local.account,
      layoutPresetMetadataOverrides: { compose: { label: 'Writing' } },
      layoutPresetRouteOverrides: { compose: { destination: 'canvas' as const, sourceId: 'upscale' as const } },
    };
    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state: local, version: 1 })
    );
    seedSessionBlob({ account: serverAccount, activeProjectId: '', openProjectIds: [] });

    const snapshot = await service.loadWorkbench({ createNew: true });

    expect(snapshot?.state.account).toMatchObject(serverAccount);
    expect(
      snapshot?.state.projects.find((project) => project.id === snapshot.state.activeProjectId)?.invocation
    ).toMatchObject({
      destination: 'canvas',
      sourceId: 'upscale',
    });
  });

  it('hydrates only the open set and seeds the full library', async () => {
    const first = seedServerProject('First');
    const second = seedServerProject('Second');
    const third = seedServerProject('Third');
    const account = normalizeWorkbenchAccount(createInitialWorkbenchState().account);

    seedSessionBlob({ account, activeProjectId: second.id, openProjectIds: [second.id] });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects.map((project) => project.id)).toEqual([second.id]);
    expect(snapshot?.state.activeProjectId).toBe(second.id);
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(service.hasPendingChanges()).toBe(false);

    const libraryIds = library.getProjectLibrary().summaries.map((summary) => summary.id);

    expect(libraryIds).toHaveLength(3);
    expect(libraryIds).toEqual(expect.arrayContaining([first.id, second.id, third.id]));
  });

  it('keeps the cached project when listing succeeds but its document GET is temporarily unavailable', async () => {
    const project = seedServerProject('Cached project');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();

    const reloaded = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());

    api.getProject.mockRejectedValueOnce(new Error('temporary read failure'));

    const snapshot = await reloaded.loadWorkbench();

    expect(snapshot?.state.projects).toMatchObject([{ id: project.id, name: 'Cached project' }]);
    expect(reloaded.hasPendingChanges()).toBe(true);
  });

  it('accepts a list/GET deletion race when the cached project has no pending edits', async () => {
    const project = seedServerProject('Deleted during load');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();

    const reloaded = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());

    api.getProject.mockImplementationOnce(() => {
      api.__records.delete(project.id);

      return Promise.reject(Object.assign(new Error('not found'), { __status: 404 }));
    });
    const snapshot = await reloaded.loadWorkbench();

    expect(snapshot?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(library.getProjectLibrary().summaries.some((summary) => summary.id === project.id)).toBe(false);
  });

  it('does not replace the cache when server revision metadata cannot be persisted', async () => {
    const project = seedServerProject('Cached revision');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();
    api.__records.set(project.id, {
      ...api.__records.get(project.id)!,
      data: persistence.serializeProjectDocument({ ...project, name: 'New server revision' }),
      name: 'New server revision',
      revision: 2,
    });
    const primaryBefore = storage.get('invokeai:v7:webv2:workbench');
    const reloaded = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.includes('workbench-sync')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    let snapshot;

    try {
      snapshot = await reloaded.loadWorkbench();
    } finally {
      setItem.mockRestore();
    }

    expect(storage.get('invokeai:v7:webv2:workbench')).toBe(primaryBefore);
    expect(snapshot?.state.projects).toMatchObject([{ id: project.id, name: 'Cached revision' }]);
  });

  it('opens every project for sessions from before the split (no open set in the blob)', async () => {
    seedServerProject('First');
    seedServerProject('Second');

    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: 'missing' });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects).toHaveLength(2);
  });

  it('ignores a corrupt local cache and still hydrates from the backend', async () => {
    seedServerProject('Backend Project');
    storage.set('invokeai:v7:webv2:workbench', '{not json');

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects.map((project) => project.name)).toEqual(['Backend Project']);
  });

  it('boots a fresh draft when the session is empty', async () => {
    const existing = seedServerProject('Closed project');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: '', openProjectIds: [] });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects).toHaveLength(1);
    expect(snapshot?.state.projects[0].id).not.toBe(existing.id);
    expect(snapshot?.state.activeProjectId).toBe(snapshot?.state.projects[0].id);
    expect(service.hasPendingChanges()).toBe(true);
  });

  it('normalizes malformed account preset data before creating an empty-session draft', async () => {
    const account = {
      ...createInitialWorkbenchState().account,
      layoutPresetOverrides: { compose: { malformed: true } },
    };

    seedSessionBlob({ account, activeProjectId: '', openProjectIds: [] });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects).toHaveLength(1);
    expect(snapshot?.state.account.layoutPresetOverrides).toEqual({});
    expect(snapshot?.state.projects[0]?.layout.presetId).toBe('compose');
    expect(snapshot?.state.projects[0]?.invocation).toMatchObject({ destination: 'gallery', sourceId: 'generate' });
  });

  it('joins a deep-linked project into the open set and focuses it', async () => {
    const first = seedServerProject('First');
    const second = seedServerProject('Second');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: first.id, openProjectIds: [first.id] });

    const snapshot = await service.loadWorkbench({ openProjectId: second.id });

    expect(snapshot?.state.projects.map((project) => project.id)).toEqual([first.id, second.id]);
    expect(snapshot?.state.activeProjectId).toBe(second.id);
    expect(service.hasPendingChanges()).toBe(true);
  });

  it('appends and activates a draft when a new project is requested', async () => {
    const first = seedServerProject('First');
    const account = {
      ...createInitialWorkbenchState().account,
      layoutPresetRouteOverrides: {
        compose: { destination: 'canvas' as const, sourceId: 'upscale' as const },
      },
    };

    seedSessionBlob({ account, activeProjectId: first.id, openProjectIds: [first.id] });

    const snapshot = await service.loadWorkbench({ createNew: true });

    expect(snapshot?.state.projects).toHaveLength(2);
    expect(snapshot?.state.activeProjectId).not.toBe(first.id);
    expect(
      snapshot?.state.projects.find((project) => project.id === snapshot.state.activeProjectId)?.invocation
    ).toMatchObject({ destination: 'canvas', sourceId: 'upscale' });
    expect(service.hasPendingChanges()).toBe(true);
  });

  it('still starts a draft for a new-project request when the backend is unreachable', async () => {
    const initial = createInitialWorkbenchState();
    const state: WorkbenchState = {
      ...initial,
      account: {
        ...initial.account,
        layoutPresetRouteOverrides: {
          compose: { destination: 'canvas', sourceId: 'upscale' },
        },
      },
    };
    const cachedProjectId = state.projects[0]?.id ?? '';

    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 })
    );
    api.listProjects.mockRejectedValueOnce(new Error('offline'));

    const snapshot = await service.loadWorkbench({ createNew: true });

    // Returning the cache verbatim here used to reopen whichever project was
    // last active, so an offline "New project" landed the user in existing work
    // — and let the Launchpad's intent rearrange it.
    expect(snapshot?.state.projects).toHaveLength(state.projects.length + 1);
    expect(snapshot?.state.activeProjectId).not.toBe(cachedProjectId);
    expect(
      snapshot?.state.projects.find((project) => project.id === snapshot.state.activeProjectId)?.invocation
    ).toMatchObject({ destination: 'canvas', sourceId: 'upscale' });
  });

  it('starts an account-resolved draft from an empty offline session', async () => {
    const initial = createInitialWorkbenchState();
    const state: WorkbenchState = {
      ...initial,
      account: {
        ...initial.account,
        layoutPresetRouteOverrides: {
          compose: { destination: 'canvas', sourceId: 'upscale' },
        },
      },
      activeProjectId: '',
      projects: [],
    };

    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 })
    );
    api.listProjects.mockRejectedValueOnce(new Error('offline'));

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects).toHaveLength(1);
    expect(snapshot?.state.projects[0]?.invocation).toMatchObject({ destination: 'canvas', sourceId: 'upscale' });
  });

  it('reopens the cached session when the backend is unreachable and no draft was requested', async () => {
    const state = createInitialWorkbenchState();

    storage.set(
      'invokeai:v7:webv2:workbench',
      JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 })
    );
    api.listProjects.mockRejectedValueOnce(new Error('offline'));

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects).toHaveLength(state.projects.length);
    expect(snapshot?.state.activeProjectId).toBe(state.activeProjectId);
  });
});

describe('saveWorkbench', () => {
  it('replays a cached offline edit after a full reload when the server revision is unchanged', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });

    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));

    const reconnected = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await reconnected.loadWorkbench();

    expect(replay?.state.projects).toMatchObject([{ id: project.id, name: 'Edited offline' }]);
    expect(reconnected.hasPendingChanges()).toBe(true);

    await reconnected.saveWorkbench(replay!.state);

    expect(api.__records.get(project.id)).toMatchObject({ name: 'Edited offline', revision: 2 });
  });

  it('reconciles a pending cached project omitted by the stale server open set', async () => {
    const first = seedServerProject('First');
    const second = seedServerProject('Second');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: first.id,
      openProjectIds: [first.id],
    });
    const loaded = await service.loadWorkbench();
    const secondLoad = await service.hydrateProjectFromServer(second.id, second.name);

    expect(secondLoad.status).toBe('loaded');
    if (secondLoad.status !== 'loaded') {
      throw new Error('Expected the second project to load.');
    }

    const editedSecond = { ...secondLoad.project, name: 'Second edited offline' };
    api.setClientStateValue.mockRejectedValueOnce(new Error('session offline'));
    api.updateProject.mockImplementation((projectId, request) =>
      projectId === second.id ? Promise.reject(new Error('project offline')) : defaultUpdateProject(projectId, request)
    );
    await service.saveWorkbench(stateWithProjects([loaded!.state.projects[0]!, editedSecond]));

    const restarted = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await restarted.loadWorkbench();

    expect(replay?.state.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, name: 'First' }),
        expect.objectContaining({ id: second.id, name: 'Second edited offline' }),
      ])
    );
    expect(restarted.hasPendingChanges()).toBe(true);
  });

  it('forks a cached offline edit after a full reload when the server revision also advanced', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });

    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));
    setPersistedCanvasSchemaFloor(project.id, 4);

    const server = api.__records.get(project.id)!;

    api.__records.set(project.id, {
      ...server,
      data: persistence.serializeProjectDocument({ ...project, name: 'Edited remotely' }),
      name: 'Edited remotely',
      revision: server.revision + 1,
    });

    const reconnected = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await reconnected.loadWorkbench();

    expect(replay?.state.projects).toHaveLength(2);
    expect(replay?.state.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: project.id, name: 'Edited remotely' }),
        expect.objectContaining({ name: 'Edited offline (recovered)', recoveryOf: project.id }),
      ])
    );

    await reconnected.saveWorkbench(replay!.state);

    expect(api.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4 }),
      expect.any(AbortSignal)
    );
    expect([...api.__records.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project_id: project.id, name: 'Edited remotely' }),
        expect.objectContaining({ data: expect.objectContaining({ recoveryOf: project.id }) }),
      ])
    );
  });

  it('inherits a winning server floor raised between boot list and hydration', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });

    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));

    const serverRecord = api.__records.get(project.id)!;
    api.__records.set(project.id, {
      ...serverRecord,
      data: persistence.serializeProjectDocument({ ...project, name: 'Edited remotely' }),
      name: 'Edited remotely',
      revision: serverRecord.revision + 1,
    });
    const listProjects = api.listProjects.getMockImplementation()!;
    api.listProjects.mockImplementationOnce(async () => {
      const summaries = await listProjects();

      api.__records.get(project.id)!.minimum_canvas_schema_version = 4;

      return summaries;
    });

    const reconnected = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await reconnected.loadWorkbench();

    await reconnected.saveWorkbench(replay!.state);

    expect(api.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4 }),
      expect.any(AbortSignal)
    );
  });

  it('retains an offline edit if reconnect crashes between recovery metadata and cache writes', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));
    const server = api.__records.get(project.id)!;
    api.__records.set(project.id, {
      ...server,
      data: persistence.serializeProjectDocument({ ...project, name: 'Edited remotely' }),
      name: 'Edited remotely',
      revision: server.revision + 1,
    });

    const primaryKey = 'invokeai:v7:webv2:workbench';
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === primaryKey) {
        throw new DOMException('crash before cache commit', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    try {
      const interrupted = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
      await interrupted.loadWorkbench();
    } finally {
      setItem.mockRestore();
    }

    const restarted = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await restarted.loadWorkbench();

    expect(replay?.state.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: project.id, name: 'Edited remotely' }),
        expect.objectContaining({ name: 'Edited offline (recovered)', recoveryOf: project.id }),
      ])
    );
  });

  it('keeps the retained floor when an offline edit is recovered after remote deletion', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });

    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));
    setPersistedCanvasSchemaFloor(project.id, 4);
    api.__records.delete(project.id);

    const reconnected = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const syncKey = 'invokeai:v7:webv2:workbench-sync';
    const primaryKey = 'invokeai:v7:webv2:workbench';
    let recoveryCacheCommitted = false;
    let finalSyncWriteFailed = false;
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === syncKey && recoveryCacheCommitted && !finalSyncWriteFailed) {
        finalSyncWriteFailed = true;
        throw new DOMException('crash after cache commit', 'QuotaExceededError');
      }
      storage.set(key, value);
      if (key === primaryKey) {
        recoveryCacheCommitted = true;
      }
    });
    let replay;

    try {
      replay = await reconnected.loadWorkbench();
    } finally {
      setItem.mockRestore();
    }

    expect(replay?.state.projects).toMatchObject([{ name: 'Edited offline (recovered)', recoveryOf: project.id }]);
    expect(finalSyncWriteFailed).toBe(true);

    // Crash/reload once more before the first recovery uploads. Its inherited floor lives only in
    // the pending-floor map and must survive another fresh-id recovery.
    const restartedAgain = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replayAgain = await restartedAgain.loadWorkbench();

    await restartedAgain.saveWorkbench(replayAgain!.state);

    expect(api.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4 }),
      expect.any(AbortSignal)
    );
    expect(api.__records.has(project.id)).toBe(false);
  });

  it('retains a generic offline edit when reconnect reveals a newer schema floor', async () => {
    const project = seedServerProject('Original');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });

    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited offline' };

    api.updateProject.mockRejectedValueOnce(new Error('offline'));
    await service.saveWorkbench(stateWithProjects([edited]));

    api.__records.get(project.id)!.minimum_canvas_schema_version = 4;

    const reconnected = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const replay = await reconnected.loadWorkbench();
    const retained = JSON.parse(storage.get('invokeai:v7:webv2:workbench:refused-projects')!) as Record<
      string,
      Record<string, unknown>
    >;

    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(replay?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
    expect(retained[project.id]).toMatchObject({ id: project.id, name: 'Edited offline' });
  });

  it('cancels an account-A save queued behind the mutation microtask before it can touch account B', async () => {
    const ownerA = account.accountLifecycle.activate('user-a', ':user:a');
    const accountAService = persistence.createSyncedWorkbenchPersistence(ownerA);
    const stateA = createInitialWorkbenchState();

    stateA.projects[0]!.name = 'Account A queued edit';
    const queuedSave = accountAService.saveWorkbench(stateA);

    account.accountLifecycle.activate('user-b', ':user:b');

    await expect(queuedSave).rejects.toHaveProperty('name', 'AccountScopeExpiredError');
    expect(storage.has('invokeai:v7:webv2:workbench:user:a')).toBe(false);
    expect(storage.has('invokeai:v7:webv2:workbench:user:b')).toBe(false);
    expect(api.setClientStateValue).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('stops an in-flight account-A save before the next backend request after account B activates', async () => {
    const ownerA = account.accountLifecycle.activate('user-a', ':user:a');
    const accountAService = persistence.createSyncedWorkbenchPersistence(ownerA);
    const stateA = createInitialWorkbenchState();
    const sessionWrite = deferred<void>();

    stateA.projects[0]!.name = 'Account A in-flight edit';
    api.setClientStateValue.mockImplementationOnce(() => sessionWrite.promise);

    const inFlightSave = accountAService.saveWorkbench(stateA);

    await vi.waitFor(() => expect(api.setClientStateValue).toHaveBeenCalledOnce());
    expect(storage.has('invokeai:v7:webv2:workbench:user:a')).toBe(true);

    account.accountLifecycle.activate('user-b', ':user:b');
    sessionWrite.resolve();

    await expect(inFlightSave).rejects.toHaveProperty('name', 'AccountScopeExpiredError');
    expect(storage.has('invokeai:v7:webv2:workbench:user:b')).toBe(false);
    // The already-started client-state request belonged to A. Its late
    // completion must not advance the chain to a project create under B.
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('serializes concurrent saves against the latest acknowledged project revision', async () => {
    const project = seedServerProject('Original');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: project.id, openProjectIds: [project.id] });

    const loaded = await service.loadWorkbench();
    const original = loaded!.state.projects[0]!;
    const firstState = stateWithProjects([{ ...original, name: 'First edit' }]);
    const latestState = stateWithProjects([{ ...original, name: 'Latest edit' }]);
    const defaultUpdate = api.updateProject.getMockImplementation()!;
    const writes: {
      request: { name: string; data: Record<string, unknown>; expected_revision: number };
      resolve(value: Awaited<ReturnType<typeof defaultUpdate>>): void;
    }[] = [];

    api.updateProject.mockImplementation((_projectId, request) => {
      return new Promise((resolve) => {
        writes.push({ request, resolve });
      });
    });

    const firstSave = service.saveWorkbench(firstState);
    const latestSave = service.saveWorkbench(latestState);

    await vi.waitFor(() => expect(writes).toHaveLength(1));
    const firstWinner = await defaultUpdate(project.id, writes[0]!.request);

    writes[0]!.resolve(firstWinner);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    const latestWinner = await defaultUpdate(project.id, writes[1]!.request);

    writes[1]!.resolve(latestWinner);

    const results = await Promise.all([firstSave, latestSave]);

    expect(writes.map((write) => write.request.expected_revision)).toEqual([1, 2]);
    expect(results.flatMap((result) => result.conflicts)).toEqual([]);
    expect(api.__records.get(project.id)?.name).toBe('Latest edit');
  });

  it('serializes reconnect replay behind an in-flight save instead of creating and activating a recovery', async () => {
    const first = seedServerProject('First');
    const second = seedServerProject('Second');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: second.id, openProjectIds: [first.id, second.id] });

    const loaded = await service.loadWorkbench();
    const store = createWorkbenchStore(loaded!.state);
    const callbacks = new Map<number, () => void>();
    let nextTimerId = 0;
    const clock: PersistenceClock & { runAll(): void } = {
      clearTimeout: (id) => callbacks.delete(id as number),
      runAll: () => {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) {
          callback();
        }
      },
      setTimeout: (callback) => {
        nextTimerId += 1;
        callbacks.set(nextTimerId, callback);
        return nextTimerId;
      },
    };
    const runtime = createWorkbenchPersistenceRuntime({
      aggregate: {
        ...store.internal.persistence,
        getPersistedRevision: store.getPersistedRevision,
        notifyProjectNotFound: vi.fn(),
        reportLoadError: vi.fn(),
        reportRefusedProjects: vi.fn(),
        setHasHydrated: store.setHasHydrated,
        subscribe: store.subscribe,
      },
      clock,
      persistence: service,
    });

    runtime.start();
    await vi.waitFor(() => expect(store.getSnapshot().hasHydrated).toBe(true));
    store.commands.queue.setConnectionStatus({ status: 'connected' });
    store.commands.projects.rename(first.id, 'First local edit');
    store.commands.projects.rename(second.id, 'Second local edit A');

    const defaultUpdate = api.updateProject.getMockImplementation()!;
    let rejectedFirstProject = false;
    const secondProjectWrites: {
      reject(error: unknown): void;
      request: { name: string; data: Record<string, unknown>; expected_revision: number };
      resolve(value: Awaited<ReturnType<typeof defaultUpdate>>): void;
    }[] = [];

    api.updateProject.mockImplementation((projectId, request) => {
      if (projectId === first.id && !rejectedFirstProject) {
        rejectedFirstProject = true;
        return Promise.reject(new Error('transient HTTP failure'));
      }
      if (projectId === second.id) {
        return new Promise((resolve, reject) => {
          secondProjectWrites.push({ reject, request, resolve });
        });
      }
      return defaultUpdate(projectId, request);
    });

    clock.runAll();
    await vi.waitFor(() => expect(secondProjectWrites).toHaveLength(1));

    store.commands.projects.rename(second.id, 'Second local edit B');
    store.commands.queue.setConnectionStatus({ status: 'disconnected' });
    store.commands.queue.setConnectionStatus({ status: 'connected' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const didOverlap = secondProjectWrites.length > 1;
    const firstWinner = await defaultUpdate(second.id, secondProjectWrites[0]!.request);

    secondProjectWrites[0]!.resolve(firstWinner);

    if (didOverlap) {
      secondProjectWrites[1]!.reject(Object.assign(new Error('conflict'), { __status: 409 }));
    } else {
      await vi.waitFor(() => expect(secondProjectWrites).toHaveLength(2));
      const secondWinner = await defaultUpdate(second.id, secondProjectWrites[1]!.request);

      secondProjectWrites[1]!.resolve(secondWinner);
    }

    await vi.waitFor(() => expect(runtime.getSnapshot().phase).toBe('idle'));

    const recoveryRecords = [...api.__records.values()].filter((record) => record.data.recoveryOf === second.id);

    expect(secondProjectWrites.map((write) => write.request.expected_revision)).toEqual([1, 2]);
    expect(recoveryRecords).toHaveLength(0);
    expect(store.getState().activeProjectId).toBe(second.id);
    runtime.dispose();
  });

  it('never deletes server projects that are absent from state', async () => {
    const first = seedServerProject('First');
    const second = seedServerProject('Second');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: first.id, openProjectIds: [first.id, second.id] });

    const snapshot = await service.loadWorkbench();
    const open = snapshot?.state.projects ?? [];

    expect(open).toHaveLength(2);

    // Close the second tab: it leaves state, but must stay on the server.
    const closed = stateWithProjects(
      open.filter((project) => project.id !== second.id),
      first.id
    );

    await service.saveWorkbench(closed);

    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(api.__records.has(second.id)).toBe(true);
  });

  it('persists the open set in the session blob', async () => {
    const first = seedServerProject('First');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: first.id, openProjectIds: [first.id] });

    const snapshot = await service.loadWorkbench();
    const open = snapshot?.state.projects ?? [];
    const draft = createDraftProject(open);

    await service.saveWorkbench(stateWithProjects([...open, draft], draft.id));

    const blob = JSON.parse(api.__clientState.get(SESSION_KEY) ?? '{}') as {
      activeProjectId?: string;
      openProjectIds?: string[];
    };

    expect(blob.openProjectIds).toEqual([first.id, draft.id]);
    expect(blob.activeProjectId).toBe(draft.id);
  });

  it('skips pushes for projects marked deleted, so a racing autosave cannot resurrect them', async () => {
    const project = createDraftProject([]);
    const state = stateWithProjects([project]);

    service.markProjectDeleted(project.id);
    await service.saveWorkbench(state);

    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.__records.has(project.id)).toBe(false);
  });

  it('does not cache new edits when their durable pending marker cannot be written', async () => {
    const project = seedServerProject('Durable server project');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const opened = loaded!.state.projects[0]!;
    const cachedBefore = storage.get('invokeai:v7:webv2:workbench');
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.includes('workbench-sync')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    try {
      await expect(service.saveWorkbench(stateWithProjects([{ ...opened, name: 'Not yet durable' }]))).rejects.toThrow(
        'durably record pending project edits'
      );
    } finally {
      setItem.mockRestore();
    }

    expect(storage.get('invokeai:v7:webv2:workbench')).toBe(cachedBefore);
    expect(api.__records.get(project.id)?.name).toBe('Durable server project');
  });

  it('keeps a closed project revision until the cache durably omits it', async () => {
    const project = seedServerProject('Synced before close');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();
    service.releaseProjectSync(project.id);

    const persistedBeforeCrash = JSON.parse(storage.get('invokeai:v7:webv2:workbench-sync') ?? '{}') as {
      revisions?: Record<string, number>;
    };
    expect(persistedBeforeCrash.revisions?.[project.id]).toBe(1);

    api.__records.delete(project.id);
    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();

    expect(api.createProject).not.toHaveBeenCalled();
    expect(reloaded?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
  });

  it('recovers an indeterminate first create under a fresh id after revision persistence fails', async () => {
    const project = createDraftProject([]);
    const syncKey = 'invokeai:v7:webv2:workbench-sync';
    let syncWrites = 0;
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === syncKey && ++syncWrites === 2) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    try {
      const result = await service.saveWorkbench(stateWithProjects([project]));

      expect(result.hasPendingChanges).toBe(true);
      expect(api.__records.has(project.id)).toBe(true);
    } finally {
      setItem.mockRestore();
    }

    api.__records.delete(project.id);
    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();
    const recovered = reloaded?.state.projects[0];

    expect(recovered).toBeDefined();
    expect(recovered?.id).not.toBe(project.id);
    expect(recovered?.name).toContain(project.name);
    expect(api.__records.has(project.id)).toBe(false);

    await service.saveWorkbench(reloaded!.state);
    expect(api.__records.has(project.id)).toBe(false);
    expect(api.__records.has(recovered!.id)).toBe(true);
  });

  it('does not recreate a pending revisionless id after an offline reload', async () => {
    const project = { ...createDraftProject([]), name: 'Response-lost create' };

    api.createProject.mockImplementationOnce((request) => {
      api.__seed(request.data);

      return Promise.reject(new Error('response lost'));
    });
    await service.saveWorkbench(stateWithProjects([project]));
    api.__records.delete(project.id);

    api.listProjects.mockRejectedValueOnce(new Error('offline during restart'));
    const restarted = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const offline = await restarted.loadWorkbench();
    const result = await restarted.saveWorkbench(offline!.state);
    const attemptedIds = api.createProject.mock.calls.map(([request]) => request.project_id);

    expect(attemptedIds[0]).toBe(project.id);
    expect(attemptedIds.slice(1)).not.toContain(project.id);
    expect(api.__records.has(project.id)).toBe(false);
    expect(result.deletedProjectForks).toHaveLength(1);
  });

  it('does not compact hidden local edits after deletion rollback persistence fails', async () => {
    const project = seedServerProject('Deletion fails');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Unsynced edit must survive' };
    api.updateProject.mockRejectedValueOnce(new Error('offline edit'));
    await service.saveWorkbench(stateWithProjects([edited]));

    const syncKey = 'invokeai:v7:webv2:workbench-sync';
    let failRollbackWrites = false;
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === syncKey && failRollbackWrites) {
        throw new DOMException('rollback quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });
    api.deleteProject.mockImplementationOnce(() => {
      failRollbackWrites = true;

      return Promise.reject(new Error('delete offline'));
    });

    try {
      await expect(service.deleteProjectOnServer(project.id)).rejects.toThrow('delete offline');
      // The UI retries the idempotent rollback after the service rejects.
      service.unmarkProjectDeleted(project.id);
    } finally {
      setItem.mockRestore();
    }

    const primaryBeforeRestart = storage.get('invokeai:v7:webv2:workbench');
    await expect(service.flushProjectToServer(edited)).resolves.toMatchObject({ kind: 'unsynced' });
    api.getProject.mockRejectedValueOnce(new Error('still offline'));
    await expect(service.saveWorkbench(stateWithProjects([createDraftProject([])]))).rejects.toThrow(
      'Could not verify pending project deletions while offline.'
    );
    expect(storage.get('invokeai:v7:webv2:workbench')).toBe(primaryBeforeRestart);

    api.listProjects.mockRejectedValueOnce(new Error('offline during restart'));
    const restarted = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const offline = await restarted.loadWorkbench();

    api.getProject.mockRejectedValueOnce(new Error('still offline after restart'));
    await expect(restarted.saveWorkbench(offline!.state)).rejects.toThrow(
      'Could not verify pending project deletions while offline.'
    );
    expect(storage.get('invokeai:v7:webv2:workbench')).toBe(primaryBeforeRestart);
    expect((JSON.parse(primaryBeforeRestart!) as { state: WorkbenchState }).state.projects[0]?.name).toBe(
      'Unsynced edit must survive'
    );

    const reconnected = await restarted.saveWorkbench(offline!.state);
    const recoveredRecord = [...api.__records.values()].find((record) => record.project_id !== project.id);

    expect(reconnected.conflicts).toHaveLength(1);
    expect(recoveredRecord?.data).toMatchObject({ name: 'Unsynced edit must survive (recovered)' });
  });

  it('blocks close and reconciles the newest live edit after failed deletion rollback', async () => {
    const project = seedServerProject('Deletion fails before close');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const cachedEdit = { ...loaded!.state.projects[0]!, name: 'Cached edit' };
    api.updateProject.mockRejectedValueOnce(new Error('offline edit'));
    await service.saveWorkbench(stateWithProjects([cachedEdit]));

    const syncKey = 'invokeai:v7:webv2:workbench-sync';
    let failRollbackWrites = false;
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === syncKey && failRollbackWrites) {
        throw new DOMException('rollback quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });
    api.deleteProject.mockImplementationOnce(() => {
      failRollbackWrites = true;

      return Promise.reject(new Error('delete offline'));
    });

    try {
      await expect(service.deleteProjectOnServer(project.id)).rejects.toThrow('delete offline');
      service.unmarkProjectDeleted(project.id);
    } finally {
      setItem.mockRestore();
    }

    const newestLiveEdit = { ...cachedEdit, name: 'Post-cache edit must survive' };

    await expect(service.flushProjectToServer(newestLiveEdit)).resolves.toMatchObject({ kind: 'unsynced' });
    const result = await service.saveWorkbench(stateWithProjects([newestLiveEdit]));
    const recoveredRecord = [...api.__records.values()].find((record) => record.project_id !== project.id);

    expect(result.conflicts).toHaveLength(1);
    expect(recoveredRecord?.data).toMatchObject({ name: 'Post-cache edit must survive (recovered)' });
  });

  it('recovers live edits when a committed deletion loses its response', async () => {
    const project = seedServerProject('Delete response is lost');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const syncKey = 'invokeai:v7:webv2:workbench-sync';
    let failRollbackWrites = false;
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === syncKey && failRollbackWrites) {
        throw new DOMException('rollback quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });
    api.deleteProject.mockImplementationOnce((projectId) => {
      api.__records.delete(projectId);
      failRollbackWrites = true;

      return Promise.reject(new Error('delete response lost'));
    });

    try {
      await expect(service.deleteProjectOnServer(project.id)).rejects.toThrow('delete response lost');
      service.unmarkProjectDeleted(project.id);
    } finally {
      setItem.mockRestore();
    }

    const newestLiveEdit = { ...loaded!.state.projects[0]!, name: 'Edited after delete error' };

    await expect(service.flushProjectToServer(newestLiveEdit)).resolves.toMatchObject({ kind: 'unsynced' });
    const result = await service.saveWorkbench(stateWithProjects([newestLiveEdit]));
    const recoveredRecord = [...api.__records.values()][0];

    expect(api.__records.has(project.id)).toBe(false);
    expect(result.deletedProjectForks).toHaveLength(1);
    expect(recoveredRecord?.data).toMatchObject({ name: 'Edited after delete error (recovered)' });
  });
});

describe('persistEmptySession', () => {
  it('writes an empty open set without touching project records', async () => {
    const first = seedServerProject('First');
    const account = createInitialWorkbenchState().account;

    seedSessionBlob({ account, activeProjectId: first.id, openProjectIds: [first.id] });

    const snapshot = await service.loadWorkbench();

    await service.persistEmptySession(snapshot?.state ?? createInitialWorkbenchState());

    const blob = JSON.parse(api.__clientState.get(SESSION_KEY) ?? '{}') as { openProjectIds?: string[] };

    expect(blob.openProjectIds).toEqual([]);
    expect(api.__records.has(first.id)).toBe(true);
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it('keeps a deletion tombstone across a crash until the cache omission is durable', async () => {
    const project = seedServerProject('Delete me');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();
    await service.deleteProjectOnServer(project.id);

    // Simulate a crash before the aggregate can save a state without the deleted tab.
    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();
    const persistedSync = JSON.parse(storage.get('invokeai:v7:webv2:workbench-sync') ?? '{}') as {
      deletedProjectIds?: string[];
    };

    expect(api.__records.has(project.id)).toBe(false);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(reloaded?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
    expect(persistedSync.deletedProjectIds).toEqual([]);
  });

  it('does not settle a deletion tombstone when the cache omission fails', async () => {
    const project = seedServerProject('Delete me after quota clears');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    await service.loadWorkbench();
    await service.deleteProjectOnServer(project.id);

    const replacement = createDraftProject([]);
    const storageKey = 'invokeai:v7:webv2:workbench';
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === storageKey) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    try {
      await expect(service.saveWorkbench(stateWithProjects([replacement]))).rejects.toThrow('quota');
    } finally {
      setItem.mockRestore();
    }

    const persistedSync = JSON.parse(storage.get('invokeai:v7:webv2:workbench-sync') ?? '{}') as {
      deletedProjectIds?: string[];
    };

    expect(persistedSync.deletedProjectIds).toContain(project.id);
  });
});

describe('hydrateProjectFromServer', () => {
  it('returns an openable project and registers its revision for future saves', async () => {
    const project = seedServerProject('Closed project');
    const hydrated = await openServerProject(project.id);

    expect(hydrated.id).toBe(project.id);
    expect(hydrated.undoRedo).toEqual({ future: [], past: [] });

    // A subsequent save updates in place rather than re-creating.
    const renamed = { ...hydrated, name: 'Renamed after reopen' };

    await service.saveWorkbench(stateWithProjects([renamed]));

    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.__records.get(project.id)?.name).toBe('Renamed after reopen');
  });

  it('reports unknown projects as unavailable', async () => {
    expect(await service.hydrateProjectFromServer('nope')).toEqual({ status: 'unavailable' });
  });

  it('reports a server schema precondition as an unsupported project instead of as missing', async () => {
    api.getProject.mockRejectedValueOnce(api.__schemaError(4, 3));

    expect(await service.hydrateProjectFromServer('future', 'Future project')).toEqual({
      refused: {
        projectId: 'future',
        projectName: 'Future project',
        raw: null,
        refusal: { raw: null, scope: 'document', status: 'unsupported-version', version: 4 },
        source: 'canvas',
      },
      status: 'refused',
    });
  });
});

/**
 * The document's `projectBoardId` is a cache of a relationship SQLite owns. Every path that learns
 * the real answer has to write it down, or the project points at a board that means nothing here.
 */
describe('authoritative project boards', () => {
  const galleryBoardIds = (project: Project): { projectBoardId?: unknown; selectedBoardId?: unknown } => {
    const instance = Object.values(project.widgetInstances).find((entry) => entry.typeId === 'gallery');

    return (instance?.state.values ?? {}) as { projectBoardId?: unknown; selectedBoardId?: unknown };
  };

  it('reports the board the server minted for a project it created', async () => {
    const draft = createDraftProject([]);

    const result = await service.saveWorkbench(stateWithProjects([draft]));

    expect(result.projectBoardAssignments).toEqual([{ boardId: `board-for-${draft.id}`, projectId: draft.id }]);
    // Drained, so the next save does not re-apply it.
    expect((await service.saveWorkbench(stateWithProjects([draft]))).projectBoardAssignments).toEqual([]);
  });

  it('overwrites a stale board id when hydrating a record', async () => {
    const draft = createDraftProject([]);
    const document = persistence.serializeProjectDocument(draft) as Record<string, unknown>;
    const instances = document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;
    const galleryId = Object.keys(instances).find(
      (key) => (instances[key] as unknown as { typeId: string }).typeId === 'gallery'
    )!;

    // A board id written by some other install, naming a board that does not exist here.
    instances[galleryId]!.state.values.projectBoardId = 'board-from-another-machine';
    instances[galleryId]!.state.values.selectedBoardId = 'deliberate-destination';
    api.__seed(document);

    const hydrated = await openServerProject(draft.id);

    expect(galleryBoardIds(hydrated).projectBoardId).toBe(`board-for-${draft.id}`);
    // The chosen destination is the user's, not ours; resolving it is the gallery's job.
    expect(galleryBoardIds(hydrated).selectedBoardId).toBe('deliberate-destination');
  });

  /**
   * Patching the document is not enough on its own. A project saved by a build that never opened
   * its Gallery widget has no gallery values for the patch to land in, and the instance the reducer
   * creates during normalization arrives afterwards, empty — so the board has to be written again
   * once the project is hydrated.
   */
  it('tells a project its board even when its document had no gallery state', async () => {
    const draft = createDraftProject([]);
    const document = persistence.serializeProjectDocument(draft) as Record<string, unknown>;

    delete document.widgetInstances;
    delete document.widgetStates;
    api.__seed(document);

    const hydrated = await openServerProject(draft.id);

    expect(galleryBoardIds(hydrated).projectBoardId).toBe(`board-for-${draft.id}`);
  });

  it('does not push a project it only opened, even when hydrating it changed the document', async () => {
    // Another tab's search ranks a dropped file — a reference only that
    // session can resolve — and its footer sits on a rank page. Hydrating
    // that document here drops both. If the baseline were the wire bytes,
    // the next autosave would read the drop as a local edit and push it,
    // bumping the revision under the tab that still holds the live search
    // and forking its next save as "changed elsewhere".
    const draft = { ...createDraftProject([]), name: 'Ranked elsewhere' };
    const document = persistence.serializeProjectDocument(draft);
    const widgetInstances = document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;

    widgetInstances.gallery!.state.values = {
      ...widgetInstances.gallery!.state.values,
      galleryPage: 3,
      paginationMode: 'paginated',
      semanticImageQuery: { fileId: 'external-1-other-realm', kind: 'file', label: 'dropped.png' },
    };
    api.__seed(document);
    seedSessionBlob({ openProjectIds: [draft.id] });

    const loaded = await service.loadWorkbench();
    const opened = loaded!.state.projects.find((project) => project.id === draft.id)!;
    const openedValues = opened.widgetInstances.gallery!.state.values;

    expect(openedValues.semanticImageQuery).toBeNull();
    expect(openedValues.galleryPage).toBe(0);

    await service.saveWorkbench(stateWithProjects([opened]));

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.__records.get(draft.id)?.revision).toBe(1);
  });

  it('does not push a project it only opened when the other session left a window anchor', async () => {
    // The sync baseline is taken from the adopted document; the store is
    // hydrated from the boot snapshot. Both drop an infinite window's
    // mid-board anchor, so a project that has only been opened serializes to
    // its baseline — dropped by one and not the other, the first autosave
    // would push it unprompted and fork the tab that set it.
    const draft = { ...createDraftProject([]), name: 'Revealed elsewhere' };
    const document = persistence.serializeProjectDocument(draft);
    const widgetInstances = document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;

    widgetInstances.gallery!.state.values = {
      ...widgetInstances.gallery!.state.values,
      galleryPage: 5,
      paginationMode: 'infinite',
    };
    api.__seed(document);
    seedSessionBlob({ openProjectIds: [draft.id] });

    const loaded = await service.loadWorkbench();
    const opened = loaded!.state.projects.find((project) => project.id === draft.id)!;

    expect(opened.widgetInstances.gallery!.state.values.galleryPage).toBe(0);

    await service.saveWorkbench(stateWithProjects([opened]));

    expect(api.updateProject).not.toHaveBeenCalled();
    expect(api.__records.get(draft.id)?.revision).toBe(1);
  });

  it("retries rather than forks when only the other session's ranking moved", async () => {
    // The other tab paged its ranking: the revision moved and the data changed
    // only in the positions set against a search this realm cannot resolve.
    // Compared as this realm holds it, the server's copy is the baseline this
    // edit started from — a rename here is not in conflict with that.
    const draft = { ...createDraftProject([]), name: 'Ranked elsewhere' };
    const document = persistence.serializeProjectDocument(draft);
    const widgetInstances = document.widgetInstances as Record<string, { state: { values: Record<string, unknown> } }>;
    const rankedValues = (galleryPage: number) => ({
      ...widgetInstances.gallery!.state.values,
      galleryPage,
      paginationMode: 'paginated',
      semanticImageQuery: { fileId: 'external-1-other-realm', kind: 'file', label: 'dropped.png' },
    });

    widgetInstances.gallery!.state.values = rankedValues(3);
    api.__seed(document);
    seedSessionBlob({ openProjectIds: [draft.id] });

    const loaded = await service.loadWorkbench();
    const opened = loaded!.state.projects.find((project) => project.id === draft.id)!;
    const record = api.__records.get(draft.id)!;
    const pagedElsewhere = structuredClone(record.data) as typeof document;

    (pagedElsewhere.widgetInstances as typeof widgetInstances).gallery!.state.values = rankedValues(4);
    api.__records.set(draft.id, { ...record, data: pagedElsewhere, revision: record.revision + 1 });

    const result = await service.saveWorkbench(stateWithProjects([{ ...opened, name: 'Edited here' }]));

    expect(result.conflicts).toHaveLength(0);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.__records.get(draft.id)?.name).toBe('Edited here');
    expect(api.__records.get(draft.id)?.revision).toBe(3);
  });

  it('gives a fork a baseline it will serialize to, so it is not pushed unprompted', async () => {
    // The fork's store copy is hydrated from the recovered document, which
    // drops an infinite window anchor. A baseline taken from the wire bytes
    // would still carry it, and the fork's first autosave would read the drop
    // as an edit.
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const galleryEntry = Object.entries(opened.widgetInstances).find(([, instance]) => instance.typeId === 'gallery')!;
    const [galleryInstanceId, galleryInstance] = galleryEntry;
    const edited = {
      ...opened,
      name: 'Edited locally',
      widgetInstances: {
        ...opened.widgetInstances,
        [galleryInstanceId]: {
          ...galleryInstance,
          state: {
            ...galleryInstance.state,
            values: { ...galleryInstance.state.values, galleryPage: 7, paginationMode: 'infinite' },
          },
        },
      },
    };

    api.__records.delete(project.id);

    const result = await service.saveWorkbench(stateWithProjects([edited]));
    const [fork] = result.deletedProjectForks;

    expect(fork!.recoveredProject.widgetInstances[galleryInstanceId]?.state.values.galleryPage).toBe(0);
    api.updateProject.mockClear();

    await service.saveWorkbench(stateWithProjects([fork!.recoveredProject]));

    expect(api.updateProject).not.toHaveBeenCalled();
  });

  it('forks rather than resurrects a project deleted on another device', async () => {
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    // Deleted on the other device, after this one had already synced.
    api.__records.delete(project.id);

    const result = await service.saveWorkbench(stateWithProjects([edited]));

    // The deletion stands...
    expect(api.__records.has(project.id)).toBe(false);
    // ...and the work survives under a fresh id, with a board of its own.
    expect(result.deletedProjectForks).toHaveLength(1);
    const [fork] = result.deletedProjectForks;
    expect(fork!.projectId).toBe(project.id);
    expect(fork!.recoveredProject.id).not.toBe(project.id);
    expect(fork!.recoveredProject.name).toBe('Edited locally (recovered)');
    expect(api.__records.get(fork!.recoveredProject.id)).toBeDefined();
    expect(result.projectBoardAssignments).toEqual([
      { boardId: `board-for-${fork!.recoveredProject.id}`, projectId: fork!.recoveredProject.id },
    ]);
  });

  it('carries a flush-time fork to the next save instead of dropping it', async () => {
    // A flush has no caller to return outcomes to — rename, export and duplicate all go through
    // one. If the fork it produced were dropped, the aggregate would never hear about it.
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    api.__records.delete(project.id);
    await service.flushProjectToServer(edited);

    const result = await service.saveWorkbench(stateWithProjects([edited]));

    expect(result.deletedProjectForks).toHaveLength(1);
    expect(result.deletedProjectForks[0]!.projectId).toBe(project.id);
    expect(result.projectBoardAssignments).toHaveLength(1);
  });

  /**
   * The two callers that read a project back from the server — export and duplicate — have to be
   * able to tell a push that landed from one that merely failed recoverably. Every branch below
   * resolves, by design; the outcome is the only thing that distinguishes them.
   */
  describe('what a flush reports', () => {
    /**
     * `arrange` runs after the project is open and before the flush, so each row states exactly
     * what makes its outcome different. The un-renamed row does not push: the baseline is the
     * hydrated document, so a project that has only been opened has nothing to send.
     */
    it.each([
      ['acknowledged', 'a push the server took', 'Edited', () => undefined],
      ['acknowledged', 'a project the server already holds unchanged', undefined, () => undefined],
      [
        'unsynced',
        'a push the server never took',
        'Edited',
        () => {
          api.updateProject.mockRejectedValueOnce(new Error('the proxy refused the body'));
        },
      ],
      [
        'superseded',
        'a fork, because the id now holds the other version',
        'My version',
        (id: string, project: Project) => {
          // The other device wins the race with content of its own, so this is a genuine
          // divergence rather than a revision that merely drifted.
          api.__records.set(id, {
            ...api.__records.get(id)!,
            data: persistence.serializeProjectDocument({ ...project, name: 'Their version' }),
            name: 'Their version',
            revision: 99,
          });
        },
      ],
      [
        'superseded',
        'a project deleted elsewhere',
        'Edited locally',
        (id: string) => {
          api.__records.delete(id);
        },
      ],
    ])('reports %s for %s', async (kind, _label, rename, arrange) => {
      const project = seedServerProject('Synced');
      const opened = await openServerProject(project.id);

      arrange(project.id, project);

      const flushed = rename === undefined ? opened : { ...opened, name: rename };

      await expect(service.flushProjectToServer(flushed)).resolves.toMatchObject({ kind });

      if (kind === 'unsynced') {
        expect(service.hasPendingChanges()).toBe(true);
      }
    });

    it('does not overwrite the winning server document before a queued conflict resolution is applied', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const staleLocal = { ...opened, name: 'My divergent edit' };
      const winningServer = { ...project, name: 'Their winning edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(winningServer),
        name: winningServer.name,
        revision: 2,
      });

      await expect(service.flushProjectToServer(staleLocal)).resolves.toMatchObject({ kind: 'superseded' });
      const updatesAfterFork = api.updateProject.mock.calls.length;
      const result = await service.saveWorkbench(stateWithProjects([staleLocal]));

      expect(api.updateProject).toHaveBeenCalledTimes(updatesAfterFork);
      expect(api.__records.get(project.id)?.name).toBe('Their winning edit');
      expect(result.conflicts).toHaveLength(1);

      const [resolution] = result.conflicts;

      service.acknowledgeConflictResolution(project.id);
      await service.saveWorkbench(
        stateWithProjects([{ ...resolution!.serverProject, name: 'Edited after reconciliation' }])
      );
      expect(api.__records.get(project.id)?.name).toBe('Edited after reconciliation');
    });

    it('retries a failed conflict fork without adopting the winning revision', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const staleLocal = { ...opened, name: 'My divergent edit' };
      const winningServer = { ...project, name: 'Their winning edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(winningServer),
        name: winningServer.name,
        revision: 2,
      });
      api.createProject.mockRejectedValueOnce(new Error('recovery storage unavailable'));

      await expect(service.flushProjectToServer(staleLocal)).resolves.toMatchObject({ kind: 'unsynced' });
      const retried = await service.saveWorkbench(stateWithProjects([staleLocal]));

      expect(api.__records.get(project.id)?.name).toBe('Their winning edit');
      expect(retried.conflicts).toHaveLength(1);
    });

    it('adopts a committed conflict recovery after its response is lost across a restart', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const staleLocal = { ...opened, name: 'My divergent edit' };
      const winningServer = { ...project, name: 'Their winning edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(winningServer),
        name: winningServer.name,
        revision: 2,
      });
      api.createProject.mockImplementationOnce((request) => {
        api.__seed(request.data);

        return Promise.reject(new Error('recovery response lost'));
      });

      const failedSave = await service.saveWorkbench(stateWithProjects([staleLocal]));
      const recoveryId = [...api.__records.keys()].find((id) => id !== project.id)!;
      const createsAfterLostResponse = api.createProject.mock.calls.length;

      expect(failedSave.hasPendingChanges).toBe(true);

      service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
      const reloaded = await service.loadWorkbench();

      expect(api.createProject).toHaveBeenCalledTimes(createsAfterLostResponse);
      expect([...api.__records.keys()]).toEqual(expect.arrayContaining([project.id, recoveryId]));
      expect(api.__records.size).toBe(2);
      expect(reloaded?.state.projects).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: project.id, name: winningServer.name }),
          expect.objectContaining({ id: recoveryId, name: 'My divergent edit (recovered)' }),
        ])
      );
    });

    it('rotates an exact response-lost recovery when the winning source floor rises', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const staleLocal = { ...opened, name: 'My divergent edit' };
      const winningServer = { ...project, name: 'Their winning edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(winningServer),
        name: winningServer.name,
        revision: 2,
      });
      api.createProject.mockImplementationOnce((request) => {
        api.__seed(request.data);

        return Promise.reject(new Error('recovery response lost'));
      });

      await service.saveWorkbench(stateWithProjects([staleLocal]));
      const lowerFloorRecoveryId = [...api.__records.keys()].find((id) => id !== project.id)!;

      api.__records.get(project.id)!.minimum_canvas_schema_version = 4;
      const retried = await service.saveWorkbench(stateWithProjects([staleLocal]));
      const raisedFloorRecoveryId = retried.conflicts[0]!.recoveredIdentity.id;

      expect(raisedFloorRecoveryId).not.toBe(lowerFloorRecoveryId);
      expect(api.__records.get(lowerFloorRecoveryId)?.minimum_canvas_schema_version).toBe(3);
      expect(api.__records.get(raisedFloorRecoveryId)?.minimum_canvas_schema_version).toBe(4);
    });

    it('uses a distinct recovery identity for a later conflict after reconciliation is durable', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const firstLocal = { ...opened, name: 'First local edit' };
      const firstServer = { ...project, name: 'First remote edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(firstServer),
        name: firstServer.name,
        revision: 2,
      });

      const firstSave = await service.saveWorkbench(stateWithProjects([firstLocal]));
      const firstResolution = firstSave.conflicts[0]!;
      const firstRecoveryBoard = firstSave.projectBoardAssignments.find(
        (assignment) => assignment.projectId === firstResolution.recoveredIdentity.id
      )!;
      const durableFirstRecovery = withAuthoritativeProjectBoard(
        firstResolution.recoveredProject,
        firstRecoveryBoard.boardId
      );

      service.acknowledgeConflictResolution(project.id);
      await service.saveWorkbench(stateWithProjects([firstResolution.serverProject, durableFirstRecovery], project.id));
      const settledSyncMap = JSON.parse(storage.get('invokeai:v7:webv2:workbench-sync')!) as {
        pendingRecoveryIdentities?: Record<string, unknown>;
      };

      expect(settledSyncMap.pendingRecoveryIdentities?.[project.id]).toBeUndefined();

      const secondLocal = { ...firstResolution.serverProject, name: 'Second local edit' };
      const secondServer = { ...firstResolution.serverProject, name: 'Second remote edit' };
      const serverRecord = api.__records.get(project.id)!;

      api.__records.set(project.id, {
        ...serverRecord,
        data: persistence.serializeProjectDocument(secondServer),
        name: secondServer.name,
        revision: serverRecord.revision + 1,
      });

      const secondSave = await service.saveWorkbench(
        stateWithProjects([secondLocal, durableFirstRecovery], project.id)
      );
      const secondResolution = secondSave.conflicts[0]!;

      expect(secondResolution.recoveredIdentity.id).not.toBe(firstResolution.recoveredIdentity.id);
      expect(api.__records.has(firstResolution.recoveredIdentity.id)).toBe(true);
      expect(api.__records.has(secondResolution.recoveredIdentity.id)).toBe(true);
    });

    it('retires a reservation when its recovered project is durably closed', async () => {
      const project = seedServerProject('Original');
      const opened = await openServerProject(project.id);
      const local = { ...opened, name: 'Local edit' };
      const remote = { ...project, name: 'Remote edit' };

      api.__records.set(project.id, {
        ...api.__records.get(project.id)!,
        data: persistence.serializeProjectDocument(remote),
        name: remote.name,
        revision: 2,
      });

      const conflicted = await service.saveWorkbench(stateWithProjects([local]));
      const resolution = conflicted.conflicts[0]!;

      service.acknowledgeConflictResolution(project.id);
      service.releaseProjectSync(resolution.recoveredIdentity.id);
      await service.saveWorkbench(stateWithProjects([resolution.serverProject]));

      const settledSyncMap = JSON.parse(storage.get('invokeai:v7:webv2:workbench-sync')!) as {
        pendingRecoveryIdentities?: Record<string, unknown>;
      };

      expect(settledSyncMap.pendingRecoveryIdentities?.[project.id]).toBeUndefined();

      service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
      const reloaded = await service.loadWorkbench();

      expect(reloaded?.state.projects.map((candidate) => candidate.id)).toEqual([project.id]);
    });

    it('re-keys a create collision without overwriting the colliding project', async () => {
      const local = { ...createDraftProject([]), name: 'Never-synced local' };

      api.createProject
        .mockImplementationOnce(() => {
          api.__seed(persistence.serializeProjectDocument({ ...local, name: 'Unrelated server project' }));

          return Promise.reject(Object.assign(new Error('conflict'), { __status: 409 }));
        })
        .mockRejectedValueOnce(new Error('recovery storage unavailable'));

      await expect(service.flushProjectToServer(local)).resolves.toMatchObject({ kind: 'superseded' });
      const retried = await service.saveWorkbench(stateWithProjects([local]));

      expect(api.__records.get(local.id)?.name).toBe('Unrelated server project');
      expect(retried.deletedProjectForks).toHaveLength(1);

      const reopened = service.adoptProjectRecord(structuredClone(api.__records.get(local.id)!));
      expect(reopened.status).toBe('loaded');
      if (reopened.status !== 'loaded') {
        throw new Error('Expected the colliding server project to reopen.');
      }

      const createsBeforeEdit = api.createProject.mock.calls.length;
      await service.saveWorkbench(
        stateWithProjects([{ ...reopened.project, name: 'Authoritative project edited normally' }])
      );

      expect(api.createProject).toHaveBeenCalledTimes(createsBeforeEdit);
      expect(api.__records.get(local.id)?.name).toBe('Authoritative project edited normally');
    });

    it('never reuses an id after create collision is followed by a missing GET', async () => {
      const local = { ...createDraftProject([]), name: 'Possibly committed local' };

      api.createProject
        .mockRejectedValueOnce(Object.assign(new Error('conflict'), { __status: 409 }))
        .mockRejectedValueOnce(new Error('recovery storage unavailable'));
      api.getProject.mockRejectedValueOnce(Object.assign(new Error('not found'), { __status: 404 }));

      await expect(service.flushProjectToServer(local)).resolves.toMatchObject({ kind: 'unsynced' });
      const result = await service.saveWorkbench(stateWithProjects([local]));
      const attemptedIds = api.createProject.mock.calls.map(([request]) => request.project_id);

      expect(attemptedIds[0]).toBe(local.id);
      expect(attemptedIds.slice(1)).not.toContain(local.id);
      expect(api.__records.has(local.id)).toBe(false);
      expect(result.deletedProjectForks).toHaveLength(1);
    });

    it('turns a write-time schema refusal into a terminal actionable outcome without retrying it', async () => {
      const project = seedServerProject('Raised elsewhere');
      const opened = await openServerProject(project.id);
      const edited = { ...opened, name: 'Local work' };

      api.updateProject.mockRejectedValueOnce(api.__schemaError(4, 3));

      await expect(service.flushProjectToServer(edited)).resolves.toEqual({
        documentJson: JSON.stringify(persistence.serializeProjectDocument(edited)),
        kind: 'schema-refused',
        refusal: { maxCanvasSchemaVersion: 3, minimumCanvasSchemaVersion: 4 },
      });

      const callsAfterRefusal = api.updateProject.mock.calls.length;
      const save = await service.saveWorkbench(stateWithProjects([edited]));
      const cached = JSON.parse(storage.get('invokeai:v7:webv2:workbench')!) as { state: WorkbenchState };

      expect(api.updateProject).toHaveBeenCalledTimes(callsAfterRefusal);
      expect(save.hasPendingChanges).toBe(false);
      expect(cached.state.projects[0]?.name).toBe('Local work');
      expect(
        JSON.parse(storage.get('invokeai:v7:webv2:workbench:refused-projects')!) as Record<string, unknown>
      ).toMatchObject({ [project.id]: { id: project.id, name: 'Local work' } });
    });

    it('does not overwrite the only cached copy after write-time refusal retention fails', async () => {
      const project = seedServerProject('Raised elsewhere');
      const opened = await openServerProject(project.id);
      const edited = { ...opened, name: 'Local work that must survive' };
      const replacement = createDraftProject([]);
      const refusedKey = 'invokeai:v7:webv2:workbench:refused-projects';
      const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
        if (key === refusedKey) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        storage.set(key, value);
      });

      try {
        api.updateProject.mockRejectedValueOnce(api.__schemaError(4, 3));
        await service.saveWorkbench(stateWithProjects([edited]));
        const cachedBeforeOmission = storage.get('invokeai:v7:webv2:workbench');

        await expect(service.saveWorkbench(stateWithProjects([replacement]))).rejects.toThrow(
          'Could not preserve projects that require a newer client.'
        );

        expect(storage.get('invokeai:v7:webv2:workbench')).toBe(cachedBeforeOmission);
        expect((JSON.parse(cachedBeforeOmission!) as { state: WorkbenchState }).state.projects[0]?.name).toBe(
          'Local work that must survive'
        );
      } finally {
        setItem.mockRestore();
      }
    });

    it('moves divergent cached work into the raw recovery bucket when the newer floor is seen on reload', async () => {
      const project = seedServerProject('Raised elsewhere');
      const opened = await openServerProject(project.id);
      const edited = { ...opened, name: 'Local work that must survive' };

      api.updateProject.mockRejectedValueOnce(api.__schemaError(4, 3));
      await service.saveWorkbench(stateWithProjects([edited]));
      storage.set(
        'invokeai:v7:webv2:workbench:refused-projects',
        JSON.stringify({
          [project.id]: persistence.serializeProjectDocument({ ...edited, name: 'Older retained edit' }),
        })
      );
      api.__records.get(project.id)!.minimum_canvas_schema_version = 4;

      const reloaded = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());

      const snapshot = await reloaded.loadWorkbench();
      const retained = JSON.parse(storage.get('invokeai:v7:webv2:workbench:refused-projects')!) as Record<
        string,
        Record<string, unknown>
      >;

      expect(snapshot?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
      expect(snapshot?.refusedProjects).toMatchObject([
        {
          projectId: project.id,
          projectName: 'Local work that must survive',
          raw: { id: project.id, name: 'Local work that must survive' },
        },
      ]);
      expect(retained[project.id]).toMatchObject({ id: project.id, name: 'Local work that must survive' });
    });

    it('keeps the raw local recovery after an upgraded client can read the server project', async () => {
      const project = seedServerProject('Raised elsewhere');
      const opened = await openServerProject(project.id);
      const edited = { ...opened, name: 'Divergent local work' };

      api.updateProject.mockRejectedValueOnce(api.__schemaError(4, 3));
      await service.saveWorkbench(stateWithProjects([edited]));

      const reloaded = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
      const snapshot = await reloaded.loadWorkbench();
      const retained = JSON.parse(storage.get('invokeai:v7:webv2:workbench:refused-projects')!) as Record<
        string,
        Record<string, unknown>
      >;

      expect(snapshot?.state.projects.find((candidate) => candidate.id === project.id)?.name).toBe(
        'Divergent local work'
      );
      expect(reloaded.hasPendingChanges()).toBe(true);
      expect(retained[project.id]).toMatchObject({ id: project.id, name: 'Divergent local work' });
    });

    it('preserves a schema refusal discovered while reading after a revision conflict', async () => {
      const project = seedServerProject('Raised during conflict');
      const opened = await openServerProject(project.id);

      api.updateProject.mockRejectedValueOnce(Object.assign(new Error('conflict'), { __status: 409 }));
      api.getProject.mockRejectedValueOnce(api.__schemaError(4, 3));

      await expect(service.flushProjectToServer({ ...opened, name: 'Local work' })).resolves.toMatchObject({
        kind: 'schema-refused',
        refusal: { maxCanvasSchemaVersion: 3, minimumCanvasSchemaVersion: 4 },
      });
    });

    it('reconciles a concurrent floor raise without resending or lowering the stale floor', async () => {
      const project = seedServerProject('Concurrent floor');
      const opened = await openServerProject(project.id);
      const server = api.__records.get(project.id)!;

      api.__records.set(project.id, {
        ...server,
        minimum_canvas_schema_version: 4,
        revision: server.revision + 1,
      });

      await expect(service.flushProjectToServer({ ...opened, name: 'Local edit' })).resolves.toMatchObject({
        kind: 'acknowledged',
      });

      const updateRequests = api.updateProject.mock.calls.map((call) => call[1]);

      expect(updateRequests).toHaveLength(2);
      expect(updateRequests[0]).not.toHaveProperty('minimum_canvas_schema_version');
      expect(updateRequests[1]).not.toHaveProperty('minimum_canvas_schema_version');
      expect(api.__records.get(project.id)).toMatchObject({
        minimum_canvas_schema_version: 4,
        name: 'Local edit',
        revision: 3,
      });
    });
  });

  /**
   * The delete is queued behind the push rather than racing it. Were it not, a slow PUT would come
   * back 404 after the DELETE committed, and the engine's answer to a 404 is to fork — recreating,
   * server-side, exactly what the person deleted, pointing at media the deletion already removed.
   */
  it('does not fork a project this browser is deleting', async () => {
    const project = seedServerProject('Doomed');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited just before deleting' };

    let releaseUpdate: () => void = () => undefined;
    const updateReached = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const realUpdate = api.updateProject.getMockImplementation()!;

    api.updateProject.mockImplementationOnce(async (...args: Parameters<typeof realUpdate>) => {
      releaseUpdate();
      // Long enough for the delete below to be requested while this is still on the wire.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      return realUpdate(...args);
    });

    const flush = service.flushProjectToServer(edited);

    await updateReached;

    const deletion = service.deleteProjectOnServer(project.id);

    await Promise.all([flush, deletion]);

    expect(api.__records.has(project.id)).toBe(false);
    // No "(recovered)" project anywhere: the deletion is the whole answer.
    expect([...api.__records.keys()]).toEqual([]);

    const result = await service.saveWorkbench(stateWithProjects([edited]));

    expect(result.deletedProjectForks).toEqual([]);
    expect(api.__records.size).toBe(0);
  });

  /**
   * The belt to the queue's braces. Queueing removes the race for every caller that goes through
   * `deleteProjectOnServer`, but the check at the top of a push runs before its awaits — so a
   * deletion recorded while a `PUT` is on the wire has to be re-read when that `PUT` comes back 404,
   * or the fork happens anyway.
   */
  it('re-reads the deletion set when a push it started comes back 404', async () => {
    const project = seedServerProject('Doomed');
    const opened = await openServerProject(project.id);
    const realUpdate = api.updateProject.getMockImplementation()!;

    api.updateProject.mockImplementationOnce((...args: Parameters<typeof realUpdate>) => {
      // Exactly the window the check at the top of the push cannot see: the deletion lands after
      // the request left, so this push is the one that discovers the 404.
      api.__records.delete(project.id);
      service.markProjectDeleted(project.id);

      return realUpdate(...args);
    });

    await expect(service.flushProjectToServer({ ...opened, name: 'Edited locally' })).resolves.toMatchObject({
      kind: 'superseded',
    });

    // No "(recovered)" project was left behind on the server.
    expect([...api.__records.keys()]).toEqual([]);

    const result = await service.saveWorkbench(stateWithProjects([{ ...opened, name: 'Edited locally' }]));

    expect(result.deletedProjectForks).toEqual([]);
    expect(api.__records.size).toBe(0);
  });

  it('lets a project save again when its deletion fails', async () => {
    const project = seedServerProject('Survives');
    const opened = await openServerProject(project.id);

    api.deleteProject.mockRejectedValueOnce(new Error('offline'));

    await expect(service.deleteProjectOnServer(project.id)).rejects.toThrow('offline');

    // Its place in the revision chain comes back with it, so the next push is a PUT rather than a
    // create that has to recover through a 409.
    const result = await service.saveWorkbench(stateWithProjects([{ ...opened, name: 'Edited after' }]));

    expect(result.deletedProjectForks).toEqual([]);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(api.__records.get(project.id)?.name).toBe('Edited after');
  });

  it('never re-creates a project it has already forked', async () => {
    // The original stays in the aggregate until the reconciliation reaches it. A push in that
    // window would POST the old id back and undo the deletion on every device — the exact outcome
    // forking exists to avoid.
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    api.__records.delete(project.id);
    await service.flushProjectToServer(edited);
    expect(api.__records.has(project.id)).toBe(false);

    // The aggregate has not applied the fork yet, so the original is still in the saved state.
    const result = await service.saveWorkbench(stateWithProjects([edited]));

    expect(api.__records.has(project.id)).toBe(false);
    // And the fork is reported exactly once, not once per push.
    expect(result.deletedProjectForks).toHaveLength(1);
  });

  it('retries a failed deletion fork without resurrecting the deleted id', async () => {
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    api.__records.delete(project.id);
    api.createProject.mockRejectedValueOnce(new Error('recovery storage unavailable'));

    await expect(service.flushProjectToServer(edited)).resolves.toMatchObject({ kind: 'unsynced' });
    const retried = await service.saveWorkbench(stateWithProjects([edited]));

    expect(api.__records.has(project.id)).toBe(false);
    expect(retried.deletedProjectForks).toHaveLength(1);
  });

  it('adopts a recovery create whose successful response was lost across a restart', async () => {
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    api.__records.delete(project.id);
    api.createProject.mockImplementationOnce((request) => {
      api.__seed(request.data);

      return Promise.reject(new Error('recovery response lost'));
    });

    const failedSave = await service.saveWorkbench(stateWithProjects([edited]));
    const recoveryId = [...api.__records.keys()][0]!;
    const createsAfterLostResponse = api.createProject.mock.calls.length;

    expect(failedSave.hasPendingChanges).toBe(true);

    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();

    expect(api.createProject).toHaveBeenCalledTimes(createsAfterLostResponse);
    expect([...api.__records.keys()]).toEqual([recoveryId]);
    expect(reloaded?.state.projects.map((candidate) => candidate.id)).toEqual([recoveryId]);
  });

  it('rotates a response-lost recovery identity when the cached source advances', async () => {
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const firstEdit = { ...opened, name: 'First local edit' };

    api.__records.delete(project.id);
    api.createProject.mockImplementationOnce((request) => {
      api.__seed(request.data);

      return Promise.reject(new Error('recovery response lost'));
    });

    await service.saveWorkbench(stateWithProjects([firstEdit]));
    const firstRecoveryId = [...api.__records.keys()][0]!;
    const secondEdit = { ...firstEdit, name: 'Newer local edit' };
    const secondSave = await service.saveWorkbench(stateWithProjects([secondEdit]));
    const secondRecoveryId = secondSave.deletedProjectForks[0]!.recoveredIdentity.id;

    expect(secondRecoveryId).not.toBe(firstRecoveryId);
    expect(api.__records.get(firstRecoveryId)?.name).toBe('First local edit (recovered)');
    expect(api.__records.get(secondRecoveryId)?.name).toBe('Newer local edit (recovered)');

    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();

    expect(reloaded?.state.projects).toMatchObject([{ id: secondRecoveryId, name: 'Newer local edit (recovered)' }]);
  });

  it('does not resurrect a response-lost recovery that another client deleted', async () => {
    const project = seedServerProject('Deleted elsewhere');
    const opened = await openServerProject(project.id);
    const edited = { ...opened, name: 'Edited locally' };

    api.__records.delete(project.id);
    api.createProject.mockImplementationOnce((request) => {
      api.__seed(request.data);

      return Promise.reject(new Error('recovery response lost'));
    });

    await service.saveWorkbench(stateWithProjects([edited]));
    const deletedRecoveryId = [...api.__records.keys()][0]!;

    api.__records.delete(deletedRecoveryId);
    const retried = await service.saveWorkbench(stateWithProjects([edited]));
    const freshRecoveryId = retried.deletedProjectForks[0]!.recoveredIdentity.id;
    const attemptedIds = api.createProject.mock.calls.map(([request]) => request.project_id);

    expect(freshRecoveryId).not.toBe(deletedRecoveryId);
    expect(attemptedIds).toEqual([deletedRecoveryId, freshRecoveryId]);
    expect(api.__records.has(deletedRecoveryId)).toBe(false);
    expect(api.__records.has(freshRecoveryId)).toBe(true);
  });

  it('keeps a successful deletion fork crash-durable before aggregate reconciliation', async () => {
    const project = seedServerProject('Deleted elsewhere');

    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: project.id,
      openProjectIds: [project.id],
    });
    const loaded = await service.loadWorkbench();
    const edited = { ...loaded!.state.projects[0]!, name: 'Edited locally' };

    api.__records.delete(project.id);
    const result = await service.saveWorkbench(stateWithProjects([edited]));
    const recoveredId = result.deletedProjectForks[0]!.recoveredIdentity.id;
    const createsAfterFork = api.createProject.mock.calls.length;

    // Crash before `result` can be applied to the aggregate: the primary cache still has the
    // original id, while the sync map must prove that id was deleted/forked.
    service = persistence.createSyncedWorkbenchPersistence(account.captureAccountScope());
    const reloaded = await service.loadWorkbench();

    expect(api.__records.has(project.id)).toBe(false);
    expect(api.__records.has(recoveredId)).toBe(true);
    expect(api.createProject).toHaveBeenCalledTimes(createsAfterFork);
    expect(reloaded?.state.projects.some((candidate) => candidate.id === project.id)).toBe(false);
  });
});

describe('canvas version gate', () => {
  const futureProject = (name: string): Project => {
    const draft = { ...createDraftProject([]), name };

    return { ...draft, canvas: { ...draft.canvas, version: 4 } as unknown as Project['canvas'] };
  };

  const cacheKey = 'invokeai:v7:webv2:workbench';

  const seedCache = (projects: Project[]): WorkbenchState => {
    const state = stateWithProjects(projects);

    storage.set(cacheKey, JSON.stringify({ savedAt: '2026-07-19T00:00:00.000Z', state, version: 1 }));

    return state;
  };

  it('publishes a never-synced document with the floor its canonical canvas requires', async () => {
    const future = futureProject('Future offline project');

    await service.flushProjectToServer(future);

    expect(api.createProject).toHaveBeenCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4, project_id: future.id }),
      expect.any(AbortSignal)
    );
  });

  it('retains a server floor when deletion recovery forks a document with a lower live version', async () => {
    const project = seedServerProject('Future floor');
    api.__records.get(project.id)!.minimum_canvas_schema_version = 4;
    const opened = await openServerProject(project.id);

    api.__records.delete(project.id);
    await service.flushProjectToServer({ ...opened, name: 'Recovered locally' });

    expect(api.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4 }),
      expect.any(AbortSignal)
    );
  });

  it('retains the winning server floor when revision-conflict recovery forks local bytes', async () => {
    const project = seedServerProject('Future floor conflict');
    const opened = await openServerProject(project.id);
    const serverRecord = api.__records.get(project.id)!;
    const winningServer = { ...project, name: 'Winning remote edit' };

    api.__records.set(project.id, {
      ...serverRecord,
      data: persistence.serializeProjectDocument(winningServer),
      minimum_canvas_schema_version: 4,
      name: winningServer.name,
      revision: serverRecord.revision + 1,
    });

    await service.flushProjectToServer({ ...opened, name: 'Divergent local edit' });

    expect(api.createProject).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimum_canvas_schema_version: 4 }),
      expect.any(AbortSignal)
    );
  });

  it('retains a server schema refusal during boot instead of treating the project as missing', async () => {
    const future = seedServerProject('Future server project');
    api.__records.get(future.id)!.minimum_canvas_schema_version = 4;
    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: future.id,
      openProjectIds: [future.id],
    });
    const snapshot = await service.loadWorkbench();

    expect(snapshot?.refusedProjects).toEqual([
      {
        projectId: future.id,
        projectName: 'Future server project',
        raw: null,
        refusal: { raw: null, scope: 'document', status: 'unsupported-version', version: 4 },
        source: 'canvas',
      },
    ]);
    expect(api.getProject).not.toHaveBeenCalled();
    expect(snapshot?.state.projects.some((project) => project.id === future.id)).toBe(false);
  });

  it('keeps the primary cached project when the raw refusal bucket is full', async () => {
    const future = seedServerProject('Future server project');
    const cached = { ...future, name: 'Local work that must remain cached' };

    api.__records.get(future.id)!.minimum_canvas_schema_version = 4;
    seedCache([cached]);
    seedSessionBlob({
      account: createInitialWorkbenchState().account,
      activeProjectId: future.id,
      openProjectIds: [future.id],
    });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.endsWith(':refused-projects')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    let snapshot;

    try {
      snapshot = await service.loadWorkbench();
    } finally {
      setItem.mockRestore();
    }

    const primary = JSON.parse(storage.get(cacheKey)!) as { state: WorkbenchState };

    expect(primary.state.projects).toMatchObject([{ id: future.id, name: cached.name }]);
    expect(snapshot?.state.projects).toMatchObject([{ id: future.id, name: cached.name }]);
    expect(storage.has(`${cacheKey}:refused-projects`)).toBe(false);
  });

  it('blocks cache replacement until a locally future document reaches the recovery bucket', async () => {
    const supported = { ...createDraftProject([]), name: 'Supported' };
    const future = futureProject('Only raw future copy');

    seedCache([supported, future]);
    api.listProjects.mockRejectedValueOnce(new Error('offline'));
    const primaryBefore = storage.get(cacheKey);
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.endsWith(':refused-projects')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      storage.set(key, value);
    });

    try {
      const snapshot = await service.loadWorkbench();

      expect(snapshot?.state.projects.map((project) => project.id)).toEqual([supported.id]);
      expect(snapshot?.hasUnretainedRefusedProjects).toBe(true);
      await expect(service.saveWorkbench(snapshot!.state)).rejects.toThrow('newer client');
    } finally {
      setItem.mockRestore();
    }

    expect(storage.get(cacheKey)).toBe(primaryBefore);
    expect(storage.has(`${cacheKey}:refused-projects`)).toBe(false);
  });

  it('keeps a refused cached project out of the session and moves it verbatim to the refused bucket', async () => {
    const supported = { ...createDraftProject([]), name: 'Supported' };
    const future = futureProject('From the future');

    seedCache([supported, future]);
    api.listProjects.mockRejectedValueOnce(new Error('offline'));

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects.map((project) => project.id)).toEqual([supported.id]);
    expect(snapshot?.refusedProjects).toMatchObject([
      {
        projectId: future.id,
        projectName: 'From the future',
        refusal: { scope: 'state', status: 'unsupported-version', version: 4 },
        source: 'canvas',
      },
    ]);

    await service.saveWorkbench({ ...snapshot!.state, projects: [{ ...supported, name: 'Edited' }] });

    const cached = JSON.parse(storage.get(cacheKey)!) as { state: WorkbenchState };
    const refused = JSON.parse(storage.get(`${cacheKey}:refused-projects`)!) as Record<string, unknown>;

    expect(cached.state.projects.map((project) => project.name)).toEqual(['Edited']);
    expect(refused[future.id]).toEqual(JSON.parse(JSON.stringify(future)));
  });

  it('forgets a refused cached project once it is deleted from the library', async () => {
    const supported = { ...createDraftProject([]), name: 'Supported' };
    const future = futureProject('From the future');

    seedCache([supported, future]);
    api.listProjects.mockRejectedValueOnce(new Error('offline'));
    await service.loadWorkbench();

    expect(JSON.parse(storage.get(`${cacheKey}:refused-projects`)!)).toHaveProperty(future.id);

    await library.deleteLibraryProject(future.id);

    expect(storage.get(`${cacheKey}:refused-projects`)).toBeUndefined();
  });

  it('reports a project refused from both the cache and the server once', async () => {
    const future = futureProject('From the future');

    seedCache([future]);
    api.__seed(persistence.serializeProjectDocument(future));
    seedSessionBlob({ account, activeProjectId: future.id, openProjectIds: [future.id] });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.refusedProjects.map((refused) => refused.projectId)).toEqual([future.id]);
  });

  it('never pushes a refused cached project to a first-contact backend', async () => {
    const supported = { ...createDraftProject([]), name: 'Supported' };
    const future = futureProject('From the future');

    seedCache([supported, future]);

    const snapshot = await service.loadWorkbench();

    expect(api.createProject).toHaveBeenCalledTimes(1);
    expect([...api.__records.keys()]).toEqual([supported.id]);
    expect(snapshot?.refusedProjects?.map((refused) => refused.projectId)).toEqual([future.id]);
  });

  it('reports a refused server record without adopting or rewriting it', async () => {
    const supported = seedServerProject('Supported');
    const future = futureProject('From the future');

    api.__seed(persistence.serializeProjectDocument(future));
    seedSessionBlob({ account, activeProjectId: future.id, openProjectIds: [supported.id, future.id] });

    const snapshot = await service.loadWorkbench();

    expect(snapshot?.state.projects.map((project) => project.id)).toEqual([supported.id]);
    expect(snapshot?.refusedProjects?.map((refused) => refused.projectId)).toEqual([future.id]);

    await service.saveWorkbench({
      ...snapshot!.state,
      projects: [{ ...snapshot!.state.projects[0]!, name: 'Edited' }],
    });

    expect(api.__records.get(future.id)?.data.canvas).toMatchObject({ version: 4 });
    expect(api.__records.get(future.id)?.revision).toBe(1);
  });

  it('refuses to hydrate a server record written by a newer client', async () => {
    const future = futureProject('From the future');

    api.__seed(persistence.serializeProjectDocument(future));

    const result = await service.hydrateProjectFromServer(future.id);

    expect(result).toMatchObject({
      refused: { projectId: future.id, refusal: { status: 'unsupported-version', version: 4 }, source: 'canvas' },
      status: 'refused',
    });
  });
});
