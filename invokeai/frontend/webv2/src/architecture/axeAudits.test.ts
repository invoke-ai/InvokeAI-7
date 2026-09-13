import { describe, expect, it } from 'vitest';

/**
 * An accessibility audit must read settled UI.
 *
 * `axe.run` on a surface that is still animating in measures contrast against a
 * half-composited backdrop and reports colour failures that do not exist. Whether an audit
 * lands inside that window depends on machine load — in a browser run, on how many other test
 * files the suite is scheduling — so the failure surfaces for whoever next adds an unrelated
 * test file, in a test they did not touch. That is expensive to diagnose and easy to
 * misattribute, which is why the pairing is enforced here rather than left to a comment.
 *
 * Scope is the `src/` tree, which is what this glob can reach. The release journey runner
 * (`scripts/run-accessibility-journeys.mjs`) audits from Node against a Playwright page and
 * cannot import the helper — its body is serialised into the browser — so it carries the same
 * wait inside `waitForSettledDocument` and is not covered here.
 */
const sources = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const ALLOWED = new Set([
  '../platform/browser/auditAccessibility.testing.ts',
  // Audits un-settled UI on purpose, to hold on to a reproduction of the bug the helper fixes.
  '../platform/browser/auditAccessibility.browser.test.ts',
]);
const AXE_RUN = /\baxe\s*\.\s*run\s*\(/;

describe('accessibility audits', () => {
  it('routes every audit under src/ through the helper that settles animations first', () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.has(path))
      .filter(([, text]) => AXE_RUN.test(text))
      .map(([path]) => path.replace(/^\.\.\//, ''));

    expect(offenders).toEqual([]);
  });
});
