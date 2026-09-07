import type { AccountScope } from '@platform/state/accountLifecycle';

import { assertAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { ApiError, apiFetch, apiFetchJson, sleep } from '@platform/transport/http';
import {
  DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
  MAX_SUPPORTED_CANVAS_SCHEMA_VERSION,
} from '@workbench/canvasSchemaVersion';

/**
 * REST surface for server-side project persistence (`/api/v1/projects`) and
 * the per-user client-state KV (`/api/v1/client_state`) that holds the small
 * account-scoped workbench blob. Both work in single-user mode too — the
 * backend scopes them to the system user.
 */

const PROJECTS_BASE = '/api/v1/projects';
const PROJECT_WRITE_MAX_ATTEMPTS = 9;
const PROJECT_WRITE_RETRY_WINDOW_MS = 125_000;
// The path's queue segment is ignored by the backend (kept for compatibility).
const CLIENT_STATE_BASE = '/api/v1/client_state/default';

export interface ProjectSummaryDTO {
  project_id: string;
  /**
   * The project's private board. Authoritative: the `projectBoardId` in the project document is a
   * cache the client overwrites from this on hydration, never the other way round.
   */
  board_id: string;
  name: string;
  revision: number;
  minimum_canvas_schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecordDTO extends ProjectSummaryDTO {
  data: Record<string, unknown>;
}

export interface ProjectCreateRequest {
  project_id?: string;
  /**
   * An existing unclaimed private board for the new project to adopt, renamed to match. Omit to
   * have the server create one. This is what makes the create an import's single commit point.
   */
  board_id?: string;
  name: string;
  data: Record<string, unknown>;
  /** Raise the server's compatibility floor atomically with this document. */
  minimum_canvas_schema_version?: number;
}

export type ProjectBoardItemKind = 'image' | 'video';
export type ProjectBoardItemCategory = 'general' | 'control' | 'mask' | 'user';

export interface ProjectBoardItemDTO {
  category: ProjectBoardItemCategory;
  kind: ProjectBoardItemKind;
  name: string;
  starred: boolean;
}

export interface ProjectBoardSnapshotDTO {
  items: ProjectBoardItemDTO[];
}

export interface ProjectUpdateRequest {
  name: string;
  data: Record<string, unknown>;
  expected_revision: number;
  /** Raise the compatibility floor atomically with this save; omission preserves the stored floor. */
  minimum_canvas_schema_version?: number;
}

export const listProjects = (signal?: AbortSignal): Promise<ProjectSummaryDTO[]> =>
  apiFetchJson<ProjectSummaryDTO[]>(`${PROJECTS_BASE}/`, { signal });

export const getProject = (projectId: string, signal?: AbortSignal): Promise<ProjectRecordDTO> =>
  apiFetchJson<ProjectRecordDTO>(
    `${PROJECTS_BASE}/${encodeURIComponent(projectId)}?max_canvas_schema_version=${MAX_SUPPORTED_CANVAS_SCHEMA_VERSION}`,
    { signal }
  );

const isProjectWriteBusyError = (error: unknown): error is ApiError => {
  if (!(error instanceof ApiError) || error.status !== 429) {
    return false;
  }
  try {
    return (JSON.parse(error.message) as { detail?: { code?: unknown } }).detail?.code === 'project_write_busy';
  } catch {
    return false;
  }
};

const getRetryDelayMs = (error: ApiError): number => {
  const raw = error.headers.get('Retry-After');
  if (raw === null) {
    return 1_000;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : 1_000;
};

interface ProjectWriteRetryBudget {
  attempts: number;
  readonly deadline: number;
}

const createProjectWriteRetryBudget = (): ProjectWriteRetryBudget => ({
  attempts: 0,
  deadline: Date.now() + PROJECT_WRITE_RETRY_WINDOW_MS,
});

const requestProjectWrite = async <T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
  budget: ProjectWriteRetryBudget = createProjectWriteRetryBudget()
): Promise<T> => {
  while (budget.attempts < PROJECT_WRITE_MAX_ATTEMPTS) {
    budget.attempts += 1;
    try {
      return await request();
    } catch (error) {
      if (!isProjectWriteBusyError(error) || budget.attempts >= PROJECT_WRITE_MAX_ATTEMPTS) {
        throw error;
      }
      const retryAfterMs = getRetryDelayMs(error);
      const backoffCeilingMs = Math.min(1_000 * 2 ** (budget.attempts - 1), 30_000);
      const remainingMs = budget.deadline - Date.now();
      const delayMs =
        budget.attempts === PROJECT_WRITE_MAX_ATTEMPTS - 1
          ? Math.max(retryAfterMs, remainingMs - 1_000)
          : retryAfterMs + Math.random() * backoffCeilingMs;

      if (delayMs > remainingMs) {
        throw error;
      }
      await sleep(delayMs, signal);
    }
  }

  throw new Error('Project write retry budget exhausted');
};

const serializeCreateProjectRequest = (request: ProjectCreateRequest): string =>
  JSON.stringify({
    ...request,
    max_canvas_schema_version: MAX_SUPPORTED_CANVAS_SCHEMA_VERSION,
    minimum_canvas_schema_version: request.minimum_canvas_schema_version ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION,
  });

const projectRecordMatchesCreate = (record: ProjectRecordDTO, requestBody: string): boolean => {
  const request = JSON.parse(requestBody) as ProjectCreateRequest;

  return (
    record.project_id === request.project_id &&
    record.name === request.name &&
    JSON.stringify(record.data) === JSON.stringify(request.data) &&
    (request.board_id === undefined || record.board_id === request.board_id) &&
    record.minimum_canvas_schema_version >=
      (request.minimum_canvas_schema_version ?? DEFAULT_PROJECT_CANVAS_SCHEMA_VERSION)
  );
};

const createProjectFromBody = (
  body: string,
  signal: AbortSignal | undefined,
  budget: ProjectWriteRetryBudget
): Promise<ProjectRecordDTO> =>
  requestProjectWrite(
    () =>
      apiFetchJson<ProjectRecordDTO>(`${PROJECTS_BASE}/`, {
        body,
        method: 'POST',
        signal,
      }),
    signal,
    budget
  );

export const createProject = (request: ProjectCreateRequest, signal?: AbortSignal): Promise<ProjectRecordDTO> =>
  createProjectFromBody(serializeCreateProjectRequest(request), signal, createProjectWriteRetryBudget());

export const updateProject = (
  projectId: string,
  request: ProjectUpdateRequest,
  signal?: AbortSignal
): Promise<ProjectRecordDTO> => {
  const body = JSON.stringify({ ...request, max_canvas_schema_version: MAX_SUPPORTED_CANVAS_SCHEMA_VERSION });

  return requestProjectWrite(
    () =>
      apiFetchJson<ProjectRecordDTO>(`${PROJECTS_BASE}/${encodeURIComponent(projectId)}`, {
        body,
        method: 'PUT',
        signal,
      }),
    signal,
    createProjectWriteRetryBudget()
  );
};

export const deleteProject = async (projectId: string, signal?: AbortSignal): Promise<void> => {
  await apiFetch(`${PROJECTS_BASE}/${encodeURIComponent(projectId)}`, { method: 'DELETE', signal });
};

/**
 * Everything on the project's board that the gallery would show — including results the document
 * never references, which is exactly what a project file has to carry to be the whole workspace
 * rather than only the canvas. Intermediates and the canvas's private `other` category are
 * excluded by the backend.
 */
export const getProjectBoardSnapshot = (projectId: string, signal?: AbortSignal): Promise<ProjectBoardSnapshotDTO> =>
  apiFetchJson<ProjectBoardSnapshotDTO>(`${PROJECTS_BASE}/${encodeURIComponent(projectId)}/board-snapshot`, {
    signal,
  });

/** A save was based on a stale revision — another tab or device saved first. */
export const isProjectConflictError = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const isProjectNotFoundError = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

export interface ProjectCanvasSchemaCompatibilityRefusal {
  minimumCanvasSchemaVersion: number;
  maxCanvasSchemaVersion: number;
}

/** Parse the stable compatibility detail returned with a schema precondition failure. */
export const getProjectCanvasSchemaCompatibilityRefusal = (
  error: unknown
): ProjectCanvasSchemaCompatibilityRefusal | null => {
  if (!(error instanceof ApiError) || error.status !== 412) {
    return null;
  }

  try {
    const body = JSON.parse(error.message) as {
      detail?: {
        code?: unknown;
        max_canvas_schema_version?: unknown;
        minimum_canvas_schema_version?: unknown;
      };
    };
    const code = body.detail?.code;
    const minimum = body.detail?.minimum_canvas_schema_version;
    const maximum = body.detail?.max_canvas_schema_version;

    return code === 'canvas_schema_unsupported' &&
      typeof minimum === 'number' &&
      Number.isInteger(minimum) &&
      minimum >= 1 &&
      typeof maximum === 'number' &&
      Number.isInteger(maximum) &&
      maximum >= 1 &&
      minimum > maximum
      ? { maxCanvasSchemaVersion: maximum, minimumCanvasSchemaVersion: minimum }
      : null;
  } catch {
    return null;
  }
};

/** The server refused to expose or replace a project written with a newer canvas schema. */
export const isProjectCanvasSchemaUnsupportedError = (error: unknown): boolean =>
  getProjectCanvasSchemaCompatibilityRefusal(error) !== null;

export interface ProjectWriteSizeRefusal {
  actualBytes: number;
  kind: 'document' | 'request';
  maxBytes: number;
}

export const getProjectWriteSizeRefusal = (error: unknown): ProjectWriteSizeRefusal | null => {
  if (!(error instanceof ApiError) || error.status !== 413) {
    return null;
  }

  try {
    const body = JSON.parse(error.message) as {
      detail?: { actual_bytes?: unknown; code?: unknown; max_bytes?: unknown };
    };
    const actualBytes = body.detail?.actual_bytes;
    const maxBytes = body.detail?.max_bytes;

    const kind =
      body.detail?.code === 'project_document_too_large'
        ? 'document'
        : body.detail?.code === 'project_request_too_large'
          ? 'request'
          : null;

    return kind !== null &&
      typeof actualBytes === 'number' &&
      Number.isSafeInteger(actualBytes) &&
      typeof maxBytes === 'number' &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      actualBytes > maxBytes
      ? { actualBytes, kind, maxBytes }
      : null;
  } catch {
    return null;
  }
};

/**
 * A create that never reached the server, and is therefore safe to compensate for.
 *
 * Raised by {@link createProjectSettled} in place of the original rejection when it can prove the
 * project does not exist. Callers roll back on this and on nothing else.
 */
export class ProjectCreateAbsentError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super('The project was not created.');
    this.name = 'ProjectCreateAbsentError';
    this.cause = cause;
  }
}

