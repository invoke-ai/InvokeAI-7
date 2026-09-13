import type { GenerateReferenceImage, GenerateSettings } from '@features/generation/core/types';

import { moveReferenceImage } from '@features/generation/core/settings';
import { describe, expect, it } from 'vitest';

import { applyGenerateSettingsUpdate, mergeGenerateSettingsUpdate } from './generateDebounce';

/**
 * A pending update is an updater FUNCTION, and the form runs it twice: once
 * against the draft the user sees (`commit`), then again against the freshly
 * committed settings when the debounce flushes. That is what lets a pending
 * edit survive a concurrent external write — but it also means an updater has
 * to be pure. An updater that mints an id inside its own body produces a
 * DIFFERENT id on each run, so the entry the user is looking at is not the
 * entry that gets committed, and any later edit keyed to the rendered id is
 * silently dropped at flush.
 */
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

    // The hazard this guards: a reorder queued behind that append is keyed to
    // the id the CARD renders under, which no longer exists at flush time.
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

    // Same chain, applied to draft and to the committed settings: both agree,
    // and the queued reorder actually lands.
    expect(idsOf(applyGenerateSettingsUpdate(buildSettings([entry('a')]), chained))).toEqual(['hoisted', 'a']);
    expect(idsOf(applyGenerateSettingsUpdate(buildSettings([entry('a')]), chained))).toEqual(['hoisted', 'a']);
  });
});
