import type { HydratedWorkbenchSnapshot } from '@workbench/persistenceContracts';
import type { Project, ProjectLoadResult, RefusedWorkbenchProject, WorkbenchState } from '@workbench/projectContracts';

import { assertAccountScopeCurrent, captureAccountScope, type AccountScope } from '@platform/state/accountLifecycle';
import {
  DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
  getProjectCanvasSchemaRequirement,
  isCanvasSchemaVersionSupported,
  MAX_SUPPORTED_CANVAS_SCHEMA_VERSION,
} from '@workbench/canvasSchemaVersion';
import { timeWorkbenchPerf } from '@workbench/performanceMarks';
import { createLocalStorageWorkbenchPersistence, type WorkbenchPersistenceService } from '@workbench/persistence';
import {
  createDraftProject,
  createInitialWorkbenchState,
  loadWorkbenchProject,
  normalizeWorkbenchAccount,
  withAuthoritativeProjectBoard,
} from '@workbench/workbenchState';

import type { ProjectPushOutcome, ProjectRecoveredIdentity, ProjectSchemaRefusal } from './projectFlush';

import {
  createProject as apiCreateProject,
  deleteClientStateValue,
  deleteProject as apiDeleteProject,
  getProjectCanvasSchemaCompatibilityRefusal,
  getProject as apiGetProject,
  isProjectConflictError,
  isProjectNotFoundError,
  listProjects,
  setClientStateValue,
  updateProject as apiUpdateProject,
  type ProjectRecordDTO,
} from './api';
import { recordProjectCover } from './covers';
import { createProjectId } from './ids';
import { seedProjectLibrary, upsertProjectSummary } from './library';
import { selectCoverImageName } from './projectAssets';
import {
  applyAuthoritativeProjectBoard,
  isProjectDocumentShape,
  normalizeLegacyProjectDocument,
  serializeProjectDocument,
} from './projectDocument';
import { fetchSessionBlob, serializeSessionBlob, SESSION_STATE_KEY } from './session';
import { reportProjectSync, type ProjectSyncInfo } from './syncStore';

export { serializeProjectDocument } from './projectDocument';

/**
 * Backend-first workbench persistence (spec: Persistence Model).
 *
 * The server is the source of truth: one revision-versioned document per project, plus a session
 * blob in the per-user client-state KV. The localStorage snapshot is a write-through cache, so the
 * workbench still loads and autosaves offline and replays on reconnect.
 *
 * Workbench state holds only the open projects; the rest live in the library as summaries. Saving
 * never deletes — projects leave the server only through the library's explicit delete.
 *
 * Conflicts never lose work: the server version keeps the id, and the local version forks into a
 * "(recovered)" project beside it.
 */

const SYNC_MAP_BASE_KEY = 'invokeai:v7:webv2:workbench-sync';

interface SyncEntry {
  /** The server revision our next save is based on. */
  revision: number;
  /** Serialized form of the last document the server acknowledged. */
  pushedDoc: string | null;
  /** Monotonic server floor retained across offline recovery and conflict forks. */
  minimumCanvasSchemaVersion: number;
}

interface PendingRecoveryReservation {
  identity: ProjectRecoveredIdentity;
  sourceDocumentFingerprint: string;
}

export interface ProjectConflictResolution {
  projectId: string;
  /** The newer version that won on the server, now adopted locally. */
  serverProject: Project;
  /** The forked copy carrying the local edits that lost the race. */
  recoveredProject: Project;
  recoveredIdentity: ProjectRecoveredIdentity;
}

/** Local edits rescued from a project that was deleted on another device. */
export interface ProjectDeletionFork {
  projectId: string;
  /** The fork carrying the local edits, under a fresh id and its own board. */
  recoveredProject: Project;
  recoveredIdentity: ProjectRecoveredIdentity;
}

/** A board the server assigned to a project this save created. */
export interface ProjectBoardAssignment {
  boardId: string;
  projectId: string;
}

export interface WorkbenchSaveResult {
  snapshot: HydratedWorkbenchSnapshot;
  conflicts: ProjectConflictResolution[];
  /** True when changes are cached locally but could not reach the backend. */
  hasPendingChanges: boolean;
  /**
   * Boards the server minted for projects created during this save. A draft is created by
   * persistence rather than by the editor, so the create response is the only place its board id
   * exists — discarding it would leave the project pointing at no board until the next reload.
   */
  projectBoardAssignments: ProjectBoardAssignment[];
  /**
   * Projects deleted elsewhere whose unsaved local edits were forked rather than re-created. The
   * deletion stands; the work does not.
   */
  deletedProjectForks: ProjectDeletionFork[];
}

export interface WorkbenchLoadOptions {
  /** Deep-linked project (/app?project=…) to include in the open set. */
  openProjectId?: string;
  /** Append a fresh draft project to the session (/app?new=1). */
  createNew?: boolean;
}

interface SyncedPersistenceState {
  /** Last successfully cached project bytes, including projects hidden by uncertain tombstones. */
  cachedProjectsById: Map<string, Project>;
  /** IDs proven occupied by a 409; they may only recover under a fresh identity, never POST again. */
  collisionProjectIds: Set<string>;
  /**
   * Deletion tombstones guard racing saves and survive reloads until a cache snapshot without the
   * project is durable. A crash can therefore replay or cancel a deletion, but cannot resurrect it.
   */
  deletedProjectIds: Set<string>;
  /**
   * Ids already forked because the server no longer had them. The original stays in the aggregate
   * until reconciliation reaches it, and in that window `pushProject` would find no sync entry and
   * re-create it under its old id — undoing the deletion the fork exists to respect.
   */
  forkedProjectIds: Set<string>;
  hasPending: boolean;
  localPersistence: WorkbenchPersistenceService;
  lastPushedAccount: string | null;
  /** Immutable owner captured when this synchronization lifetime was constructed. */
  owner: AccountScope;
  /**
   * What the server said that the aggregate has not been told yet, drained by the next save. A push
   * happens from a save *and* from a targeted flush, and only the save has somewhere to return an
   * outcome to — so a flush that forks a project cannot silently drop the answer.
   */
  pendingBoardAssignments: ProjectBoardAssignment[];
  pendingConflicts: ProjectConflictResolution[];
  pendingDeletedForks: ProjectDeletionFork[];
  /** Projects whose cached document was durably written before its server acknowledgement. */
  pendingProjectIds: Set<string>;
  /** Monotonic source floors for never-synced recovery projects; not fake acknowledgements. */
  pendingProjectMinimumCanvasSchemaVersions: Map<string, number>;
  /** Durable source-to-recovery identities make recovery POST retries idempotent. */
  pendingRecoveryIdentities: Map<string, PendingRecoveryReservation>;
  projectDocumentJsonCache: WeakMap<Project, { document: Record<string, unknown>; json: string }>;
  /** Closed projects whose revision metadata may be pruned after the cache confirms their absence. */
  releasedProjectIds: Set<string>;
  /** Terminal for this client lifetime: retries cannot succeed until the app is upgraded. */
  schemaRefusals: Map<string, ProjectSchemaRefusal>;
  /** Server-known projects, keyed by project id. */
  syncEntries: Map<string, SyncEntry>;
  /** Tombstones hiding cached bytes whose server outcome cannot yet be reconciled. */
  unconfirmedDeletionProjectIds: Set<string>;
  /** Raw refused documents that must reach the recovery bucket before the primary cache may change. */
  unretainedRefusedProjects: RefusedWorkbenchProject[];
}

const createSyncedPersistenceState = (owner: AccountScope): SyncedPersistenceState => ({
  cachedProjectsById: new Map(),
  collisionProjectIds: new Set(),
  deletedProjectIds: new Set(),
  forkedProjectIds: new Set(),
  hasPending: false,
  localPersistence: createLocalStorageWorkbenchPersistence(owner.storageSuffix),
  lastPushedAccount: null,
  owner,
  pendingBoardAssignments: [],
  pendingConflicts: [],
  pendingDeletedForks: [],
  pendingProjectIds: new Set(),
  pendingProjectMinimumCanvasSchemaVersions: new Map(),
  pendingRecoveryIdentities: new Map(),
  projectDocumentJsonCache: new WeakMap(),
  releasedProjectIds: new Set(),
  schemaRefusals: new Map(),
  syncEntries: new Map(),
  unconfirmedDeletionProjectIds: new Set(),
  unretainedRefusedProjects: [],
});

const assertOwner = (syncState: SyncedPersistenceState): void => {
  assertAccountScopeCurrent(syncState.owner);
};

const getSerializedProjectDocument = (
  syncState: SyncedPersistenceState,
  project: Project
): { document: Record<string, unknown>; json: string } => {
  const cached = syncState.projectDocumentJsonCache.get(project);

  if (cached) {
    return cached;
  }

  const document = serializeProjectDocument(project);
  const json = timeWorkbenchPerf(
    'workbench:project-document-stringify',
    { area: 'project-sync', kind: 'workbench', projectId: project.id },
    () => JSON.stringify(document)
  );
  const serialized = { document, json };

  syncState.projectDocumentJsonCache.set(project, serialized);
  // The cache is keyed by project identity, so this runs once per document
  // version — the only moments a project's cover can have changed. Recording it
  // here rather than after the push keeps one seam instead of three, and costs
  // nothing when the push fails: the cover names an image that exists either
  // way, and `recordProjectCover` is a no-op when the answer has not moved.
  recordProjectCover(project.id, selectCoverImageName(document), syncState.owner);

  return serialized;
};

/**
 * Rehydrate a *server record*, which knows the project's real board. The document's own
 * `projectBoardId` is a stale-able cache, so overwriting it here means every path that reads from
 * the server agrees on one answer. The saved destination is left alone — it is a deliberate choice.
 */
const deserializeProjectRecord = (record: ProjectRecordDTO): ProjectLoadResult => {
  const result = deserializeProjectDocument(
    applyAuthoritativeProjectBoard(record.data, record.board_id, { selectBoard: false })
  );

  // Again after rehydration, because the document may have had no gallery values for the first
  // patch to land in — see `withAuthoritativeProjectBoard`.
  switch (result.status) {
    case 'loaded':
      return { project: withAuthoritativeProjectBoard(result.project, record.board_id), status: 'loaded' };
    case 'refused':
      return { refused: { ...result.refused, raw: record.data }, status: 'refused' };
    default:
      return result;
  }
};

/**
 * The baseline a server record establishes for the push comparison.
 *
 * It is the serialization of what this realm holds after hydrating the
 * record, not the raw wire bytes. Hydration can legitimately change a
 * document — a search only the writing session could resolve is dropped,
 * along with the pages set against it — and a baseline taken from the bytes
 * would read that as a local edit.
 */
const adoptRecordBaseline = (record: ProjectRecordDTO): { pushedDoc: string; result: ProjectLoadResult } => {
  const result = deserializeProjectRecord(record);

  // Do not use `getSerializedProjectDocument` here: taking a comparison
  // baseline must not record the cover of a document this realm may never
  // adopt (for example, the server side of conflict recovery).
  return {
    pushedDoc:
      result.status === 'loaded'
        ? JSON.stringify(serializeProjectDocument(result.project))
        : JSON.stringify(record.data),
    result,
  };
};

const toServerSchemaRefusal = (
  error: unknown,
  projectId: string,
  projectName: string
): RefusedWorkbenchProject | null => {
  const compatibility = getProjectCanvasSchemaCompatibilityRefusal(error);

  if (!compatibility) {
    return null;
  }

  return {
    projectId,
    projectName,
    raw: null,
    refusal: {
      raw: null,
      scope: 'document',
      status: 'unsupported-version',
      version: compatibility.minimumCanvasSchemaVersion,
    },
    source: 'canvas',
  };
};