/**
 * Create a project, resolving the one outcome a bare `POST` cannot report: a create that reached
 * the server but whose response did not reach us. Getting that wrong orphans a board's worth of
 * already-uploaded media, or *deletes* it out from under a project that does exist.
 *
 * A read cannot decide it — `GET` returns 404 while the create transaction is still committing,
 * exactly the window a dropped connection leaves open. A write can: SQLite has a single writer, so
 * a second `POST` cannot commit before the first finishes and its answer is about a settled
 * database.
 *
 * - `201` — the first attempt never landed and this one did.
 * - `409` — the retry ran to completion, so the follow-up `GET` races nothing: a record means the
 *   first create committed and is adopted; a 404 means something else holds the staging board.
 * - any other deterministic rejection — the server answered, and answered no.
 * - another transport failure — still unknown, and unknown must not authorize deletion.
 */
export const createProjectSettled = async (
  request: ProjectCreateRequest,
  owner: AccountScope
): Promise<ProjectRecordDTO> => {
  const projectId = request.project_id;
  const body = serializeCreateProjectRequest(request);
  const writeBudget = createProjectWriteRetryBudget();

  /**
   * A 409 says the id or the board is spoken for, without saying by whom. Because the server has
   * answered, nothing is mid-commit any more and reading the id is decisive: our own committed
   * create, or somebody else's board.
   */
  const settleConflict = async (conflict: unknown): Promise<ProjectRecordDTO> => {
    if (projectId === undefined) {
      throw conflict;
    }

    try {
      const record = await getProject(projectId, owner.signal);

      if (!projectRecordMatchesCreate(record, body)) {
        throw conflict;
      }

      return record;
    } catch (readError) {
      assertAccountScopeCurrent(owner);

      throw isProjectNotFoundError(readError) ? new ProjectCreateAbsentError(conflict) : conflict;
    }
  };

  const classify = (error: unknown): Promise<ProjectRecordDTO> => {
    if (isProjectConflictError(error)) {
      return settleConflict(error);
    }

    throw isRefusal(error) ? new ProjectCreateAbsentError(error) : error;
  };

  try {
    return await createProjectFromBody(body, owner.signal, writeBudget);
  } catch (error) {
    assertAccountScopeCurrent(owner);

    // Without an id of our choosing there is nothing to retry idempotently: a second POST would
    // mint a second project rather than collide with the first.
    if (projectId === undefined || !isIndeterminate(error)) {
      return classify(error);
    }

    try {
      return await createProjectFromBody(body, owner.signal, writeBudget);
    } catch (retryError) {
      assertAccountScopeCurrent(owner);

      // Still no answer. Unknown must not authorize deletion, so the original failure stands and
      // the uploads are left where they are: clutter is recoverable, a gutted project is not.
      if (isIndeterminate(retryError) || isProjectWriteBusyError(retryError)) {
        throw error;
      }

      return classify(retryError);
    }
  }
};

/** A response arrived and refused the create outright, so nothing was written. */
const isRefusal = (error: unknown): boolean => error instanceof ApiError && error.status >= 400 && error.status < 500;

/** No response, or one that says nothing about whether the write happened. */
const isIndeterminate = (error: unknown): boolean => !(error instanceof ApiError) || error.status >= 500;

export const getClientStateValue = (key: string, signal?: AbortSignal): Promise<string | null> =>
  apiFetchJson<string | null>(`${CLIENT_STATE_BASE}/get_by_key?key=${encodeURIComponent(key)}`, { signal });

/** The endpoint takes a JSON-encoded string body, hence the stringify of a string. */
export const setClientStateValue = async (key: string, value: string, signal?: AbortSignal): Promise<void> => {
  await apiFetchJson<string>(`${CLIENT_STATE_BASE}/set_by_key?key=${encodeURIComponent(key)}`, {
    body: JSON.stringify(value),
    method: 'POST',
    signal,
  });
};

export const deleteClientStateValue = async (key: string, signal?: AbortSignal): Promise<void> => {
  await apiFetch(`${CLIENT_STATE_BASE}/delete_by_key?key=${encodeURIComponent(key)}`, { method: 'POST', signal });
};
