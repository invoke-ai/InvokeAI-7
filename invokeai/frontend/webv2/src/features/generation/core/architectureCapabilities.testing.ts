/**
 * Seeds the architecture capability registry for tests.
 *
 * Generation policy comes from the backend now, and the resolver fails closed without it, so any
 * test that touches policy needs the table present -- the way it always is in a running app, where
 * app boot fetches it before the Generate widget renders.
 *
 * Explicit rather than a global setup file: a test that wants to observe the *unloaded* behaviour
 * should be able to see that it is unloaded.
 */

import { afterEach, beforeEach } from 'vitest';

import fixture from './__fixtures__/architectureCapabilities.json';
import {
  type ArchitectureCapabilitiesRow,
  resetArchitectureCapabilities,
  setArchitectureCapabilities,
} from './architectureCapabilities';

/** The response body the backend actually serves, pinned by `test_capabilities_fixture.py`. */
export const architectureCapabilitiesFixture = fixture as ArchitectureCapabilitiesRow[];

/** Load the table before each test and drop it afterwards, so nothing leaks between files. */
export const seedArchitectureCapabilities = (): void => {
  beforeEach(() => {
    setArchitectureCapabilities(architectureCapabilitiesFixture);
  });

  afterEach(() => {
    resetArchitectureCapabilities();
  });
};