const toDeclaredSchemaRefusal = (
  projectId: string,
  projectName: string,
  minimumCanvasSchemaVersion: number
): RefusedWorkbenchProject => ({
  projectId,
  projectName,
  raw: null,
  refusal: {
    raw: null,
    scope: 'document',
    status: 'unsupported-version',
    version: minimumCanvasSchemaVersion,
  },
  source: 'canvas',
});

const rememberServerSchemaRefusal = (
  syncState: SyncedPersistenceState,
  projectId: string,
  error: unknown
): ProjectSchemaRefusal | null => {
  const refusal = getProjectCanvasSchemaCompatibilityRefusal(error);

  if (refusal) {
    syncState.schemaRefusals.set(projectId, refusal);
  }

  return refusal;
};

const retainSchemaRefusedProject = async (
  syncState: SyncedPersistenceState,
  project: Project,
  refusal: ProjectSchemaRefusal
): Promise<boolean> => {
  const raw = serializeProjectDocument(project);
  const refusedProject: RefusedWorkbenchProject = {
    projectId: project.id,
    projectName: project.name,
    raw,
    refusal: {
      raw,
      scope: 'document',
      status: 'unsupported-version',
      version: refusal.minimumCanvasSchemaVersion,
    },
    source: 'canvas',
  };
  const retained = await syncState.localPersistence.retainRefusedProjects([refusedProject]);
  assertOwner(syncState);

  // A schema refusal is terminal for this sync lifetime, but its raw document is not safe to omit
  // from the primary cache until the recovery bucket confirms the write. Keep the latest raw copy
  // in memory so every later save retries retention before it can replace that cache.
  syncState.unretainedRefusedProjects = retained
    ? syncState.unretainedRefusedProjects.filter((candidate) => candidate.projectId !== project.id)
    : [
        ...syncState.unretainedRefusedProjects.filter((candidate) => candidate.projectId !== project.id),
        refusedProject,
      ];

  return retained;
};

const ensureRefusedProjectsRetained = async (syncState: SyncedPersistenceState): Promise<boolean> => {
  if (syncState.unretainedRefusedProjects.length === 0) {
    return true;
  }

  const retained = await syncState.localPersistence.retainRefusedProjects(syncState.unretainedRefusedProjects);

  assertOwner(syncState);
  if (retained) {
    syncState.unretainedRefusedProjects = [];
  }

  return retained;
};

/**
 * Rehydrate a document into a live project. This is the half of the codec that
 * needs the aggregate reducer, so it stays here rather than in
 * `./projectDocument`; Launchpad callers reach it through a dynamic import.
 */
export const deserializeProjectDocument = (data: Record<string, unknown>): ProjectLoadResult => {
  const normalizedData = normalizeLegacyProjectDocument(data);

  if (!isProjectDocumentShape(normalizedData)) {
    return { status: 'unavailable' };
  }

  const result = loadWorkbenchProject({ ...normalizedData, undoRedo: { future: [], past: [] } } as unknown as Project);

  return result.status === 'refused' ? { refused: { ...result.refused, raw: data }, status: 'refused' } : result;
};

const getSyncMapStorageKey = (syncState: SyncedPersistenceState): string =>
  `${SYNC_MAP_BASE_KEY}${syncState.owner.storageSuffix}`;

/**
 * The revision map survives reloads so an offline runtime can tell "synced before, now gone from
 * the server — recover it" apart from "created offline — push it". Pending markers and deletion
 * tombstones are written before the document cache/network transition they witness.
 */
const persistSyncMap = (syncState: SyncedPersistenceState): boolean => {
  assertOwner(syncState);

  try {
    const revisions: Record<string, number> = {};
    const minimumCanvasSchemaVersions: Record<string, number> = {};
    const pendingProjectMinimumCanvasSchemaVersions = Object.fromEntries(
      syncState.pendingProjectMinimumCanvasSchemaVersions
    );

    for (const [projectId, entry] of syncState.syncEntries) {
      revisions[projectId] = entry.revision;
      minimumCanvasSchemaVersions[projectId] = entry.minimumCanvasSchemaVersion;
    }

    window.localStorage.setItem(
      getSyncMapStorageKey(syncState),
      JSON.stringify({
        collisionProjectIds: [...syncState.collisionProjectIds],
        deletedProjectIds: [...syncState.deletedProjectIds],
        minimumCanvasSchemaVersions,
        pendingProjectIds: [...syncState.pendingProjectIds],
        pendingProjectMinimumCanvasSchemaVersions,
        pendingRecoveryIdentities: Object.fromEntries(syncState.pendingRecoveryIdentities),
        revisions,
      })
    );
    return true;
  } catch {
    return false;
  }
};

interface PersistedSyncMap {
  collisionProjectIds: string[];
  deletedProjectIds: string[];
  minimumCanvasSchemaVersions: Record<string, number>;
  pendingProjectIds: string[];
  pendingProjectMinimumCanvasSchemaVersions: Record<string, number>;
  pendingRecoveryIdentities: Record<string, PendingRecoveryReservation>;
  revisions: Record<string, number>;
}

const loadPersistedSyncMap = (syncState: SyncedPersistenceState): PersistedSyncMap => {
  assertOwner(syncState);

  try {
    const raw = window.localStorage.getItem(getSyncMapStorageKey(syncState));
    const parsed = raw
      ? (JSON.parse(raw) as {
          collisionProjectIds?: unknown;
          deletedProjectIds?: unknown;
          minimumCanvasSchemaVersions?: Record<string, number>;
          pendingProjectIds?: unknown;
          pendingProjectMinimumCanvasSchemaVersions?: Record<string, unknown>;
          pendingRecoveryIdentities?: Record<string, unknown>;
          revisions?: Record<string, number>;
        })
      : null;

    return {
      collisionProjectIds: Array.isArray(parsed?.collisionProjectIds)
        ? parsed.collisionProjectIds.filter((id): id is string => typeof id === 'string')
        : [],
      deletedProjectIds: Array.isArray(parsed?.deletedProjectIds)
        ? parsed.deletedProjectIds.filter((id): id is string => typeof id === 'string')
        : [],
      minimumCanvasSchemaVersions: parsed?.minimumCanvasSchemaVersions ?? {},
      pendingProjectIds: Array.isArray(parsed?.pendingProjectIds)
        ? parsed.pendingProjectIds.filter((id): id is string => typeof id === 'string')
        : [],
      pendingProjectMinimumCanvasSchemaVersions: Object.fromEntries(
        Object.entries(parsed?.pendingProjectMinimumCanvasSchemaVersions ?? {}).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 1
        )
      ),
      pendingRecoveryIdentities: Object.fromEntries(
        Object.entries(parsed?.pendingRecoveryIdentities ?? {}).filter(
          (entry): entry is [string, PendingRecoveryReservation] => {
            if (typeof entry[1] !== 'object' || entry[1] === null) {
              return false;
            }

            const reservation = entry[1] as Partial<PendingRecoveryReservation>;
            const identity = reservation.identity as Partial<ProjectRecoveredIdentity> | undefined;

            return (
              typeof reservation.sourceDocumentFingerprint === 'string' &&
              typeof identity === 'object' &&
              identity !== null &&
              typeof identity.id === 'string' &&
              typeof identity.name === 'string' &&
              typeof identity.recoveredAt === 'string' &&
              typeof identity.recoveryOf === 'string'
            );
          }
        )
      ),
      revisions: parsed?.revisions ?? {},
    };
  } catch {
    return {
      collisionProjectIds: [],
      deletedProjectIds: [],
      minimumCanvasSchemaVersions: {},
      pendingProjectIds: [],
      pendingProjectMinimumCanvasSchemaVersions: {},
      pendingRecoveryIdentities: {},
      revisions: {},
    };
  }
};

type PushNewProjectOutcome =
  | { kind: 'acknowledged' }
  | { kind: 'collision' }
  | { kind: 'failed' }
  | { kind: 'forked'; resolution: ProjectConflictResolution }
  | { kind: 'schema-refused'; refusal: ProjectSchemaRefusal };

const getRaisedCanvasSchemaFloor = (
  document: Record<string, unknown>,
  retainedMinimumCanvasSchemaVersion: number
): number | undefined => {
  const required = getProjectCanvasSchemaRequirement(document);

  return required > retainedMinimumCanvasSchemaVersion ? required : undefined;
};

/** Durably mark cached bytes as unacknowledged before any network request can race a reload. */
const markProjectPending = (syncState: SyncedPersistenceState, project: Project): void => {
  const { json } = getSerializedProjectDocument(syncState, project);

  if (syncState.syncEntries.get(project.id)?.pushedDoc !== json) {
    syncState.pendingProjectIds.add(project.id);
  }
};

const settleProjectPendingMarker = (
  syncState: SyncedPersistenceState,
  projectId: string,
  outcome: ProjectPushOutcome
): void => {
  if (outcome.kind === 'acknowledged' || outcome.kind === 'superseded') {
    syncState.pendingProjectIds.delete(projectId);
    syncState.pendingProjectMinimumCanvasSchemaVersions.delete(projectId);
  } else {
    syncState.pendingProjectIds.add(projectId);
  }
};

/** Project identity evidence is removable only after the durable cache no longer contains it. */
const settleProjectAbsenceAfterCacheWrite = (
  syncState: SyncedPersistenceState,
  persistedState: WorkbenchState
): void => {
  const persistedIds = new Set(persistedState.projects.map((project) => project.id));

  for (const projectId of new Set([...syncState.deletedProjectIds, ...syncState.releasedProjectIds])) {
    if (persistedIds.has(projectId)) {
      continue;
    }

    syncState.deletedProjectIds.delete(projectId);
    syncState.collisionProjectIds.delete(projectId);
    syncState.releasedProjectIds.delete(projectId);
    syncState.syncEntries.delete(projectId);
    syncState.schemaRefusals.delete(projectId);
    syncState.pendingProjectIds.delete(projectId);
    syncState.pendingProjectMinimumCanvasSchemaVersions.delete(projectId);
    syncState.pendingRecoveryIdentities.delete(projectId);
    for (const [sourceProjectId, reservation] of syncState.pendingRecoveryIdentities) {
      if (reservation.identity.id === projectId) {
        syncState.pendingRecoveryIdentities.delete(sourceProjectId);
      }
    }
  }
};

/** Retire a recovery reservation only after both acknowledged documents share one durable cache snapshot. */
const settleRecoveryReservationsAfterCacheWrite = (
  syncState: SyncedPersistenceState,
  persistedState: WorkbenchState
): void => {
  const persistedById = new Map(persistedState.projects.map((project) => [project.id, project]));

  for (const [sourceProjectId, reservation] of syncState.pendingRecoveryIdentities) {
    const sourceProject = persistedById.get(sourceProjectId);
    const recoveredProject = persistedById.get(reservation.identity.id);

    if (!sourceProject || !recoveredProject) {
      continue;
    }

    const sourceEntry = syncState.syncEntries.get(sourceProjectId);
    const recoveredEntry = syncState.syncEntries.get(reservation.identity.id);

    if (
      sourceEntry?.pushedDoc === getSerializedProjectDocument(syncState, sourceProject).json &&
      recoveredEntry?.pushedDoc === getSerializedProjectDocument(syncState, recoveredProject).json
    ) {
      syncState.pendingRecoveryIdentities.delete(sourceProjectId);
    }
  }
};

