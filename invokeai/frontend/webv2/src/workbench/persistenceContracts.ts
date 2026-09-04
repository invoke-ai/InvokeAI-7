import type { RefusedWorkbenchProject, WorkbenchState } from './projectContracts';

export interface HydratedWorkbenchSnapshot {
  version: 1;
  savedAt: string;
  state: WorkbenchState;
  /** Persisted projects this client refused to load. They are absent from `state`. */
  refusedProjects: RefusedWorkbenchProject[];
  /** The primary cache still holds refused raw projects because the recovery bucket write failed. */
  hasUnretainedRefusedProjects: boolean;
}

/** Versioned storage wire shape. `state` is untrusted until the persistence adapter maps it. */
export interface PersistedWorkbenchSnapshotV1 {
  version: 1;
  savedAt: string;
  state: unknown;
}
