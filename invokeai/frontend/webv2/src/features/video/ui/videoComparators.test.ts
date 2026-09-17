import type { MainModelConfig } from '@features/generation/contracts';

import { createDefaultVideoWidgetValues } from '@features/video/core/widgetValues';
import { describe, expect, it } from 'vitest';

import { areVideoValuesEqual } from './videoComparators';

/**
 * The comparator is a hand-maintained field list: a field left out of it makes
 * the widget judge an edit "unchanged" and skip the write. Each entry that has
 * shipped a bug this way earns a case here.
 */
describe('areVideoValuesEqual', () => {
  const fl2vaBase: MainModelConfig = {
    base: 'minimax-h3',
    format: 'checkpoint',
    key: 'h3-fl2va-base',
    name: 'MiniMax H3 FL2VA Transformer',
    type: 'main',
    variant: 'fl2va',
  };
  const values = createDefaultVideoWidgetValues();

  it('treats the hybrid quality base and its start block as part of the values', () => {
    expect(areVideoValuesEqual(values, { ...values })).toBe(true);
    expect(areVideoValuesEqual(values, { ...values, h3HybridBaseModel: fl2vaBase })).toBe(false);
    expect(areVideoValuesEqual(values, { ...values, h3HybridStartBlock: values.h3HybridStartBlock + 1 })).toBe(false);
    expect(
      areVideoValuesEqual(
        { ...values, h3HybridBaseModel: fl2vaBase },
        { ...values, h3HybridBaseModel: { ...fl2vaBase } }
      )
    ).toBe(true);
  });
});
