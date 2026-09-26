import { captureAccountScope, registerAccountOwnedResource } from '@platform/state/accountLifecycle';
import { createExternalStore } from '@platform/state/externalStore';

/** Account-owned browser settings. URLs only: never put credentials or tokens here. */
export type RemoteDispatchMode = 'mirror_all' | 'remotes_only' | 'round_robin' | 'auto_balance';

export interface RemoteWorkersSettings {
  enabled: boolean;
  dispatchMode: RemoteDispatchMode;
  workerUrls: string;
  /** Disabled by normalized URL so reordering R1/R2 never changes which worker is paused. */
  disabledWorkerUrls: string[];
  autoTransferMissingModels: boolean;
  keepRemoteCopies: boolean;
  modelTransferHost: string;
}

const LEGACY_SINGLE_USER_KEY = 'invokeai-v7:remote-workers:test-v1';
const ACCOUNT_STORAGE_KEY = 'invokeai-v7:remote-workers:v2';

const stripEmbeddedUrlCredentials = (raw: string): string =>
  raw.replace(/[^;,\r\n\s]+/g, (candidate) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return candidate;
    }
    if (!['http:', 'https:'].includes(url.protocol) || (!url.username && !url.password)) {
      return candidate;
    }
    const hadTrailingSlash = candidate.endsWith('/');
    url.username = '';
    url.password = '';
    const sanitized = url.toString();
    return !hadTrailingSlash && url.pathname === '/' && !url.search && !url.hash
      ? sanitized.replace(/\/$/, '')
      : sanitized;
  });

const getStorageKey = (): string | null => {
  const owner = captureAccountScope();
  if (!owner.accountId) {
    return null;
  }
  return owner.accountId === 'single-user' ? LEGACY_SINGLE_USER_KEY : `${ACCOUNT_STORAGE_KEY}${owner.storageSuffix}`;
};

export const DEFAULT_REMOTE_WORKERS_SETTINGS: RemoteWorkersSettings = {
  enabled: false,
  dispatchMode: 'mirror_all',
  workerUrls: '',
  disabledWorkerUrls: [],
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
    const mode = entry.dispatchMode;
    const savedWorkerUrls = typeof entry.workerUrls === 'string' ? entry.workerUrls : '';
    const workerUrls = stripEmbeddedUrlCredentials(savedWorkerUrls);
    if (workerUrls !== savedWorkerUrls) {
      try {
        localStorage.setItem(key!, JSON.stringify({ ...entry, workerUrls }));
      } catch {
        // Best-effort migration: returning the scrubbed value is sufficient for runtime safety.
      }
    }
    return {
      enabled: entry.enabled === true,
      dispatchMode: mode === 'remotes_only' || mode === 'round_robin' || mode === 'auto_balance' ? mode : 'mirror_all',
      workerUrls,
      disabledWorkerUrls: Array.isArray(entry.disabledWorkerUrls)
        ? entry.disabledWorkerUrls
            .filter((url): url is string => typeof url === 'string')
            .map((url) => url.toLowerCase())
        : [],
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
  const safePatch =
    patch.workerUrls === undefined ? patch : { ...patch, workerUrls: stripEmbeddedUrlCredentials(patch.workerUrls) };
  const next = { ...remoteWorkersStore.getSnapshot(), ...safePatch };
  remoteWorkersStore.setSnapshot(next);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Rendering must not depend on browser storage availability.
  }
};

/** Worker selection is per account; changing a slot or worker address never changes another worker. */
export const isRemoteWorkerEnabled = (url: string): boolean =>
  !getRemoteWorkersSettings().disabledWorkerUrls.includes(url.toLowerCase());

export const setRemoteWorkerEnabled = (url: string, enabled: boolean): void => {
  const key = url.toLowerCase();
  const disabled = getRemoteWorkersSettings().disabledWorkerUrls;
  if (disabled.includes(key) === !enabled) {
    return;
  }
  setRemoteWorkersSettings({
    disabledWorkerUrls: enabled ? disabled.filter((value) => value !== key) : [...disabled, key],
  });
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