/** Import a never-synced project to the server, preserving terminal schema refusals. */
const pushNewProject = async (syncState: SyncedPersistenceState, project: Project): Promise<PushNewProjectOutcome> => {
  assertOwner(syncState);
  const document = serializeProjectDocument(project);

  try {
    const created = await apiCreateProject(
      {
        data: document,
        minimum_canvas_schema_version: Math.max(
          getProjectCanvasSchemaRequirement(document),
          syncState.pendingProjectMinimumCanvasSchemaVersions.get(project.id) ?? 1
        ),
        name: project.name,
        project_id: project.id,
      },
      syncState.owner.signal
    );

    assertOwner(syncState);
    syncState.syncEntries.set(project.id, {
      minimumCanvasSchemaVersion: created.minimum_canvas_schema_version,
      pushedDoc: JSON.stringify(document),
      revision: created.revision,
    });
    syncState.pendingBoardAssignments.push({ boardId: created.board_id, projectId: project.id });

    return { kind: 'acknowledged' };
  } catch (error) {
    assertOwner(syncState);

    if (isProjectConflictError(error)) {
      // A 409 permanently proves this id was occupied. Record that fact before the follow-up GET:
      // its response can be lost or the remote project can disappear, but neither makes the id
      // safe to POST again.
      syncState.collisionProjectIds.add(project.id);
      if (!persistSyncMap(syncState)) {
        syncState.hasPending = true;
      }

      // A create has no common revision base. If the bytes differ, preserving both documents is
      // the only safe resolution; adopting the revision and issuing a PUT would overwrite an
      // unrelated server project that merely collided on id.
      try {
        const existing = await apiGetProject(project.id, syncState.owner.signal);

        assertOwner(syncState);
        const { pushedDoc } = adoptRecordBaseline(existing);
        const existingEntry: SyncEntry = {
          minimumCanvasSchemaVersion: existing.minimum_canvas_schema_version,
          pushedDoc,
          revision: existing.revision,
        };

        if (JSON.stringify(existing.data) === JSON.stringify(document)) {
          syncState.collisionProjectIds.delete(project.id);
          syncState.syncEntries.set(project.id, existingEntry);
          syncState.pendingBoardAssignments.push({ boardId: existing.board_id, projectId: project.id });

          return { kind: 'acknowledged' };
        }

        const outcome = await forkProjectAgainstServer(
          syncState,
          project,
          document,
          existing,
          Math.max(
            existing.minimum_canvas_schema_version,
            syncState.pendingProjectMinimumCanvasSchemaVersions.get(project.id) ?? 1
          )
        );

        if (outcome.kind === 'forked') {
          syncState.collisionProjectIds.delete(project.id);
          syncState.syncEntries.set(project.id, existingEntry);
          syncState.pendingBoardAssignments.push({ boardId: existing.board_id, projectId: project.id });
        }

        return outcome;
      } catch {
        assertOwner(syncState);
        return { kind: 'collision' };
      }
    }

    const refusal = rememberServerSchemaRefusal(syncState, project.id, error);

    return refusal ? { kind: 'schema-refused', refusal } : { kind: 'failed' };
  }
};

/** Strip any number of stacked "(recovered)" suffixes left by older recoveries. */
const getRecoveryBaseName = (name: string): string => name.replace(/(\s*\((?:r|R)ecovered\))+$/u, '').trim() || name;

const applyRecoveredIdentity = (
  document: Record<string, unknown>,
  recoveredIdentity: ProjectRecoveredIdentity
): Record<string, unknown> => ({
  ...document,
  id: recoveredIdentity.id,
  name: recoveredIdentity.name,
  recoveredAt: recoveredIdentity.recoveredAt,
  recoveryOf: recoveredIdentity.recoveryOf,
});

const fingerprintProjectDocument = async (document: Record<string, unknown>): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Lineage points at the root original, so a recovery of a recovery still keys to the first. */
export const createRecoveredDocument = (
  project: Project,
  document: Record<string, unknown>
): { recoveredIdentity: ProjectRecoveredIdentity; recoveredDocument: Record<string, unknown> } => {
  const recoveryOf = project.recoveryOf ?? project.id;
  const recoveredIdentity: ProjectRecoveredIdentity = {
    id: createProjectId(),
    name: `${getRecoveryBaseName(project.name)} (recovered)`,
    recoveredAt: new Date().toISOString(),
    recoveryOf,
  };

  return {
    recoveredDocument: applyRecoveredIdentity(document, recoveredIdentity),
    recoveredIdentity,
  };
};

interface PreparedRecoveryDocument {
  isFresh: boolean;
  recoveredDocument: Record<string, unknown>;
  recoveredIdentity: ProjectRecoveredIdentity;
}

const reserveFreshRecoveryDocument = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>
): Promise<PreparedRecoveryDocument | null> => {
  const prepared = createRecoveredDocument(project, document);
  syncState.pendingRecoveryIdentities.set(project.id, {
    identity: prepared.recoveredIdentity,
    sourceDocumentFingerprint: await fingerprintProjectDocument(document),
  });

  if (!persistSyncMap(syncState)) {
    syncState.pendingRecoveryIdentities.delete(project.id);
    syncState.hasPending = true;

    return null;
  }

  return { ...prepared, isFresh: true };
};

const prepareRecoveredDocument = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>
): Promise<PreparedRecoveryDocument | null> => {
  const existingReservation = syncState.pendingRecoveryIdentities.get(project.id);
  const sourceDocumentFingerprint = await fingerprintProjectDocument(document);

  if (existingReservation?.sourceDocumentFingerprint === sourceDocumentFingerprint) {
    return {
      isFresh: false,
      recoveredDocument: applyRecoveredIdentity(document, existingReservation.identity),
      recoveredIdentity: existingReservation.identity,
    };
  }

  return reserveFreshRecoveryDocument(syncState, project, document);
};

interface CreatedRecoveryProject {
  created: ProjectRecordDTO;
  recoveredDocument: Record<string, unknown>;
  recoveredIdentity: ProjectRecoveredIdentity;
}

const createOrAdoptRecoveryProject = async (
  syncState: SyncedPersistenceState,
  sourceProject: Project,
  sourceDocument: Record<string, unknown>,
  prepared: PreparedRecoveryDocument,
  minimumCanvasSchemaVersion: number
): Promise<CreatedRecoveryProject> => {
  let recovery = prepared;

  if (!recovery.isFresh) {
    try {
      const existing = await apiGetProject(recovery.recoveredIdentity.id, syncState.owner.signal);
      assertOwner(syncState);

      if (
        JSON.stringify(existing.data) === JSON.stringify(recovery.recoveredDocument) &&
        existing.minimum_canvas_schema_version >= minimumCanvasSchemaVersion
      ) {
        return {
          created: existing,
          recoveredDocument: recovery.recoveredDocument,
          recoveredIdentity: recovery.recoveredIdentity,
        };
      }
    } catch (error) {
      assertOwner(syncState);

      if (!isProjectNotFoundError(error)) {
        throw error;
      }
    }

    // A persisted reservation that is absent was either deleted after an indeterminate create or
    // never committed. Those cases are indistinguishable, so never POST the old id and resurrect it.
    const rotated = await reserveFreshRecoveryDocument(syncState, sourceProject, sourceDocument);

    if (!rotated) {
      throw new Error('Could not durably rotate the recovery project identity.');
    }
    recovery = rotated;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { recoveredDocument, recoveredIdentity } = recovery;

    try {
      const created = await apiCreateProject(
        {
          data: recoveredDocument,
          minimum_canvas_schema_version: Math.max(
            getProjectCanvasSchemaRequirement(recoveredDocument),
            minimumCanvasSchemaVersion
          ),
          name: recoveredIdentity.name,
          project_id: recoveredIdentity.id,
        },
        syncState.owner.signal
      );

      return { created, recoveredDocument, recoveredIdentity };
    } catch (error) {
      assertOwner(syncState);

      if (!isProjectConflictError(error)) {
        throw error;
      }

      const existing = await apiGetProject(recoveredIdentity.id, syncState.owner.signal);
      assertOwner(syncState);

      if (
        JSON.stringify(existing.data) === JSON.stringify(recoveredDocument) &&
        existing.minimum_canvas_schema_version >= minimumCanvasSchemaVersion
      ) {
        return { created: existing, recoveredDocument, recoveredIdentity };
      }

      if (attempt > 0) {
        throw error;
      }

      // The reservation is occupied by different bytes: rotate it durably before another POST.
      // This covers a genuine UUID collision and a source edited after a response-lost recovery.
      const rotated = await reserveFreshRecoveryDocument(syncState, sourceProject, sourceDocument);

      if (!rotated) {
        throw new Error('Could not durably rotate the recovery project identity.', { cause: error });
      }
      recovery = rotated;
    }
  }

  throw new Error('Could not create a recovery project.');
};

type ConflictOutcome =
  | { kind: 'adopted' }
  | { kind: 'retry' }
  | { kind: 'forked'; resolution: ProjectConflictResolution }
  | { kind: 'schema-refused'; refusal: ProjectSchemaRefusal }
  | { kind: 'failed' };

/** Preserve a divergent local document beside the authoritative server document. */
const forkProjectAgainstServer = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>,
  server: ProjectRecordDTO,
  retainedMinimumCanvasSchemaVersion: number
): Promise<Extract<ConflictOutcome, { kind: 'failed' | 'forked' }>> => {
  const serverResult = deserializeProjectRecord(server);

  if (serverResult.status !== 'loaded') {
    return { kind: 'failed' };
  }

  const prepared = await prepareRecoveredDocument(syncState, project, document);

  if (!prepared) {
    return { kind: 'failed' };
  }

  const recovery = await createOrAdoptRecoveryProject(
    syncState,
    project,
    document,
    prepared,
    retainedMinimumCanvasSchemaVersion
  );
  const recoveredResult = deserializeProjectDocument(recovery.recoveredDocument);

  if (recoveredResult.status !== 'loaded') {
    return { kind: 'failed' };
  }

  assertOwner(syncState);
  syncState.syncEntries.set(recovery.recoveredIdentity.id, {
    minimumCanvasSchemaVersion: recovery.created.minimum_canvas_schema_version,
    pushedDoc: JSON.stringify(serializeProjectDocument(recoveredResult.project)),
    revision: recovery.created.revision,
  });
  syncState.pendingBoardAssignments.push({
    boardId: recovery.created.board_id,
    projectId: recovery.recoveredIdentity.id,
  });

  return {
    kind: 'forked',
    resolution: {
      projectId: project.id,
      recoveredIdentity: recovery.recoveredIdentity,
      recoveredProject: recoveredResult.project,
      serverProject: serverResult.project,
    },
  };
};

/**
 * A save lost the revision race. Forking is the last resort — only when content actually diverged:
 *
 * - server content == what we pushed → adopt the revision, done
 * - server content == this edit's base → revisions drifted without divergence; adopt and retry
 * - anything else → the server version keeps the id, the local edits fork into "(recovered)"
 */
const recoverConflictingProject = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>,
  documentJson: string,
  basePushedDoc: string | null,
  retainedMinimumCanvasSchemaVersion: number
): Promise<ConflictOutcome> => {
  assertOwner(syncState);

  try {
    const server = await apiGetProject(project.id, syncState.owner.signal);

    assertOwner(syncState);
    const { pushedDoc: serverDocJson, result: serverResult } = adoptRecordBaseline(server);
    const serverEntry: SyncEntry = {
      minimumCanvasSchemaVersion: server.minimum_canvas_schema_version,
      pushedDoc: serverDocJson,
      revision: server.revision,
    };

    if (serverDocJson === documentJson) {
      syncState.syncEntries.set(project.id, serverEntry);

      return { kind: 'adopted' };
    }

    if (basePushedDoc !== null && serverDocJson === basePushedDoc) {
      syncState.syncEntries.set(project.id, serverEntry);

      return { kind: 'retry' };
    }

    if (serverResult.status !== 'loaded') {
      return { kind: 'failed' };
    }

    const outcome = await forkProjectAgainstServer(
      syncState,
      project,
      document,
      server,
      Math.max(retainedMinimumCanvasSchemaVersion, server.minimum_canvas_schema_version)
    );

    if (outcome.kind === 'forked') {
      syncState.syncEntries.set(project.id, serverEntry);
    }

    return outcome;
  } catch (error) {
    assertOwner(syncState);

    const refusal = rememberServerSchemaRefusal(syncState, project.id, error);

    return refusal ? { kind: 'schema-refused', refusal } : { kind: 'failed' };
  }
};

