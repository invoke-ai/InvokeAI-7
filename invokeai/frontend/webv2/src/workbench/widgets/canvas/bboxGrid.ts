/**
 * Maps a model base to the bbox snapping grid size (document px). React reads the active generate
 * model's base and feeds the result into `engine.viewport.setBboxGrid`; the engine itself stays
 * model-agnostic.
 *
 * The rule comes from the backend now, which is where it is enforced: each denoise node carries a
 * `multiple_of` on its width/height fields, and the architecture declares the same number. This
 * used to be a second, hand-maintained copy of that column -- and it had drifted, offering 8px
 * steps for krea-2, wan and ideogram-4, all of which reject anything but multiples of 16 at
 * enqueue time.
 *
 * Because the rule now arrives over the network, "the grid for this base" has a third answer
 * besides a number and "no model": *not yet*. {@link resolveModelGrid} keeps that answer distinct
 * so a writer (the bbox <-> dims sync, which persists) can wait while a reader (the tool's snap
 * step) can pick a harmless default -- and {@link useModelGridSize} makes the reader re-read when
 * the table lands instead of latching whatever it answered on the first render.
 */

import { getArchitectureCapabilitiesSnapshot, subscribeArchitectureCapabilities } from '@features/generation/runtime';
import { getDimensionGrid } from '@features/generation/settings';
import { useExternalStoreSelector } from '@platform/state/selectors';
import { useCallback } from 'react';

/** Default grid when no model is selected. */
export const DEFAULT_MODEL_GRID = 8;

/**
 * The grid the selected architecture declares, `DEFAULT_MODEL_GRID` when no model is selected, or
 * `null` while the backend has not answered for that architecture.
 */
export const resolveModelGrid = (base: string | null | undefined, variant?: unknown): number | null =>
  base ? getDimensionGrid(base, variant) : DEFAULT_MODEL_GRID;

export const gridSizeForModelBase = (base: string | null | undefined, variant?: unknown): number =>
  resolveModelGrid(base, variant) ?? DEFAULT_MODEL_GRID;

/**
 * The grid for `base`, re-read whenever the capability table changes.
 *
 * `base` comes from the persisted project and is therefore already final on the first render, so an
 * effect keyed on it alone never re-runs: without this subscription a project reopened before the
 * table arrives snaps at 8px for the whole session, on an architecture whose denoise node enforces
 * 16 or 32.
 *
 * The read happens *inside* the selector rather than after a bare subscription call. The grid lives
 * in the core registry, not in this snapshot, so to React Compiler a plain `gridSizeForModelBase(base)`
 * in a component body is a pure function of `base` and is memoised for the component's lifetime --
 * subscribing alongside it would re-render and hand back the cached 8 anyway.
 */
export const useModelGridSize = (base: string | null | undefined, variant?: string | null): number =>
  useExternalStoreSelector(
    subscribeArchitectureCapabilities,
    getArchitectureCapabilitiesSnapshot,
    useCallback(() => gridSizeForModelBase(base, variant), [base, variant])
  );
