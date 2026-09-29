import type { GenerateReferenceImage, GenerateSettings } from '@features/generation/core/types';

import { moveReferenceImage } from '@features/generation/core/settings';
import { describe, expect, it } from 'vitest';

import { applyGenerateSettingsUpdate, mergeGenerateSettingsUpdate } from './generateDebounce';

/** Updaters run for both draft and flush; mint IDs outside them. */
const buildSettings = (referenceImages: GenerateReferenceImage[] = []): GenerateSettings =>
  ({ referenceImages }) as unknown as GenerateSettings;

const entry = (id: string): GenerateReferenceImage => ({
  config: { image: null, type: 'external_reference_image' },
  id,
  isEnabled: true,
});

const idsOf = (settings: GenerateSettings) => settings.referenceImages.map(({ id }) => id);

describe('pending generate settings updates', () => {
  it('applies a pending updater twice, so an id minted inside one diverges between draft and commit', () => {
    let minted = 0;
    const appendWithIdInsideUpdater = (settings: GenerateSettings): GenerateSettings => ({
      ...settings,
      referenceImages: [...settings.referenceImages, entry(`minted-${String((minted += 1))}`)],
    });

    const pending = mergeGenerateSettingsUpdate(null, appendWithIdInsideUpdater);
    const draft = applyGenerateSettingsUpdate(buildSettings([entry('a')]), pending);
    const committed = applyGenerateSettingsUpdate(buildSettings([entry('a')]), pending);

    expect(idsOf(draft)).toEqual(['a', 'minted-1']);
    expect(idsOf(committed)).toEqual(['a', 'minted-2']);

    // The rendered ID must match the flushed ID for reordering to work.
    const chained = mergeGenerateSettingsUpdate(pending, (settings) => ({
      ...settings,
      referenceImages: [...moveReferenceImage(settings.referenceImages, 'minted-1', -1)],
    }));

    expect(idsOf(applyGenerateSettingsUpdate(buildSettings([entry('a')]), chained))).toEqual(['a', 'minted-3']);
  });

  it('keeps the reorder when the appended ids are minted outside the updater', () => {
    const ids = ['hoisted'];
    const appendWithHoistedId = (settings: GenerateSettings): GenerateSettings => ({
      ...settings,
      referenceImages: [...settings.referenceImages, entry(ids[0] ?? '')],
    });

    const chained = mergeGenerateSettingsUpdate(mergeGenerateSettingsUpdate(null, appendWithHoistedId), (settings) => ({
      ...settings,
      referenceImages: [...moveReferenceImage(settings.referenceImages, 'hoisted', -1)],
    }));

    expect(idsOf(applyGenerateSettingsUpdate(buildSettings([entry('a')]), chained))).toEqual(['hoisted', 'a']);
    expect(idsOf(applyGenerateSettingsUpdate(buildSettings([entry('a')]), chained))).toEqual(['hoisted', 'a']);
  });
});