type DeletionForkOutcome =
  | { kind: 'forked'; fork: ProjectDeletionFork }
  /** The 404 was this browser's own deletion. There is nothing to rescue and nothing went wrong. */
  | { kind: 'abandoned' }
  | { kind: 'failed' };

/**
 * Rescue the local edits of a project the server no longer has. A *fork*, not a re-create: pushing
 * the original id back would resurrect a project the user deleted, on every device. The fork gets a
 * fresh id, and with it a fresh board from the create response.
 */
const forkDeletedProject = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>,
  retainedMinimumCanvasSchemaVersion: number,
  options?: { allowMarkedSource?: boolean }
): Promise<DeletionForkOutcome> => {
  assertOwner(syncState);

  const prepared = await prepareRecoveredDocument(syncState, project, document);

  if (!prepared) {
    return { kind: 'failed' };
  }

  try {
    const recovery = await createOrAdoptRecoveryProject(
      syncState,
      project,
      document,
      prepared,
      retainedMinimumCanvasSchemaVersion
    );
    const recoveredResult = deserializeProjectDocument(recovery.recoveredDocument);

    if (recoveredResult.status !== 'loaded') {
      return { kind: 'failed' };
    }

    assertOwner(syncState);

    // Re-read after the create, not just before it. `deleteLibraryProject` marks the id before
    // issuing its DELETE, but a PUT already on the wire is past that check — the 404 that brought us
    // here can be this browser's own deletion arriving first. Forking on it would resurrect the
    // project the person just deleted, as a copy pointing at media the deletion already removed.
    if (!options?.allowMarkedSource && syncState.deletedProjectIds.has(project.id)) {
      try {
        await apiDeleteProject(recovery.recoveredIdentity.id, syncState.owner.signal);
      } catch {
        // The fork is an empty private project either way; failing to remove it is clutter, not a
        // broken state, and it must not replace the deletion's own outcome.
      }

      assertOwner(syncState);
      syncState.syncEntries.delete(recovery.recoveredIdentity.id);

      return { kind: 'abandoned' };
    }

    syncState.syncEntries.set(recovery.recoveredIdentity.id, {
      minimumCanvasSchemaVersion: recovery.created.minimum_canvas_schema_version,
      pushedDoc: JSON.stringify(serializeProjectDocument(recoveredResult.project)),
      revision: recovery.created.revision,
    });
    syncState.pendingBoardAssignments.push({
      boardId: recovery.created.board_id,
      projectId: recovery.recoveredIdentity.id,
    });

    return {
      fork: {
        projectId: project.id,
        recoveredIdentity: recovery.recoveredIdentity,
        recoveredProject: recoveredResult.project,
      },
      kind: 'forked',
    };
  } catch {
    assertOwner(syncState);

    return { kind: 'failed' };
  }
};

/** Re-key a document whose original id is known unsafe to create, preserving it under a fresh id. */
const recoverReservedProjectId = async (
  syncState: SyncedPersistenceState,
  project: Project,
  document: Record<string, unknown>,
  documentJson: string,
  retainedMinimumCanvasSchemaVersion: number
): Promise<ProjectPushOutcome> => {
  const outcome = await forkDeletedProject(syncState, project, document, retainedMinimumCanvasSchemaVersion);

  assertOwner(syncState);
  if (outcome.kind === 'failed') {
    syncState.hasPending = true;

    return { documentJson, kind: 'unsynced' };
  }

  if (outcome.kind === 'forked') {
    // The recovered server record makes the local bytes crash-durable. Keep the original guarded
    // until aggregate reconciliation and a cache write replace it with the recovered identity.
    syncState.forkedProjectIds.add(project.id);
    syncState.deletedProjectIds.add(project.id);
    syncState.pendingDeletedForks.push(outcome.fork);
  }

  return { documentJson, kind: 'superseded' };
};

/** Resolve tombstones whose DELETE/rollback outcome was lost before replacing any cached bytes. */
const reconcileUnconfirmedDeletions = async (
  syncState: SyncedPersistenceState,
  liveProjects: readonly Project[]
): Promise<boolean> => {
  const liveProjectsById = new Map(liveProjects.map((project) => [project.id, project]));

  for (const projectId of syncState.unconfirmedDeletionProjectIds) {
    const hiddenProject = liveProjectsById.get(projectId) ?? syncState.cachedProjectsById.get(projectId);

    if (!hiddenProject) {
      return false;
    }

    const { document, json: documentJson } = getSerializedProjectDocument(syncState, hiddenProject);
    let record: ProjectRecordDTO;

    try {
      record = await apiGetProject(projectId, syncState.owner.signal);
    } catch (error) {
      assertOwner(syncState);

      if (isProjectNotFoundError(error)) {
        if (liveProjectsById.has(projectId)) {
          const recovery = await forkDeletedProject(
            syncState,
            hiddenProject,
            document,
            syncState.pendingProjectMinimumCanvasSchemaVersions.get(projectId) ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
            { allowMarkedSource: true }
          );

          assertOwner(syncState);
          if (recovery.kind !== 'forked') {
            return false;
          }

          syncState.pendingDeletedForks.push(recovery.fork);
          syncState.forkedProjectIds.add(projectId);
        }

        // DELETE committed. The tombstone remains until the next cache snapshot omits the project.
        syncState.unconfirmedDeletionProjectIds.delete(projectId);
        continue;
      }

      return false;
    }

    assertOwner(syncState);
    const serverDocumentJson = JSON.stringify(record.data);
    const serverEntry: SyncEntry = {
      minimumCanvasSchemaVersion: record.minimum_canvas_schema_version,
      pushedDoc: serverDocumentJson,
      revision: record.revision,
    };
    const serverResult = deserializeProjectRecord(record);

    if (serverResult.status !== 'loaded') {
      const recovery = await forkDeletedProject(
        syncState,
        hiddenProject,
        document,
        syncState.pendingProjectMinimumCanvasSchemaVersions.get(projectId) ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
        { allowMarkedSource: true }
      );

      assertOwner(syncState);
      if (recovery.kind !== 'forked') {
        return false;
      }

      syncState.syncEntries.set(projectId, serverEntry);
      syncState.pendingDeletedForks.push(recovery.fork);
      syncState.forkedProjectIds.add(projectId);
      syncState.deletedProjectIds.delete(projectId);
      syncState.unconfirmedDeletionProjectIds.delete(projectId);
      continue;
    }

    if (serverDocumentJson === documentJson) {
      // DELETE did not commit, but the server already has every cached byte.
      syncState.syncEntries.set(projectId, serverEntry);
      syncState.deletedProjectIds.delete(projectId);
      syncState.unconfirmedDeletionProjectIds.delete(projectId);
      continue;
    }

    const outcome = await forkProjectAgainstServer(
      syncState,
      hiddenProject,
      document,
      record,
      Math.max(
        record.minimum_canvas_schema_version,
        syncState.pendingProjectMinimumCanvasSchemaVersions.get(projectId) ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION
      )
    );

    assertOwner(syncState);
    if (outcome.kind !== 'forked') {
      return false;
    }

    // The server keeps its authoritative project; the hidden cached edit is now a durable recovery.
    syncState.syncEntries.set(projectId, serverEntry);
    syncState.pendingConflicts.push(outcome.resolution);
    syncState.forkedProjectIds.add(projectId);
    syncState.deletedProjectIds.delete(projectId);
    syncState.unconfirmedDeletionProjectIds.delete(projectId);
  }

  persistSyncMap(syncState);
  return true;
};

const pushProject = async (syncState: SyncedPersistenceState, project: Project): Promise<ProjectPushOutcome> => {
  assertOwner(syncState);
  const { document, json: documentJson } = getSerializedProjectDocument(syncState, project);
  const entry = syncState.syncEntries.get(project.id);
  const rememberedSchemaRefusal = syncState.schemaRefusals.get(project.id);

  if (rememberedSchemaRefusal) {
    return { documentJson, kind: 'schema-refused', refusal: rememberedSchemaRefusal };
  }

  if (syncState.deletedProjectIds.has(project.id)) {
    if (syncState.unconfirmedDeletionProjectIds.has(project.id)) {
      syncState.hasPending = true;

      return { documentJson, kind: 'unsynced' };
    }

    return { documentJson, kind: 'superseded' };
  }

  // Until the aggregate explicitly acknowledges applying the resolution, this id still contains
  // the divergent local document. Serialized equality is not a valid acknowledgement: hydration
  // injects the authoritative board and reconciliation deliberately advances documentRevision.
  if (syncState.forkedProjectIds.has(project.id)) {
    return { documentJson, kind: 'superseded' };
  }

  if (!entry && syncState.collisionProjectIds.has(project.id)) {
    return recoverReservedProjectId(
      syncState,
      project,
      document,
      documentJson,
      syncState.pendingProjectMinimumCanvasSchemaVersions.get(project.id) ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION
    );
  }

  if (entry?.pushedDoc === documentJson) {
    return { documentJson, kind: 'acknowledged' };
  }

  if (!entry) {
    const outcome = await pushNewProject(syncState, project);

    if (outcome.kind === 'schema-refused') {
      return { documentJson, kind: 'schema-refused', refusal: outcome.refusal };
    }

    if (outcome.kind === 'failed') {
      assertOwner(syncState);
      syncState.hasPending = true;

      return { documentJson, kind: 'unsynced' };
    }

    if (outcome.kind === 'collision') {
      return recoverReservedProjectId(
        syncState,
        project,
        document,
        documentJson,
        syncState.pendingProjectMinimumCanvasSchemaVersions.get(project.id) ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION
      );
    }

    if (outcome.kind === 'forked') {
      syncState.pendingConflicts.push(outcome.resolution);
      syncState.forkedProjectIds.add(project.id);

      return { documentJson, kind: 'superseded' };
    }

    assertOwner(syncState);
    return { documentJson, kind: 'acknowledged' };
  }

  try {
    const raisedFloor = getRaisedCanvasSchemaFloor(document, entry.minimumCanvasSchemaVersion);
    const updated = await apiUpdateProject(
      project.id,
      {
        data: document,
        expected_revision: entry.revision,
        name: project.name,
        ...(raisedFloor === undefined ? {} : { minimum_canvas_schema_version: raisedFloor }),
      },
      syncState.owner.signal
    );

    assertOwner(syncState);
    syncState.syncEntries.set(project.id, {
      minimumCanvasSchemaVersion: updated.minimum_canvas_schema_version,
      pushedDoc: documentJson,
      revision: updated.revision,
    });
  } catch (error) {
    assertOwner(syncState);

    if (isProjectConflictError(error)) {
      const outcome = await recoverConflictingProject(
        syncState,
        project,
        document,
        documentJson,
        entry.pushedDoc,
        entry.minimumCanvasSchemaVersion
      );

      assertOwner(syncState);
      if (outcome.kind === 'retry') {
        try {
          const adoptedEntry = syncState.syncEntries.get(project.id) ?? entry;
          const raisedFloor = getRaisedCanvasSchemaFloor(document, adoptedEntry.minimumCanvasSchemaVersion);
          const retried = await apiUpdateProject(
            project.id,
            {
              data: document,
              expected_revision: adoptedEntry.revision,
              name: project.name,
              ...(raisedFloor === undefined ? {} : { minimum_canvas_schema_version: raisedFloor }),
            },
            syncState.owner.signal
          );

          assertOwner(syncState);
          syncState.syncEntries.set(project.id, {
            minimumCanvasSchemaVersion: retried.minimum_canvas_schema_version,
            pushedDoc: documentJson,
            revision: retried.revision,
          });
        } catch (retryError) {
          assertOwner(syncState);
          const refusal = rememberServerSchemaRefusal(syncState, project.id, retryError);

          if (refusal) {
            return { documentJson, kind: 'schema-refused', refusal };
          }

          // A genuinely concurrent writer; the next save re-evaluates.
          syncState.hasPending = true;

          return { documentJson, kind: 'unsynced' };
        }
      } else if (outcome.kind === 'forked') {
        syncState.pendingConflicts.push(outcome.resolution);
        syncState.forkedProjectIds.add(project.id);

        // This id now holds the server's version, not ours.
        return { documentJson, kind: 'superseded' };
      } else if (outcome.kind === 'schema-refused') {
        return { documentJson, kind: 'schema-refused', refusal: outcome.refusal };
      } else if (outcome.kind === 'failed') {
        syncState.hasPending = true;

        return { documentJson, kind: 'unsynced' };
      }
      // 'adopted': the server already held these exact bytes, so the push had nothing to do.
    } else if (isProjectNotFoundError(error)) {
      // Deleted on another device while we held local edits. Re-creating under the same id would
      // undo that deletion — the project would reappear on every device, and on this one it would
      // be a project whose board the deletion already took. Fork instead: the deletion stands, and
      // the local work survives as a recovered project with its own id and its own board.
      // Unless the deletion was ours. `markDeleted` runs before the DELETE, but a PUT already on the
      // wire is past the check at the top of this function, so a fast DELETE can turn our own push
      // into a 404 — and forking on that resurrects, server-side, exactly what the person deleted.
      if (syncState.deletedProjectIds.has(project.id)) {
        return { documentJson, kind: 'superseded' };
      }

      return recoverReservedProjectId(syncState, project, document, documentJson, entry.minimumCanvasSchemaVersion);
    } else {
      const refusal = rememberServerSchemaRefusal(syncState, project.id, error);

      if (refusal) {
        return { documentJson, kind: 'schema-refused', refusal };
      }

      syncState.hasPending = true;

      return { documentJson, kind: 'unsynced' };
    }
  }

  assertOwner(syncState);
  return { documentJson, kind: 'acknowledged' };
};

