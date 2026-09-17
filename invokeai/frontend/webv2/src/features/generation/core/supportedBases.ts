/**
 * The architectures this build can compile an image-generation graph for.
 *
 * Frontend-owned on purpose, and the one thing in generation policy that cannot come from the
 * server: `GRAPH_BUILDERS` in `graph.ts` must have an entry for each of these, and the `satisfies`
 * there is what enforces it. The capabilities endpoint advertises more architectures than this --
 * `sdxl-refiner` is never run on its own, and `minimax-h3` is video-only with no image graph -- so
 * "the server knows about it" and "we can generate with it" are different questions.
 *
 * Previously derived as `keyof typeof BASE_GENERATION`, which tied the set to the key order of a
 * table that is about to be served from the backend. Written out here, adding an architecture stays
 * a deliberate act with a test that notices it.
 */

import type { KnownGenerationModelBase } from '@features/generation/core/contracts';

export const SUPPORTED_GENERATE_BASES = [
  'sd-1',
  'sd-2',
  'sdxl',
  'sd-3',
  'flux',
  'flux2',
  'cogview4',
  'ernie-image',
  'qwen-image',
  'z-image',
  'ideogram-4',
  'krea-2',
  'wan',
  'anima',
] as const satisfies readonly KnownGenerationModelBase[];

export type SupportedGenerateBase = (typeof SUPPORTED_GENERATE_BASES)[number];

const SUPPORTED = new Set<string>(SUPPORTED_GENERATE_BASES);

export const isSupportedGenerateBase = (base: string): base is SupportedGenerateBase => SUPPORTED.has(base);
