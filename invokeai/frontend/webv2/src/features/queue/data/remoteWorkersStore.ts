import { captureAccountScope, registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/** Account-owned browser settings. URLs only: never put credentials or tokens here. */
export interface RemoteWorkersSettings {
  enabled: boolean;
  workerUrls: string;
  autoTransferMissingModels: boolean;
  keepRemoteCopies: boolean;
  modelTransferHost: string;
}

const LEGACY_SINGLE_USER_KEY = 'invokeai-v7:remote-workers:test-v1';
const ACCOUNT_STORAGE_KEY = 'invokeai-v7:remote-workers:v2';

const getStorageKey = (): string | null => {
  const owner = captureAccountScope();
  if (!owner.accountId) {
    return null;
  }
  return owner.accountId === 'single-user' ? LEGACY_SINGLE_USER_KEY : `${ACCOUNT_STORAGE_KEY}${owner.storageSuffix}`;
};

export const DEFAULT_REMOTE_WORKERS_SETTINGS: RemoteWorkersSettings = {
  enabled: false,
  workerUrls: '',
  autoTransferMissingModels: true,
  keepRemoteCopies: false,
  modelTransferHost: '',
};

const readSavedSettings = (): RemoteWorkersSettings => {
  try {
    const key = getStorageKey();
    const saved = key ? localStorage.getItem(key) : null;
    if (!saved) {
      return { ...DEFAULT_REMOTE_WORKERS_SETTINGS };
    }
    const value: unknown = JSON.parse(saved);
    if (typeof value !== 'object' || value === null) {
      return { ...DEFAULT_REMOTE_WORKERS_SETTINGS };
    }
    const entry = value as Record<string, unknown>;
    return {
      enabled: entry.enabled === true,
      workerUrls: typeof entry.workerUrls === 'string' ? entry.workerUrls : '',
      autoTransferMissingModels: entry.autoTransferMissingModels !== false,
      keepRemoteCopies: entry.keepRemoteCopies === true,
      modelTransferHost: typeof entry.modelTransferHost === 'string' ? entry.modelTransferHost : '',
    };
  } catch {
    // The panel works even when storage is blocked or the saved JSON is corrupt.
    return { ...DEFAULT_REMOTE_WORKERS_SETTINGS };
  }
};

export const remoteWorkersStore = createExternalStore<RemoteWorkersSettings>(readSavedSettings());

// Invalidate the previous account's URLs and enabled state synchronously on logout/login.
registerAccountOwnedResource({
  name: 'remote-workers-browser-settings',
  clear: () => remoteWorkersStore.setSnapshot(readSavedSettings()),
});

export const getRemoteWorkersSettings = (): RemoteWorkersSettings =>
  captureAccountScope().accountId ? remoteWorkersStore.getSnapshot() : { ...DEFAULT_REMOTE_WORKERS_SETTINGS };

export const setRemoteWorkersSettings = (patch: Partial<RemoteWorkersSettings>): void => {
  const key = getStorageKey();
  if (!key) {
    return;
  }
  const next = { ...remoteWorkersStore.getSnapshot(), ...patch };
  remoteWorkersStore.setSnapshot(next);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Rendering must not depend on browser storage availability.
  }
};

/** Whitespace/newlines/commas/semicolons separate remotes; order determines slot. */
export const getRemoteWorkerUrls = (raw: string): string[] => {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const part of raw.split(/[;,\r\n\s]+/)) {
    const candidate = part.trim().replace(/\/+$/, '');
    if (!candidate) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      urls.push(candidate);
    }
  }
  return urls;
};
