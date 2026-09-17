/**
 * The list of architectures this build can generate images with.
 *
 * It used to be `Object.keys(BASE_GENERATION)`, so this assertion doubled as a check on that
 * table. With the policy data moving to the backend, the list stands on its own: it is the
 * frontend's half of the contract -- the architectures we have a graph builder for. The pin stays
 * because adding one must be a deliberate act that a reviewer sees.
 */

import { describe, expect, it } from 'vitest';

import { isSupportedGenerateBase, SUPPORTED_GENERATE_BASES } from './supportedBases';

describe('SUPPORTED_GENERATE_BASES', () => {
  it('is exactly the bases with a graph builder, in order', () => {
    expect(SUPPORTED_GENERATE_BASES).toEqual([
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
    ]);
  });

  it('excludes architectures the backend serves but this build cannot generate with', () => {
    // Both have capability rows on `/api/v2/models/capabilities`. Neither has an image graph
    // builder: the refiner is a second pass over an SDXL latent, and MiniMax H3 is video-only.
    expect(isSupportedGenerateBase('sdxl-refiner')).toBe(false);
    expect(isSupportedGenerateBase('minimax-h3')).toBe(false);
  });

  it('rejects unknown and non-architecture values', () => {
    expect(isSupportedGenerateBase('unknown')).toBe(false);
    expect(isSupportedGenerateBase('made-up')).toBe(false);
    expect(isSupportedGenerateBase('external')).toBe(false);
  });
});
