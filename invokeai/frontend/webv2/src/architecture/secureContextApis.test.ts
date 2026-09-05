import { describe, expect, it } from 'vitest';

/**
 * `crypto.randomUUID` is undefined outside secure contexts, and the app is
 * routinely opened over plain HTTP from another device on the LAN. Every id
 * mint goes through `@platform/browser/randomUuid`, which falls back to
 * `getRandomValues`; a direct call anywhere else reintroduces a startup crash
 * that only shows up on a phone or tablet.
 */
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const HELPER_PATH = '../platform/browser/randomUuid.ts';
const isTestFile = (path: string): boolean => /\.(test|spec|stories)\.tsx?$/.test(path);

describe('secure-context web APIs', () => {
  it('routes every production UUID mint through the randomUuid helper', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== HELPER_PATH && !isTestFile(path))
      .filter(([, text]) => /\brandomUUID\b/.test(text))
      .map(([path]) => path.replace(/^\.\.\//, ''));

    expect(offenders).toEqual([]);
  });
});
