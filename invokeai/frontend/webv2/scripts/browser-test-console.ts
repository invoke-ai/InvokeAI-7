/* eslint-disable no-console -- this module exists to intercept and re-emit console output */
import { afterAll, beforeAll } from 'vitest';

/**
 * Collapses React's "not wrapped in act(...)" warning in browser runs.
 *
 * The warning is ~10 lines of identical boilerplate and fires once per unwrapped update, so a full
 * run emitted over a thousand copies of the same text -- enough to bury the actual failure at the
 * bottom of a CI log. Nearly all of them come from third-party components whose resize-driven
 * state updates we do not control (Chakra's ScrollArea is the bulk of them), so the individual
 * copies carry no information a count does not.
 *
 * The signal is kept rather than silenced: every occurrence is counted per component and reported
 * once per test file. Anything that is not this specific warning passes through untouched.
 */
const ACT_WARNING = 'was not wrapped in act(';
const COMPONENT = /An update to (\S+)/;
const PLACEHOLDER = /%[sdifoOc]/g;

/** React logs this warning as a format string with the component in a trailing argument. */
const interpolate = (args: unknown[]): string => {
  const [template, ...rest] = args;

  if (typeof template !== 'string') {
    return args.map((arg) => String(arg)).join(' ');
  }

  let next = 0;
  const filled = template.replace(PLACEHOLDER, () => (next < rest.length ? String(rest[next++]) : '%s'));

  return [filled, ...rest.slice(next)].map((arg) => String(arg)).join(' ');
};

const counts = new Map<string, number>();
let passThrough: typeof console.error | null = null;

beforeAll(() => {
  passThrough = console.error;
  console.error = (...args: unknown[]) => {
    const text = interpolate(args);

    if (text.includes(ACT_WARNING)) {
      const component = COMPONENT.exec(text)?.[1] ?? 'unknown component';
      counts.set(component, (counts.get(component) ?? 0) + 1);
      return;
    }

    passThrough?.(...args);
  };
});

afterAll(() => {
  const report = passThrough;

  if (report) {
    console.error = report;
  }
  if (counts.size === 0) {
    return;
  }

  const summary = [...counts.entries()]
    .sort(([, left], [, right]) => right - left)
    .map(([component, count]) => `${component} x${String(count)}`)
    .join(', ');

  counts.clear();
  report?.(`act() warnings collapsed: ${summary}`);
});