const pushSessionState = async (syncState: SyncedPersistenceState, state: WorkbenchState): Promise<void> => {
  assertOwner(syncState);
  const blob = serializeSessionBlob(state);

  if (blob === syncState.lastPushedAccount) {
    return;
  }

  try {
    await setClientStateValue(SESSION_STATE_KEY, blob, syncState.owner.signal);

    assertOwner(syncState);
    syncState.lastPushedAccount = blob;
  } catch {
    assertOwner(syncState);
    syncState.hasPending = true;
  }
};

const loadFromBackend = async (
  syncState: SyncedPersistenceState,
  local: HydratedWorkbenchSnapshot | null,
  options?: WorkbenchLoadOptions
): Promise<HydratedWorkbenchSnapshot> => {
  assertOwner(syncState);
  const [summaries, sessionBlob] = await Promise.all([
    listProjects(syncState.owner.signal),
    fetchSessionBlob(syncState.owner.signal),
  ]);

  assertOwner(syncState);
  syncState.unconfirmedDeletionProjectIds.clear();
  const persistedSyncMap = loadPersistedSyncMap(syncState);

  syncState.deletedProjectIds = new Set(persistedSyncMap.deletedProjectIds);
  syncState.collisionProjectIds = new Set(persistedSyncMap.collisionProjectIds);
  syncState.pendingProjectIds = new Set(persistedSyncMap.pendingProjectIds);
  syncState.pendingProjectMinimumCanvasSchemaVersions = new Map(
    Object.entries(persistedSyncMap.pendingProjectMinimumCanvasSchemaVersions)
  );
  syncState.pendingRecoveryIdentities = new Map(Object.entries(persistedSyncMap.pendingRecoveryIdentities));

  seedProjectLibrary(summaries, syncState.owner);

  // If the project is still listed, the previous DELETE did not commit. Cancel that tombstone and
  // accept the server record. Unlisted tombstones remain until the ordinary cache omits the project.
  for (const summary of summaries) {
    syncState.deletedProjectIds.delete(summary.project_id);
  }

  // First contact: a backend with no projects adopts the browser's existing
  // workbench (one-time import of the pre-backend localStorage data).
  const hasPreviouslySyncedLocalProject = (local?.state.projects ?? []).some(
    (project) =>
      persistedSyncMap.revisions[project.id] !== undefined ||
      persistedSyncMap.deletedProjectIds.includes(project.id) ||
      persistedSyncMap.pendingProjectIds.includes(project.id)
  );

  if (summaries.length === 0 && local && local.state.projects.length > 0 && !hasPreviouslySyncedLocalProject) {
    let importedState: WorkbenchState = {
      ...local.state,
      account: normalizeWorkbenchAccount(sessionBlob?.account ?? local.state.account),
    };

    for (const project of local.state.projects) {
      markProjectPending(syncState, project);
    }
    if (!persistSyncMap(syncState)) {
      syncState.hasPending = true;

      if (!options?.createNew) {
        return local;
      }

      const draft = createDraftProject(local.state.projects, local.state.account);

      return {
        ...local,
        state: {
          ...local.state,
          activeProjectId: draft.id,
          projects: [...local.state.projects, draft],
        },
      };
    }

    for (const project of local.state.projects) {
      const outcome = await pushProject(syncState, project);

      settleProjectPendingMarker(syncState, project.id, outcome);

      if (outcome.kind === 'schema-refused') {
        await retainSchemaRefusedProject(syncState, project, outcome.refusal);
      }

      assertOwner(syncState);
      const entry = syncState.syncEntries.get(project.id);

      upsertProjectSummary(
        {
          id: project.id,
          ...(entry ? { minimumCanvasSchemaVersion: entry.minimumCanvasSchemaVersion } : {}),
          name: project.name,
          revision: entry?.revision ?? null,
        },
        syncState.owner
      );
    }

    // A first-contact POST may race another client creating the same id. `pushProject` queues the
    // same lossless resolution used by ordinary autosave; apply it here because load has no save
    // result through which the persistence runtime could reconcile it.
    for (const resolution of syncState.pendingConflicts.splice(0)) {
      importedState = {
        ...importedState,
        activeProjectId:
          importedState.activeProjectId === resolution.projectId
            ? resolution.recoveredProject.id
            : importedState.activeProjectId,
        projects: importedState.projects.flatMap((project) =>
          project.id === resolution.projectId ? [resolution.serverProject, resolution.recoveredProject] : [project]
        ),
      };

      for (const project of [resolution.serverProject, resolution.recoveredProject]) {
        const entry = syncState.syncEntries.get(project.id);

        upsertProjectSummary(
          {
            id: project.id,
            ...(entry ? { minimumCanvasSchemaVersion: entry.minimumCanvasSchemaVersion } : {}),
            name: project.name,
            revision: entry?.revision ?? null,
          },
          syncState.owner
        );
      }
      syncState.forkedProjectIds.delete(resolution.projectId);
    }

    for (const fork of syncState.pendingDeletedForks.splice(0)) {
      importedState = {
        ...importedState,
        activeProjectId:
          importedState.activeProjectId === fork.projectId ? fork.recoveredProject.id : importedState.activeProjectId,
        projects: importedState.projects.map((project) =>
          project.id === fork.projectId ? fork.recoveredProject : project
        ),
      };

      const entry = syncState.syncEntries.get(fork.recoveredProject.id);

      upsertProjectSummary(
        {
          id: fork.recoveredProject.id,
          ...(entry ? { minimumCanvasSchemaVersion: entry.minimumCanvasSchemaVersion } : {}),
          name: fork.recoveredProject.name,
          revision: entry?.revision ?? null,
        },
        syncState.owner
      );
    }

    await pushSessionState(syncState, importedState);
    assertOwner(syncState);
    persistSyncMap(syncState);
    reportProjectSync({
      hasPendingChanges: syncState.hasPending,
      projects: Object.fromEntries(
        importedState.projects.map((project) => {
          const entry = syncState.syncEntries.get(project.id);
          const schemaRefusal = syncState.schemaRefusals.get(project.id);

          return [
            project.id,
            {
              isPendingPush:
                entry === undefined || syncState.pendingProjectIds.has(project.id) || schemaRefusal !== undefined,
              revision: entry?.revision ?? null,
              ...(schemaRefusal ? { schemaRefusal } : {}),
            },
          ];
        })
      ),
    });

    if (!options?.createNew) {
      return { ...local, state: importedState };
    }

    const draft = createDraftProject(importedState.projects, importedState.account);
    syncState.hasPending = true;

    return {
      ...local,
      state: {
        ...importedState,
        activeProjectId: draft.id,
        projects: [...importedState.projects, draft],
      },
    };
  }

  // The session blob says which projects are open as tabs; blobs from before
  // the library/session split have no open set, and for those every project
  // opens (exactly what that version of the app did). A deep-linked project
  // joins the set.
  const summaryIds = new Set(summaries.map((summary) => summary.project_id));
  const requestedIds = sessionBlob?.openProjectIds ?? summaries.map((summary) => summary.project_id);
  const pendingCachedIds = (local?.state.projects ?? [])
    .filter((project) => syncState.pendingProjectIds.has(project.id) && !syncState.deletedProjectIds.has(project.id))
    .map((project) => project.id);
  const pendingRecoveryIds = [...syncState.pendingRecoveryIdentities.values()].map(
    (reservation) => reservation.identity.id
  );
  const openIds: string[] = [];

  // The server session may lag a failed local tab/session save. Every durably pending cached
  // project must still be hydrated and reconciled before this load is allowed to replace the
  // primary cache, even when the stale server open-set does not mention it.
  for (const id of [
    ...requestedIds,
    ...pendingCachedIds,
    ...pendingRecoveryIds,
    ...(options?.openProjectId ? [options.openProjectId] : []),
  ]) {
    if (summaryIds.has(id) && !openIds.includes(id)) {
      openIds.push(id);
    }
  }

  // Only the open set is hydrated into full documents; everything else stays
  // a summary in the library. A project deleted between list and get is
  // simply dropped from the session.
  const summaryById = new Map(summaries.map((summary) => [summary.project_id, summary]));
  const recordLoads = await Promise.all(
    openIds.map(async (id) => {
      const summary = summaryById.get(id);

      if (summary && !isCanvasSchemaVersionSupported(summary.minimum_canvas_schema_version)) {
        return {
          refused: toDeclaredSchemaRefusal(id, summary.name, summary.minimum_canvas_schema_version),
          status: 'refused' as const,
        };
      }

      try {
        return { record: await apiGetProject(id, syncState.owner.signal), status: 'loaded' as const };
      } catch (error) {
        assertOwner(syncState);
        const refused = toServerSchemaRefusal(error, id, summaryById.get(id)?.name ?? id);

        if (refused) {
          return { refused, status: 'refused' as const };
        }

        return isProjectNotFoundError(error)
          ? { projectId: id, status: 'deleted' as const }
          : { projectId: id, status: 'unavailable' as const };
      }
    })
  );

  assertOwner(syncState);
  const loadedRecordById = new Map(
    recordLoads.flatMap((load) => (load.status === 'loaded' ? [[load.record.project_id, load.record] as const] : []))
  );
  const serverProjects: Project[] = [];
  const recoveredLocalProjects: Project[] = [];
  const recoveredProjectTransitions: Array<{
    minimumCanvasSchemaVersion: number;
    recoveredIsAcknowledged: boolean;
    recoveredProjectId: string;
    sourceEntry: SyncEntry | null;
    sourceProjectId: string;
  }> = [];
  const unavailableProjectIds = new Set<string>();
  const deletedAfterListProjectIds = new Set<string>();
  const refusedById = new Map((local?.refusedProjects ?? []).map((refused) => [refused.projectId, refused]));
  const localProjectById = new Map((local?.state.projects ?? []).map((project) => [project.id, project]));

  for (const load of recordLoads) {
    if (load.status === 'refused') {
      if (load.refused.refusal.status === 'unsupported-version') {
        syncState.schemaRefusals.set(load.refused.projectId, {
          maxCanvasSchemaVersion: MAX_SUPPORTED_CANVAS_SCHEMA_VERSION,
          minimumCanvasSchemaVersion: load.refused.refusal.version,
        });
      }
      const localProject = localProjectById.get(load.refused.projectId);
      const refused = localProject
        ? (() => {
            const raw = serializeProjectDocument(localProject);

            return {
              ...load.refused,
              projectName: localProject.name,
              raw,
              refusal: { ...load.refused.refusal, raw },
            };
          })()
        : load.refused;

      // The current cache is the newest local edit and wins over an older retained artifact. A
      // metadata-only server refusal may only fill an otherwise empty recovery slot.
      if (localProject || !refusedById.has(refused.projectId)) {
        refusedById.set(refused.projectId, refused);
      }
      continue;
    }

    if (load.status === 'unavailable') {
      unavailableProjectIds.add(load.projectId);
      continue;
    }

    if (load.status === 'deleted') {
      deletedAfterListProjectIds.add(load.projectId);
      summaryIds.delete(load.projectId);
      continue;
    }

    const { record } = load;
    const { pushedDoc: serverDocJson, result } = adoptRecordBaseline(record);

    if (result.status === 'loaded') {
      const localProject = localProjectById.get(record.project_id);
      const hasPendingLocalEdit = localProject && syncState.pendingProjectIds.has(record.project_id);
      const serverEntry: SyncEntry = {
        minimumCanvasSchemaVersion: record.minimum_canvas_schema_version,
        pushedDoc: serverDocJson,
        revision: record.revision,
      };

      if (hasPendingLocalEdit) {
        const localDocument = serializeProjectDocument(localProject);
        const localDocJson = JSON.stringify(localDocument);

        if (localDocJson === serverDocJson) {
          // The acknowledgement landed before the previous runtime could clear its durable
          // pending marker. The server already has the cached bytes.
          syncState.pendingProjectIds.delete(record.project_id);
          syncState.pendingProjectMinimumCanvasSchemaVersions.delete(record.project_id);
          syncState.collisionProjectIds.delete(record.project_id);
          syncState.syncEntries.set(record.project_id, serverEntry);
          serverProjects.push(result.project);
        } else if (persistedSyncMap.revisions[record.project_id] === record.revision) {
          // The server is still at the revision this browser last acknowledged. Keep the cached
          // edit under its original id; the next save can update that revision without clobbering
          // another writer.
          syncState.collisionProjectIds.delete(record.project_id);
          syncState.syncEntries.set(record.project_id, serverEntry);
          serverProjects.push(withAuthoritativeProjectBoard(localProject, record.board_id));
          syncState.hasPending = true;
        } else {
          // Both sides advanced while this browser was offline. The server keeps the id and the
          // cached edit becomes a never-synced recovery project, exactly like a live conflict.
          const pendingRecoveryReservation = syncState.pendingRecoveryIdentities.get(localProject.id);
          const pendingRecoveryIdentity = pendingRecoveryReservation?.identity;
          const localDocumentFingerprint = await fingerprintProjectDocument(localDocument);
          const pendingRecoveryDocument =
            pendingRecoveryReservation?.sourceDocumentFingerprint === localDocumentFingerprint &&
            pendingRecoveryIdentity
              ? applyRecoveredIdentity(localDocument, pendingRecoveryIdentity)
              : null;
          const acknowledgedRecoveryRecord = pendingRecoveryIdentity
            ? loadedRecordById.get(pendingRecoveryIdentity.id)
            : null;
          const minimumCanvasSchemaVersion = Math.max(
            serverEntry.minimumCanvasSchemaVersion,
            persistedSyncMap.minimumCanvasSchemaVersions[record.project_id] ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION
          );
          const recoveredIsAcknowledged = Boolean(
            acknowledgedRecoveryRecord &&
            pendingRecoveryDocument &&
            acknowledgedRecoveryRecord.minimum_canvas_schema_version >= minimumCanvasSchemaVersion &&
            JSON.stringify(acknowledgedRecoveryRecord.data) === JSON.stringify(pendingRecoveryDocument)
          );
          const recoveredDocument = recoveredIsAcknowledged
            ? pendingRecoveryDocument!
            : createRecoveredDocument(localProject, localDocument).recoveredDocument;
          const recovered = deserializeProjectDocument(recoveredDocument);

          serverProjects.push(result.project);

          if (recovered.status === 'loaded') {
            if (!recoveredIsAcknowledged) {
              recoveredLocalProjects.push(recovered.project);
            }
            recoveredProjectTransitions.push({
              minimumCanvasSchemaVersion,
              recoveredIsAcknowledged,
              recoveredProjectId: recovered.project.id,
              sourceEntry: serverEntry,
              sourceProjectId: record.project_id,
            });
            syncState.hasPending = true;
          }
        }
      } else {
        syncState.pendingProjectIds.delete(record.project_id);
        syncState.pendingProjectMinimumCanvasSchemaVersions.delete(record.project_id);
        syncState.collisionProjectIds.delete(record.project_id);
        syncState.syncEntries.set(record.project_id, serverEntry);
        serverProjects.push(result.project);
      }
    } else if (result.status === 'refused') {
      refusedById.set(result.refused.projectId, result.refused);
    }
  }

  if (deletedAfterListProjectIds.size > 0) {
    seedProjectLibrary(
      summaries.filter((summary) => !deletedAfterListProjectIds.has(summary.project_id)),
      syncState.owner
    );
  }

  // Local projects the server does not have: keep never-synced drafts, recover pending edits under
  // a fresh id, and drop only previously-synced documents with no unacknowledged local work.
  const offlineCreated = (local?.state.projects ?? []).filter(
    (project) =>
      !summaryIds.has(project.id) &&
      persistedSyncMap.revisions[project.id] === undefined &&
      !syncState.pendingProjectIds.has(project.id) &&
      !syncState.deletedProjectIds.has(project.id)
  );
  const unavailableCachedProjects = (local?.state.projects ?? []).filter(
    (project) => unavailableProjectIds.has(project.id) && !syncState.deletedProjectIds.has(project.id)
  );

  for (const project of unavailableCachedProjects) {
    const revision = persistedSyncMap.revisions[project.id];

    if (revision !== undefined) {
      syncState.syncEntries.set(project.id, {
        minimumCanvasSchemaVersion:
          persistedSyncMap.minimumCanvasSchemaVersions[project.id] ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
        pushedDoc: null,
        revision,
      });
    }
    syncState.pendingProjectIds.add(project.id);
  }
  const recoveredDeletedProjects: Project[] = [];

  for (const project of local?.state.projects ?? []) {
    if (
      summaryIds.has(project.id) ||
      syncState.deletedProjectIds.has(project.id) ||
      !syncState.pendingProjectIds.has(project.id)
    ) {
      continue;
    }

    const pendingRecoveryReservation = syncState.pendingRecoveryIdentities.get(project.id);
    const pendingRecoveryIdentity = pendingRecoveryReservation?.identity;
    const sourceDocument = serializeProjectDocument(project);
    const sourceDocumentFingerprint = await fingerprintProjectDocument(sourceDocument);
    const pendingRecoveryDocument =
      pendingRecoveryReservation?.sourceDocumentFingerprint === sourceDocumentFingerprint && pendingRecoveryIdentity
        ? applyRecoveredIdentity(sourceDocument, pendingRecoveryIdentity)
        : null;
    const acknowledgedRecoveryRecord = pendingRecoveryIdentity
      ? loadedRecordById.get(pendingRecoveryIdentity.id)
      : undefined;
    const minimumCanvasSchemaVersion =
      persistedSyncMap.pendingProjectMinimumCanvasSchemaVersions[project.id] ??
      persistedSyncMap.minimumCanvasSchemaVersions[project.id] ??
      DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION;
    const recoveredIsAcknowledged = Boolean(
      acknowledgedRecoveryRecord &&
      pendingRecoveryDocument &&
      acknowledgedRecoveryRecord.minimum_canvas_schema_version >= minimumCanvasSchemaVersion &&
      JSON.stringify(acknowledgedRecoveryRecord.data) === JSON.stringify(pendingRecoveryDocument)
    );

    if (recoveredIsAcknowledged && pendingRecoveryIdentity) {
      // A previous POST committed but its response was lost. The durable recovery identity made
      // that record part of hydration even when the saved open-tab set did not mention it.
      recoveredProjectTransitions.push({
        minimumCanvasSchemaVersion,
        recoveredIsAcknowledged: true,
        recoveredProjectId: pendingRecoveryIdentity.id,
        sourceEntry: null,
        sourceProjectId: project.id,
      });

      continue;
    }

    // A missing or different persisted reservation may have been deleted or reused elsewhere.
    // Rotate locally instead of ever POSTing that ambiguous id again.
    const recoveredDocument = createRecoveredDocument(project, sourceDocument).recoveredDocument;
    const recovered = deserializeProjectDocument(recoveredDocument);

    if (recovered.status !== 'loaded') {
      continue;
    }

    // Delay the identity transition until the recovered document is in the primary cache. Before
    // that write, the old pending/revision evidence is what makes the old cache safe; afterwards,
    // the recovered id itself is durable and can become the pending upload.
    recoveredProjectTransitions.push({
      minimumCanvasSchemaVersion,
      recoveredIsAcknowledged: false,
      recoveredProjectId: recovered.project.id,
      sourceEntry: null,
      sourceProjectId: project.id,
    });

    recoveredDeletedProjects.push(recovered.project);
  }

  if (offlineCreated.length > 0 || recoveredDeletedProjects.length > 0 || unavailableCachedProjects.length > 0) {
    syncState.hasPending = true;
  }

  let projects = [
    ...serverProjects,
    ...recoveredLocalProjects,
    ...unavailableCachedProjects,
    ...offlineCreated,
    ...recoveredDeletedProjects,
  ];

  if (sessionBlob) {
    syncState.lastPushedAccount = JSON.stringify(sessionBlob);
  }

  const base = local?.state ?? createInitialWorkbenchState();
  const account = normalizeWorkbenchAccount(sessionBlob?.account ?? base.account);
  let activeProjectId =
    options?.openProjectId && projects.some((project) => project.id === options.openProjectId)
      ? options.openProjectId
      : sessionBlob && projects.some((project) => project.id === sessionBlob.activeProjectId)
        ? sessionBlob.activeProjectId
        : projects.some((project) => project.id === base.activeProjectId)
          ? base.activeProjectId
          : (projects[0]?.id ?? '');

  // An explicit "new project" request, or a session with nothing to open
  // (first run, or /app reached directly with an empty session): start a
  // fresh draft. The first autosave creates it server-side.
  if (options?.createNew || projects.length === 0) {
    const draft = createDraftProject(projects, account);

    projects = [...projects, draft];
    activeProjectId = draft.id;
  }

  const state: WorkbenchState = {
    ...base,
    account,
    activeProjectId,
    autosave: { status: 'idle' },
    backendConnection: { status: 'connecting' },
    notifications: [],
    projects,
  };

  if (serializeSessionBlob(state) !== syncState.lastPushedAccount) {
    syncState.hasPending = true;
  }

  reportProjectSync({
    hasPendingChanges: syncState.hasPending,
    projects: Object.fromEntries(
      projects.map((project) => {
        const entry = syncState.syncEntries.get(project.id);
        const schemaRefusal = syncState.schemaRefusals.get(project.id);

        return [
          project.id,
          {
            isPendingPush:
              entry === undefined || syncState.pendingProjectIds.has(project.id) || schemaRefusal !== undefined,
            revision: entry?.revision ?? null,
            ...(schemaRefusal ? { schemaRefusal } : {}),
          },
        ];
      })
    ),
  });

  if (!persistSyncMap(syncState)) {
    throw new Error('Could not durably record server project revisions.');
  }

  const refusedProjects = [...refusedById.values()];
  const retainedRefusals = await syncState.localPersistence.retainRefusedProjects(refusedProjects);
  assertOwner(syncState);

  if (!retainedRefusals && local) {
    syncState.unretainedRefusedProjects = refusedProjects.filter(
      (project) => project.raw !== null && project.raw !== undefined
    );
    // Do not replace the primary cache unless every project omitted for compatibility has a durable
    // raw recovery copy. The prior snapshot remains the fallback and all refused ids are terminal
    // in this sync lifetime, so a subsequent autosave cannot publish them through this client.
    syncState.hasPending = true;
    reportProjectSync({
      hasPendingChanges: true,
      projects: Object.fromEntries(
        local.state.projects.map((project) => {
          const entry = syncState.syncEntries.get(project.id);
          const schemaRefusal = syncState.schemaRefusals.get(project.id);

          return [
            project.id,
            {
              isPendingPush: true,
              revision: entry?.revision ?? null,
              ...(schemaRefusal ? { schemaRefusal } : {}),
            },
          ];
        })
      ),
    });

    return { ...local, refusedProjects };
  }

  syncState.unretainedRefusedProjects = [];

  // A fresh recovery id and its inherited floor must be durable before the primary cache can swap
  // away the source id. Keep the source evidence too; the transition below retires it only after
  // the cache write succeeds. A crash between these writes may cause a harmless extra re-key, but
  // can never publish the recovered bytes below their source's schema floor.
  const unacknowledgedRecoveryTransitions = recoveredProjectTransitions.filter(
    (transition) => !transition.recoveredIsAcknowledged
  );
  for (const transition of unacknowledgedRecoveryTransitions) {
    syncState.pendingProjectIds.add(transition.recoveredProjectId);
    syncState.pendingProjectMinimumCanvasSchemaVersions.set(
      transition.recoveredProjectId,
      transition.minimumCanvasSchemaVersion
    );
  }
  if (unacknowledgedRecoveryTransitions.length > 0 && !persistSyncMap(syncState)) {
    for (const transition of unacknowledgedRecoveryTransitions) {
      syncState.pendingProjectIds.delete(transition.recoveredProjectId);
      syncState.pendingProjectMinimumCanvasSchemaVersions.delete(transition.recoveredProjectId);
    }
    syncState.hasPending = true;
    throw new Error('Could not durably prepare recovered projects for the local cache.');
  }

  // Refresh the offline cache with what the server gave us.
  const snapshot = await syncState.localPersistence.saveWorkbench(state);
  assertOwner(syncState);
  syncState.cachedProjectsById = new Map(state.projects.map((project) => [project.id, project]));
  for (const transition of recoveredProjectTransitions) {
    syncState.collisionProjectIds.delete(transition.sourceProjectId);
    if (transition.sourceEntry) {
      syncState.syncEntries.set(transition.sourceProjectId, transition.sourceEntry);
    } else {
      syncState.syncEntries.delete(transition.sourceProjectId);
    }
    syncState.schemaRefusals.delete(transition.sourceProjectId);
    syncState.pendingProjectIds.delete(transition.sourceProjectId);
    syncState.pendingProjectMinimumCanvasSchemaVersions.delete(transition.sourceProjectId);
    syncState.pendingRecoveryIdentities.delete(transition.sourceProjectId);
    if (!transition.recoveredIsAcknowledged) {
      syncState.pendingProjectIds.add(transition.recoveredProjectId);
      syncState.pendingProjectMinimumCanvasSchemaVersions.set(
        transition.recoveredProjectId,
        transition.minimumCanvasSchemaVersion
      );
    }
  }
  settleRecoveryReservationsAfterCacheWrite(syncState, state);
  settleProjectAbsenceAfterCacheWrite(syncState, state);
  if (!persistSyncMap(syncState)) {
    syncState.hasPending = true;
  }

  return { ...snapshot, refusedProjects };
};

