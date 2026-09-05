import { describe, expect, it } from 'vitest';

/**
 * `crypto.randomUUID` and `crypto.subtle` are undefined outside secure contexts,
 * and the app is routinely opened over plain HTTP from another device on the
 * LAN. Every id mint goes through `@platform/browser/randomUuid` and every
 * digest through `@platform/browser/sha256`, which carry fallbacks; a direct
 * call anywhere else reintroduces a crash that only shows up on a phone or
 * tablet.
 */
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const HELPER_PATHS = new Set(['../platform/browser/randomUuid.ts', '../platform/browser/sha256.ts']);
const SECURE_CONTEXT_ONLY = /\brandomUUID\b|\bcrypto\s*\.\s*subtle\b|\bsubtle\s*\.\s*digest\b/;
const isTestFile = (path: string): boolean => /\.(test|spec|stories)\.tsx?$/.test(path);

describe('secure-context web APIs', () => {
  it('routes every production UUID mint and SHA-256 digest through the platform helpers', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !HELPER_PATHS.has(path) && !isTestFile(path))
      .filter(([, text]) => SECURE_CONTEXT_ONLY.test(text))
      .map(([path]) => path.replace(/^\.\.\//, ''));

    expect(offenders).toEqual([]);
  });
});
