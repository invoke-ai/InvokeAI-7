import { seedArchitectureCapabilities } from '@features/generation/core/architectureCapabilities.testing';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_GRID, gridSizeForModelBase } from './bboxGrid';

seedArchitectureCapabilities();

describe('gridSizeForModelBase', () => {
  it('reads the grid the architecture declares', () => {
    // The same number the denoise node enforces through `multiple_of` on width/height.
    for (const base of ['flux', 'flux2', 'sd-3', 'qwen-image', 'z-image', 'ernie-image']) {
      expect(gridSizeForModelBase(base)).toBe(16);
    }

    expect(gridSizeForModelBase('cogview4')).toBe(32);

    for (const base of ['sd-1', 'sd-2', 'sdxl', 'anima']) {
      expect(gridSizeForModelBase(base)).toBe(8);
    }
  });

  it('no longer offers 8px steps for architectures that reject them', () => {
    // The drift this replaces: these three fell through to the default 8 here while their denoise
    // nodes carry multiple_of=16, so the canvas offered sizes that failed at enqueue time.
    for (const base of ['krea-2', 'wan', 'ideogram-4']) {
      expect(gridSizeForModelBase(base)).toBe(16);
    }
  });

  it('falls back to the default grid when there is no model or no row for its architecture', () => {
    expect(gridSizeForModelBase(null)).toBe(DEFAULT_MODEL_GRID);
    expect(gridSizeForModelBase(undefined)).toBe(DEFAULT_MODEL_GRID);
    expect(gridSizeForModelBase('mystery-model')).toBe(DEFAULT_MODEL_GRID);
    expect(DEFAULT_MODEL_GRID).toBe(8);
  });
});