export interface SyncedWorkbenchPersistence {
  acknowledgeConflictResolution(projectId: string): void;
  adoptProjectRecord(record: ProjectRecordDTO): ProjectLoadResult;
  clearWorkbench(): Promise<void>;
  deleteProjectOnServer(projectId: string): Promise<void>;
  flushProjectToServer(project: Project): Promise<ProjectPushOutcome>;
  hasPendingChanges(): boolean;
  hydrateProjectFromServer(projectId: string, projectName?: string): Promise<ProjectLoadResult>;
  loadWorkbench(options?: WorkbenchLoadOptions): Promise<HydratedWorkbenchSnapshot | null>;
  markProjectDeleted(projectId: string): void;
  persistEmptySession(state: WorkbenchState): Promise<void>;
  releaseProjectSync(projectId: string): void;
  saveWorkbench(state: WorkbenchState): Promise<WorkbenchSaveResult>;
  unmarkProjectDeleted(projectId: string): void;
}

/**
 * One-shot maintenance operation: deletes server projects and the session
 * blob, then clears the local cache, project library, and persisted sync map.
 * Independent of any mounted Workbench lifetime; callers are expected to
 * reload afterwards.
 */
export const clearAllWorkbenchData = async (owner: AccountScope = captureAccountScope()): Promise<void> => {
  const syncState = createSyncedPersistenceState(owner);

  assertOwner(syncState);

  try {
    const summaries = await listProjects(syncState.owner.signal);

    assertOwner(syncState);
    await Promise.all(summaries.map((summary) => apiDeleteProject(summary.project_id, syncState.owner.signal)));
    assertOwner(syncState);
    await deleteClientStateValue(SESSION_STATE_KEY, syncState.owner.signal);
    assertOwner(syncState);
  } catch {
    assertOwner(syncState);
    // Backend unreachable; at least reset this browser.
  }

  seedProjectLibrary([], owner);

  try {
    window.localStorage.removeItem(getSyncMapStorageKey(syncState));
  } catch {
    // Nothing to clear if storage is unavailable.
  }

  await syncState.localPersistence.clearWorkbench();
  assertOwner(syncState);
};

