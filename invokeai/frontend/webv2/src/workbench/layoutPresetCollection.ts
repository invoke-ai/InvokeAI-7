import type { LayoutPreset, LayoutPresetId } from './layoutContracts';
import type { AccountState } from './projectContracts';

import { layoutPresets } from './layoutPresets';
import { resolveSavedLayoutPreset } from './layoutPresetSnapshots';

/**
 * The account's saved order, with anything it has never seen slotted in.
 *
 * A preset the order has never recorded is placed next to its canonical
 * neighbour rather than appended. Appending looks the same on a fresh account —
 * nothing is stored, so every preset is "new" and they land in `presets` order
 * — but it is wrong the moment a *shipped* preset is added later: every
 * existing account would pin it to the end of the strip no matter where the
 * built-in list puts it, and there is no schema version to hang a migration on.
 *
 * The saved order still wins for everything it does name: ids already stored
 * keep their relative positions, so a dragged tab stays dragged.
 */
export const normalizeLayoutPresetOrder = (value: unknown, presets: readonly LayoutPreset[]): LayoutPresetId[] => {
  const knownIds = new Set(presets.map(({ id }) => id));
  const seenIds = new Set<LayoutPresetId>();
  const orderedIds: LayoutPresetId[] = [];

  if (Array.isArray(value)) {
    for (const id of value) {
      if (typeof id === 'string' && knownIds.has(id) && !seenIds.has(id)) {
        orderedIds.push(id);
        seenIds.add(id);
      }
    }
  }

  presets.forEach(({ id }, presetIndex) => {
    if (seenIds.has(id)) {
      return;
    }

    // The nearest preset that canonically precedes this one and is already
    // placed. Nothing before it means it belongs at the front.
    let insertAt = 0;

    for (let index = presetIndex - 1; index >= 0; index -= 1) {
      const precedingIndex = orderedIds.indexOf(presets[index]!.id);

      if (precedingIndex >= 0) {
        insertAt = precedingIndex + 1;
        break;
      }
    }

    orderedIds.splice(insertAt, 0, id);
    seenIds.add(id);
  });

  return orderedIds;
};

export const getOrderedLayoutPresets = (account: AccountState): LayoutPreset[] => {
  const availablePresets = [...layoutPresets, ...(account.customLayoutPresets ?? [])].map(({ id }) =>
    resolveSavedLayoutPreset(account, id)
  );
  const presetById = new Map(availablePresets.map((preset) => [preset.id, preset]));

  return normalizeLayoutPresetOrder(account.layoutPresetOrder, availablePresets).flatMap((id) => {
    const preset = presetById.get(id);

    return preset ? [preset] : [];
  });
};

export const reorderLayoutPresetIds = (
  account: AccountState,
  activeId: LayoutPresetId,
  overId: LayoutPresetId
): LayoutPresetId[] | null => {
  if (activeId === overId) {
    return null;
  }

  const orderedIds = getOrderedLayoutPresets(account).map(({ id }) => id);
  const activeIndex = orderedIds.indexOf(activeId);
  const overIndex = orderedIds.indexOf(overId);

  if (activeIndex < 0 || overIndex < 0) {
    return null;
  }

  const nextIds = [...orderedIds];
  const [movedId] = nextIds.splice(activeIndex, 1);
  nextIds.splice(overIndex, 0, movedId);

  return nextIds;
};
