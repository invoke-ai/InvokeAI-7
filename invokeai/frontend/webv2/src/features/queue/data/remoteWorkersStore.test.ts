import { accountLifecycle } from '@platform/state/accountLifecycle';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRemoteWorkerUrls, getRemoteWorkersSettings, setRemoteWorkersSettings } from './remoteWorkersStore';

const STORAGE_KEY = 'invokeai-v7:remote-workers:test-v1';

const createMemoryStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
};

let resetCounter = 0;

const activateSingleUser = (): void => {
  accountLifecycle.activate(`remote-worker-store-reset-${++resetCounter}`);
  accountLifecycle.activate('single-user');
};

describe('remote worker browser settings', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createMemoryStorage(),
    });
    activateSingleUser();
    setRemoteWorkersSettings({ disabledWorkerUrls: [], enabled: false, workerUrls: '' });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('strips embedded URL credentials before settings enter the store or localStorage', () => {
    setRemoteWorkersSettings({
      workerUrls: 'http://alice:secret@192.168.1.101:9090\nhttp://192.168.1.102:9090',
    });

    expect(getRemoteWorkersSettings().workerUrls).toBe('http://192.168.1.101:9090\nhttp://192.168.1.102:9090');
    expect(getRemoteWorkerUrls(getRemoteWorkersSettings().workerUrls)).toEqual([
      'http://192.168.1.101:9090',
      'http://192.168.1.102:9090',
    ]);

    const saved = localStorage.getItem(STORAGE_KEY);
    expect(saved).not.toBeNull();
    expect(saved).not.toContain('alice');
    expect(saved).not.toContain('secret');
  });

  it('scrubs embedded credentials from an older saved setting when the account loads', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: true,
        dispatchMode: 'mirror_all',
        workerUrls: 'https://bob:password@example.test/invoke',
        disabledWorkerUrls: [],
        autoTransferMissingModels: true,
        keepRemoteCopies: false,
        modelTransferHost: '',
      })
    );

    activateSingleUser();

    expect(getRemoteWorkersSettings().workerUrls).toBe('https://example.test/invoke');

    const migrated = localStorage.getItem(STORAGE_KEY);
    expect(migrated).not.toBeNull();
    expect(migrated).not.toContain('bob');
    expect(migrated).not.toContain('password');
    expect(migrated).toContain('https://example.test/invoke');
  });
});
