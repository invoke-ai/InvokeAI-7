import type { RefusedWorkbenchProject } from '@workbench/projectContracts';

export const WORKBENCH_STORAGE_KEY_BASE = 'invokeai:v7:webv2:workbench';
const REFUSED_STORAGE_SUFFIX = ':refused-projects';

export const isBrowserStorageAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export interface RefusedProjectStorage {
  clear(): void;
  forget(projectId: string): void;
  /** False when the browser refused the write; callers keep the refusal in memory then. */
  retain(refusedProjects: readonly RefusedWorkbenchProject[]): boolean;
}

/**
 * The sibling bucket where projects the canvas version gate refused wait, raw and untouched,
 * until they are explicitly forgotten. It knows nothing of the gate, so the project library
 * can forget a deleted project without loading the canvas engine.
 */
export const createRefusedProjectStorage = (storageSuffix: string): RefusedProjectStorage => {
  const refusedKey = `${WORKBENCH_STORAGE_KEY_BASE}${storageSuffix}${REFUSED_STORAGE_SUFFIX}`;

  const read = (): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(refusedKey) ?? '{}');

      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const write = (refused: Record<string, unknown>): boolean => {
    try {
      if (Object.keys(refused).length === 0) {
        window.localStorage.removeItem(refusedKey);
      } else {
        window.localStorage.setItem(refusedKey, JSON.stringify(refused));
      }
      return true;
    } catch {
      return false;
    }
  };

  return {
    clear() {
      if (isBrowserStorageAvailable()) {
        window.localStorage.removeItem(refusedKey);
      }
    },
    forget(projectId) {
      if (isBrowserStorageAvailable()) {
        const refused = read();

        delete refused[projectId];
        write(refused);
      }
    },
    retain(refusedProjects) {
      if (refusedProjects.length === 0) {
        return true;
      }
      const refused = read();

      for (const project of refusedProjects) {
        // A server refusal carries metadata only. Never let it erase a raw local recovery document
        // retained for the same id.
        if (project.projectId && project.raw !== null && project.raw !== undefined) {
          refused[project.projectId] = project.raw;
        }
      }
      return write(refused);
    },
  };
};
