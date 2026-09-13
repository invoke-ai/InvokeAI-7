import { afterEach, expect, it } from 'vitest';

import { auditAccessibility } from './auditAccessibility.testing';

/**
 * The reason the helper exists, reproduced in miniature.
 *
 * A panel whose colours pass contrast comfortably at rest fails the audit while it is fading
 * in, because the audit composites its text over whatever is behind it. This is what took down
 * `MissingFontsDialog` whenever the suite grew a file: nothing about the palette was wrong, the
 * audit simply ran a few frames early.
 *
 * The fade here is slow enough that the un-settled audit lands inside it with a margin of
 * three orders of magnitude over the assertion that follows, so the "before" case is not itself
 * a race.
 */

const FADE_MS = 800;

let host: HTMLDivElement | null = null;
let styles: HTMLStyleElement | null = null;

/** Light text on a dark panel: ~15:1 at rest, far inside the 4.5:1 rule. */
const render = (): HTMLDivElement => {
  styles = document.head.appendChild(document.createElement('style'));
  styles.textContent = `@keyframes audit-probe-fade { from { opacity: 0.15 } to { opacity: 1 } }
    .audit-probe { animation: audit-probe-fade ${String(FADE_MS)}ms both;
      background: #10131a; color: #f2f5fa; font-size: 16px; padding: 16px; width: 320px }`;

  host = document.body.appendChild(document.createElement('div'));
  host.className = 'audit-probe';
  host.textContent = 'Replace all uses of this missing font';

  return host;
};

afterEach(() => {
  host?.remove();
  styles?.remove();
  host = null;
  styles = null;
});

it('reports contrast failures on a palette that is fine, when the surface is still fading in', async () => {
  const panel = render();
  // Deliberately NOT settled: this is the bug, kept as an executable description of it.
  const { default: axe } = await import('axe-core');
  const midFlight = (await axe.run(panel)).violations;

  expect(panel.getAnimations()[0]?.playState).toBe('running');
  expect(midFlight.map((violation) => violation.id)).toContain('color-contrast');
});

it('reports nothing once the fade has finished, which is what the helper waits for', async () => {
  const panel = render();

  expect(await auditAccessibility(panel)).toEqual([]);
  expect(panel.getAnimations().every((animation) => animation.playState === 'finished')).toBe(true);
});