/** Construct one synchronization lifetime per mounted Workbench. */
export const createSyncedWorkbenchPersistence = (
  owner: AccountScope = captureAccountScope()
): SyncedWorkbenchPersistence => {
  const syncState = createSyncedPersistenceState(owner);
  let loadPromise: Promise<HydratedWorkbenchSnapshot | null> | null = null;
  // Every mutation below shares syncEntries and its optimistic revisions.
  // Serialize them so this browser cannot race itself and manufacture a 409.
  let mutationTail: Promise<void> = Promise.resolve();

  const enqueueMutation = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const run = (): Promise<Result> => {
      assertOwner(syncState);

      return operation();
    };
    const result = mutationTail.then(
      () => run(),
      () => run()
    );

    mutationTail = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  };

  const markDeleted = (projectId: string): boolean => {
    assertOwner(syncState);
    syncState.deletedProjectIds.add(projectId);

    // Keep the revision, floor, and pending metadata beside the tombstone. They are either restored
    // intact if DELETE fails or removed together after a cache snapshot omits the project.
    return persistSyncMap(syncState);
  };

  const unmarkDeleted = (projectId: string): void => {
    assertOwner(syncState);
    syncState.deletedProjectIds.delete(projectId);
    if (!persistSyncMap(syncState)) {
      // The durable tombstone still exists. Restore the in-memory view so this lifetime cannot
      // claim the deletion was cancelled and later compact away the cached source document.
      syncState.deletedProjectIds.add(projectId);
      syncState.unconfirmedDeletionProjectIds.add(projectId);
      syncState.hasPending = true;
    } else {
      syncState.unconfirmedDeletionProjectIds.delete(projectId);
    }
  };

  const adoptProjectRecord = (record: ProjectRecordDTO): ProjectLoadResult => {
    assertOwner(syncState);
    const { pushedDoc, result } = adoptRecordBaseline(record);

    if (result.status !== 'loaded') {
      return result;
    }

    syncState.syncEntries.set(record.project_id, {
      minimumCanvasSchemaVersion: record.minimum_canvas_schema_version,
      pushedDoc,
      revision: record.revision,
    });
    syncState.deletedProjectIds.delete(record.project_id);
    syncState.forkedProjectIds.delete(record.project_id);
    syncState.schemaRefusals.delete(record.project_id);
    syncState.collisionProjectIds.delete(record.project_id);
    syncState.pendingProjectIds.delete(record.project_id);
    syncState.pendingProjectMinimumCanvasSchemaVersions.delete(record.project_id);
    syncState.pendingRecoveryIdentities.delete(record.project_id);
    syncState.releasedProjectIds.delete(record.project_id);
    syncState.unconfirmedDeletionProjectIds.delete(record.project_id);
    persistSyncMap(syncState);

    return result;
  };

  return {
    acknowledgeConflictResolution(projectId): void {
      assertOwner(syncState);
      syncState.forkedProjectIds.delete(projectId);
    },
    adoptProjectRecord,
    /** Clear everywhere: server projects + session blob, local cache, sync map, and this lifetime's sync state. */
    clearWorkbench(): Promise<void> {
      return enqueueMutation(async () => {
        await clearAllWorkbenchData(syncState.owner);

        assertOwner(syncState);
        syncState.cachedProjectsById.clear();
        syncState.syncEntries.clear();
        syncState.collisionProjectIds.clear();
        syncState.schemaRefusals.clear();
        syncState.deletedProjectIds.clear();
        syncState.pendingProjectIds.clear();
        syncState.pendingProjectMinimumCanvasSchemaVersions.clear();
        syncState.pendingRecoveryIdentities.clear();
        syncState.releasedProjectIds.clear();
        syncState.unretainedRefusedProjects = [];
        syncState.lastPushedAccount = null;
        syncState.hasPending = false;
        syncState.unconfirmedDeletionProjectIds.clear();
      });
    },
    /** Queued, not issued directly — see {@link OpenProjectHandle.deleteOnServer}. */
    deleteProjectOnServer(projectId): Promise<void> {
      return enqueueMutation(async () => {
        if (!markDeleted(projectId)) {
          unmarkDeleted(projectId);
          throw new Error('Could not durably record the pending project deletion.');
        }

        try {
          await apiDeleteProject(projectId, syncState.owner.signal);
        } catch (error) {
          assertOwner(syncState);
          unmarkDeleted(projectId);
          throw error;
        }

        assertOwner(syncState);
        syncState.unconfirmedDeletionProjectIds.delete(projectId);
      });
    },
    flushProjectToServer(project): Promise<ProjectPushOutcome> {
      return enqueueMutation(async () => {
        // A flush is a targeted push, not a save. Any conflict or fork it produces waits on
        // `syncState` for the next save to drain — the flush has no caller to hand them to, and
        // they are already true of the server by the time it returns.
        //
        // What it *does* hand back is whether the push landed. Every caller here has a recoverable
        // failure on its hands, so this still does not reject; but "recoverable" and "done" are
        // different answers, and a caller about to read the project back from the server needs the
        // second one. `assertProjectFlushed` in `./projectFlush` is where that is spent.
        markProjectPending(syncState, project);
        if (!persistSyncMap(syncState)) {
          syncState.hasPending = true;

          return { documentJson: getSerializedProjectDocument(syncState, project).json, kind: 'unsynced' };
        }

        const outcome = await pushProject(syncState, project);

        settleProjectPendingMarker(syncState, project.id, outcome);

        if (outcome.kind === 'schema-refused') {
          await retainSchemaRefusedProject(syncState, project, outcome.refusal);
        }

        assertOwner(syncState);
        if (!persistSyncMap(syncState)) {
          syncState.hasPending = true;
        }

        return outcome;
      });
    },
    hasPendingChanges(): boolean {
      assertOwner(syncState);
      return syncState.hasPending;
    },
    async hydrateProjectFromServer(projectId, projectName = projectId): Promise<ProjectLoadResult> {
      assertOwner(syncState);

      try {
        const record = await apiGetProject(projectId, syncState.owner.signal);

        assertOwner(syncState);
        return adoptProjectRecord(record);
      } catch (error) {
        assertOwner(syncState);

        const refused = toServerSchemaRefusal(error, projectId, projectName);

        if (refused) {
          return { refused, status: 'refused' };
        }

        return { status: 'unavailable' };
      }
    },
    /**
     * Load from the backend, falling back to the localStorage cache when it is
     * unreachable. Returns null when there is nothing anywhere (first run with
     * no backend); the caller then keeps its default boot state.
     */
    loadWorkbench(options?: WorkbenchLoadOptions): Promise<HydratedWorkbenchSnapshot | null> {
      // React StrictMode replays the Workbench mount effect. The synchronization
      // lifetime is stable across that replay, so both calls must observe the
      // same import instead of racing duplicate project POSTs.
      if (loadPromise) {
        return loadPromise;
      }

      loadPromise = (async () => {
        assertOwner(syncState);
        let local: HydratedWorkbenchSnapshot | null = null;

        try {
          local = await syncState.localPersistence.loadWorkbench();
          assertOwner(syncState);

          syncState.cachedProjectsById = new Map((local?.state.projects ?? []).map((project) => [project.id, project]));

          if (local?.hasUnretainedRefusedProjects) {
            syncState.unretainedRefusedProjects = local.refusedProjects.filter(
              (project) => project.raw !== null && project.raw !== undefined
            );
          }
        } catch {
          assertOwner(syncState);
          local = null;
        }

        try {
          return await loadFromBackend(syncState, local, options);
        } catch {
          assertOwner(syncState);
          // Backend unreachable: run from the cache; saves queue up locally and
          // replay on reconnect.
          syncState.hasPending = true;

          const persistedSyncMap = loadPersistedSyncMap(syncState);

          syncState.deletedProjectIds = new Set(persistedSyncMap.deletedProjectIds);
          syncState.collisionProjectIds = new Set(persistedSyncMap.collisionProjectIds);
          syncState.pendingProjectIds = new Set(persistedSyncMap.pendingProjectIds);
          syncState.pendingProjectMinimumCanvasSchemaVersions = new Map(
            Object.entries(persistedSyncMap.pendingProjectMinimumCanvasSchemaVersions)
          );
          syncState.pendingRecoveryIdentities = new Map(Object.entries(persistedSyncMap.pendingRecoveryIdentities));
          syncState.unconfirmedDeletionProjectIds = new Set(
            (local?.state.projects ?? [])
              .filter((project) => syncState.deletedProjectIds.has(project.id))
              .map((project) => project.id)
          );

          for (const projectId of persistedSyncMap.pendingProjectIds) {
            if (persistedSyncMap.revisions[projectId] === undefined) {
              syncState.collisionProjectIds.add(projectId);
            }
          }
          persistSyncMap(syncState);

          for (const [projectId, revision] of Object.entries(persistedSyncMap.revisions)) {
            syncState.syncEntries.set(projectId, {
              minimumCanvasSchemaVersion:
                persistedSyncMap.minimumCanvasSchemaVersions[projectId] ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
              pushedDoc: null,
              revision,
            });
          }

          reportProjectSync({
            hasPendingChanges: true,
            projects: Object.fromEntries(
              (local?.state.projects ?? [])
                .filter((project) => !syncState.deletedProjectIds.has(project.id))
                .map((project) => [
                  project.id,
                  { isPendingPush: true, revision: persistedSyncMap.revisions[project.id] ?? null },
                ])
            ),
          });

          if (!local) {
            return null;
          }

          const visibleProjects = local.state.projects.filter(
            (project) => !syncState.deletedProjectIds.has(project.id)
          );

          // A cache holding an empty session (last tab closed offline) still
          // owns the account's preset defaults, so build the replacement draft
          // here instead of falling back to the store's shipped defaults.
          if (visibleProjects.length === 0) {
            const draft = createDraftProject([], local.state.account);

            return { ...local, state: { ...local.state, activeProjectId: draft.id, projects: [draft] } };
          }

          // `?new=true` means a fresh draft whether or not the backend answered.
          // Returning the cache verbatim here used to hand the caller whichever
          // project was last active, so an offline "New project" silently
          // reopened — and then let the Launchpad's intent rearrange — existing
          // work.
          if (options?.createNew) {
            const draft = createDraftProject(visibleProjects, local.state.account);

            return {
              ...local,
              state: { ...local.state, activeProjectId: draft.id, projects: [...visibleProjects, draft] },
            };
          }

          return {
            ...local,
            state: {
              ...local.state,
              activeProjectId: visibleProjects.some((project) => project.id === local.state.activeProjectId)
                ? local.state.activeProjectId
                : visibleProjects[0]!.id,
              projects: visibleProjects,
            },
          };
        }
      })();

      return loadPromise;
    },

    /**
     * Write-through save: localStorage cache always, then every dirty open
     * project and the session blob to the backend. Revision conflicts come
     * back as resolutions for the caller to apply to workbench state. Saving
     * never deletes anything: a project absent from state is merely closed,
     * and removal happens only through the library's explicit delete.
     */
    markProjectDeleted(projectId): void {
      markDeleted(projectId);
    },
    persistEmptySession(state): Promise<void> {
      return enqueueMutation(async () => {
        if (
          syncState.unconfirmedDeletionProjectIds.size > 0 &&
          !(await reconcileUnconfirmedDeletions(syncState, state.projects))
        ) {
          throw new Error('Could not verify pending project deletions while offline.');
        }

        if (!(await ensureRefusedProjectsRetained(syncState))) {
          throw new Error('Could not preserve projects that require a newer client.');
        }

        const emptied: WorkbenchState = { ...state, activeProjectId: '', projects: [] };

        await syncState.localPersistence.saveWorkbench(emptied);
        assertOwner(syncState);
        syncState.cachedProjectsById.clear();
        settleProjectAbsenceAfterCacheWrite(syncState, emptied);
        persistSyncMap(syncState);

        try {
          const blob = serializeSessionBlob(emptied);

          await setClientStateValue(SESSION_STATE_KEY, blob, syncState.owner.signal);
          assertOwner(syncState);
          syncState.lastPushedAccount = blob;
        } catch {
          assertOwner(syncState);
          syncState.hasPending = true;
        }
      });
    },
    releaseProjectSync(projectId): void {
      assertOwner(syncState);
      // Closing is a two-step transition: the UI removes the project, then autosave replaces the
      // cache. Keep its revision until that cache write succeeds so a crash cannot make a formerly
      // synced project look like a never-synced draft and recreate a remotely deleted id.
      syncState.releasedProjectIds.add(projectId);
    },
    saveWorkbench(state: WorkbenchState): Promise<WorkbenchSaveResult> {
      return enqueueMutation(async () => {
        if (
          syncState.unconfirmedDeletionProjectIds.size > 0 &&
          !(await reconcileUnconfirmedDeletions(syncState, state.projects))
        ) {
          throw new Error('Could not verify pending project deletions while offline.');
        }

        if (!(await ensureRefusedProjectsRetained(syncState))) {
          throw new Error('Could not preserve projects that require a newer client.');
        }

        for (const project of state.projects) {
          markProjectPending(syncState, project);
        }
        // The two localStorage keys cannot commit atomically, so write the marker first. A crash may
        // then leave a harmless stale marker beside old bytes (cleared by equality on reload), but
        // can never leave new cached bytes falsely described as acknowledged.
        if (!persistSyncMap(syncState)) {
          syncState.hasPending = true;
          throw new Error('Could not durably record pending project edits.');
        }

        const snapshot = await syncState.localPersistence.saveWorkbench(state);

        assertOwner(syncState);
        syncState.cachedProjectsById = new Map(state.projects.map((project) => [project.id, project]));
        settleRecoveryReservationsAfterCacheWrite(syncState, state);
        settleProjectAbsenceAfterCacheWrite(syncState, state);
        syncState.hasPending = false;

        const projectSyncInfos: Record<string, ProjectSyncInfo> = {};

        await pushSessionState(syncState, state);
        assertOwner(syncState);

        for (const project of state.projects) {
          assertOwner(syncState);
          const lastAckedDoc = syncState.syncEntries.get(project.id)?.pushedDoc ?? null;
          const outcome = await pushProject(syncState, project);
          const { documentJson } = outcome;

          settleProjectPendingMarker(syncState, project.id, outcome);

          if (outcome.kind === 'schema-refused') {
            await retainSchemaRefusedProject(syncState, project, outcome.refusal);
          }

          assertOwner(syncState);
          const entry = syncState.syncEntries.get(project.id);

          projectSyncInfos[project.id] = {
            isPendingPush: syncState.pendingProjectIds.has(project.id),
            revision: entry?.revision ?? null,
            ...(outcome.kind === 'schema-refused' ? { schemaRefusal: outcome.refusal } : {}),
          };

          // The server acknowledged new content for this project — keep the
          // library summary current without a refetch.
          if (entry && entry.pushedDoc === documentJson && lastAckedDoc !== documentJson) {
            upsertProjectSummary(
              {
                id: project.id,
                minimumCanvasSchemaVersion: entry.minimumCanvasSchemaVersion,
                name: project.name,
                revision: entry.revision,
              },
              syncState.owner
            );
          }
        }

        // A reconciliation save may need to push the server-assigned recovery board before its
        // cached document matches the acknowledgement. Recheck after all project pushes so the
        // source reservation does not survive into an unrelated later conflict.
        settleRecoveryReservationsAfterCacheWrite(syncState, state);
        if (!persistSyncMap(syncState)) {
          syncState.hasPending = true;
        }
        reportProjectSync({ hasPendingChanges: syncState.hasPending, projects: projectSyncInfos });

        // Drained rather than read: each outcome is applied to the store exactly once. The runtime
        // applies what it is handed even when the save it came from went stale, so draining here is
        // safe — nothing is dropped between this call and the reducer.
        return {
          conflicts: syncState.pendingConflicts.splice(0),
          deletedProjectForks: syncState.pendingDeletedForks.splice(0),
          hasPendingChanges: syncState.hasPending,
          projectBoardAssignments: syncState.pendingBoardAssignments.splice(0),
          snapshot,
        };
      });
    },
    unmarkProjectDeleted(projectId): void {
      unmarkDeleted(projectId);
    },
  };
};
