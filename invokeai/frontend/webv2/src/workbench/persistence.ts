import type { HydratedWorkbenchSnapshot, PersistedWorkbenchSnapshotV1 } from '@workbench/persistenceContracts';
import type { Project, RefusedWorkbenchProject, WorkbenchState } from '@workbench/projectContracts';

import { stripInfiniteWindowAnchor, stripSessionScopedGallerySearch } from '@features/gallery/contracts';

import { timeWorkbenchPerf } from './performanceMarks';
import { gateProjectCanvases } from './projectCanvasGate';
import {
  createRefusedProjectStorage,
  isBrowserStorageAvailable,
  WORKBENCH_STORAGE_KEY_BASE,
} from './refusedProjectStorage';

const WORKBENCH_SCHEMA_VERSION = 1;

export interface WorkbenchPersistenceService {
  loadWorkbench(): Promise<HydratedWorkbenchSnapshot | null>;
  saveWorkbench(state: WorkbenchState): Promise<HydratedWorkbenchSnapshot>;
  clearWorkbench(): Promise<void>;
  /** Drops a refused project's retained raw document, e.g. after the project is deleted. */
  forgetRefusedProject(projectId: string): Promise<void>;
  /**
   * Moves raw documents this client cannot open into the recovery bucket without rewriting them.
   * Returns false when the recovery bucket could not be written.
   */
  retainRefusedProjects(refusedProjects: readonly RefusedWorkbenchProject[]): Promise<boolean>;
}

const isBrowser = isBrowserStorageAvailable;

/**
 * Two gallery positions describe the current session only, and both are read
 * on reload as if they described the board.
 *
 * In infinite mode `galleryPage` is not a page number but the anchor of a
 * mid-board window, set by a reveal from the image map. That is a "you are
 * here" for this session: restored a day later it would open the gallery
 * stranded in the middle of a board, with no page control (the footer's is
 * paginated-only) and no way back to the top short of switching boards.
 * Paginated pages stay persisted — there the value really is the page the
 * user was reading.
 *
 * A dropped file or an image-map cluster is likewise session-scoped: it names
 * an entry in an in-memory registry that no other realm can resolve, so the
 * ranking evaporates on the first parse over there. Nothing observes that
 * moment, so anything set against the ranking outlives it — and the footer
 * paginates the RANKING, which makes both the gallery's page and the page
 * stamped on the selection rank pages that the board listing would then read
 * as its own. `stripSessionScopedGallerySearch` drops the reference and those
 * positions together.
 *
 * Adoption applies a narrower version of this (see `normalizeWorkbenchProject`):
 * it can only drop a reference that fails to resolve, because it also runs on
 * projects that never left this realm. The window anchor below is dropped here
 * only — telling a foreign document from a live one is what that would need.
 */
const stripSessionScopedGalleryState = (project: Project): Project => {
  let didChange = false;
  const widgetInstances = Object.fromEntries(
    Object.entries(project.widgetInstances).map(([instanceId, instance]) => {
      const values = instance.state.values;

      if (instance.typeId !== 'gallery') {
        return [instanceId, instance];
      }

      const strippedValues = stripSessionScopedGallerySearch(values);
      const strippedAnchorValues = stripInfiniteWindowAnchor(strippedValues ?? values);

      if (strippedValues === null && strippedAnchorValues === null) {
        return [instanceId, instance];
      }

      didChange = true;
      return [
        instanceId,
        { ...instance, state: { ...instance.state, values: strippedAnchorValues ?? strippedValues ?? values } },
      ];
    })
  );

  return didChange ? { ...project, widgetInstances } : project;
};

export const stripTransientWorkbenchState = (state: WorkbenchState): WorkbenchState => {
  const { errorLog: _legacyErrorLog, ...nextState } = state as WorkbenchState & { errorLog?: string[] };

  return {
    ...nextState,
    notifications: [],
    // Project undo/redo is deliberately session-only. Normalize legacy cache
    // snapshots immediately and never let full-project undo entries consume
    // localStorage quota or grow across browser sessions.
    projects: nextState.projects.map((project) => ({
      ...stripSessionScopedGalleryState(project),
      undoRedo: { future: [], past: [] },
    })),
  };
};

const createSnapshot = (state: WorkbenchState): HydratedWorkbenchSnapshot => ({
  hasUnretainedRefusedProjects: false,
  refusedProjects: [],
  savedAt: new Date().toISOString(),
  state: stripTransientWorkbenchState(state),
  version: WORKBENCH_SCHEMA_VERSION,
});

