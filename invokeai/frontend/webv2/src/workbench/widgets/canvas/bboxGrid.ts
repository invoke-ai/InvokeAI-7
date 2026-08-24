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
 */

import { getDimensionGridForBase } from '@features/generation/settings';

/** Default grid when no model is selected, or the backend has no row for its architecture. */
export const DEFAULT_MODEL_GRID = 8;

export const gridSizeForModelBase = (base: string | null | undefined): number =>
  (base ? getDimensionGridForBase(base) : null) ?? DEFAULT_MODEL_GRID;