const isWorkbenchState = (value: unknown): value is WorkbenchState => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;

  return Array.isArray(record.projects) && typeof record.activeProjectId === 'string';
};

export const hydratePersistedWorkbenchSnapshot = (value: unknown): HydratedWorkbenchSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Partial<PersistedWorkbenchSnapshotV1> & { schemaVersion?: number };
  const version = record.version ?? record.schemaVersion;

  if (version !== WORKBENCH_SCHEMA_VERSION || !isWorkbenchState(record.state)) {
    return null;
  }

  const state = record.state;
  const projects: Project[] = [];
  const refusedProjects: RefusedWorkbenchProject[] = [];

  for (const project of state.projects) {
    const refused = gateProjectCanvases(project);

    if (refused) {
      refusedProjects.push(refused);
    } else {
      projects.push(project);
    }
  }

  const activeProjectId = projects.some((project) => project.id === state.activeProjectId)
    ? state.activeProjectId
    : (projects[0]?.id ?? '');

  return {
    hasUnretainedRefusedProjects: false,
    refusedProjects,
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
    state: stripTransientWorkbenchState({ ...state, activeProjectId, projects }),
    version: WORKBENCH_SCHEMA_VERSION,
  };
};

export const serializeWorkbenchPersistenceSnapshot = (
  snapshot: HydratedWorkbenchSnapshot
): PersistedWorkbenchSnapshotV1 => ({
  savedAt: snapshot.savedAt,
  state: snapshot.state,
  version: WORKBENCH_SCHEMA_VERSION,
});

/**
 * Construct one account-owned browser cache. The suffix is captured once,
 * rather than read from mutable auth state when a debounced save eventually
 * executes, so work started by account A can never land in account B's bucket.
 *
 * Projects the canvas version gate refuses move into a sibling bucket, untouched,
 * until they are explicitly forgotten.
 */
export const createLocalStorageWorkbenchPersistence = (storageSuffix: string): WorkbenchPersistenceService => {
  const storageKey = `${WORKBENCH_STORAGE_KEY_BASE}${storageSuffix}`;
  const refused = createRefusedProjectStorage(storageSuffix);

  return {
    clearWorkbench() {
      if (!isBrowser()) {
        return Promise.resolve();
      }

      window.localStorage.removeItem(storageKey);
      refused.clear();

      return Promise.resolve();
    },
    forgetRefusedProject(projectId) {
      refused.forget(projectId);

      return Promise.resolve();
    },
    loadWorkbench() {
      if (!isBrowser()) {
        return Promise.resolve(null);
      }

      const value = window.localStorage.getItem(storageKey);

      if (!value) {
        return Promise.resolve(null);
      }

      let snapshot: HydratedWorkbenchSnapshot | null;

      try {
        snapshot = hydratePersistedWorkbenchSnapshot(JSON.parse(value));
      } catch {
        window.localStorage.removeItem(storageKey);

        return Promise.resolve(null);
      }

      if (snapshot && snapshot.refusedProjects.length > 0) {
        if (refused.retain(snapshot.refusedProjects)) {
          // The raw recovery copy is durable. Only now is it safe to compact the ordinary cache. A
          // compaction failure leaves the original value intact; it is not evidence of corrupt input.
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(serializeWorkbenchPersistenceSnapshot(snapshot)));
          } catch {
            // Retaining the original primary cache is the recovery path.
          }
        } else {
          snapshot = { ...snapshot, hasUnretainedRefusedProjects: true };
        }
      }

      return Promise.resolve(snapshot);
    },
    retainRefusedProjects(refusedProjects) {
      return Promise.resolve(!isBrowser() || refused.retain(refusedProjects));
    },
    saveWorkbench(state) {
      const snapshot = createSnapshot(state);

      if (!isBrowser()) {
        return Promise.resolve(snapshot);
      }

      try {
        window.localStorage.setItem(
          storageKey,
          timeWorkbenchPerf(
            'workbench:persistence-localstorage-stringify',
            { area: 'persistence', kind: 'workbench', projectId: state.activeProjectId },
            () => JSON.stringify(serializeWorkbenchPersistenceSnapshot(snapshot))
          )
        );
      } catch (error) {
        return Promise.reject(error);
      }

      return Promise.resolve(snapshot);
    },
  };
};
