import type { ModelConfig, StarterModel } from '@features/models/core/types';
import type { ModelsSnapshot } from '@features/models/data/modelsStore';

import { resolveModelAbsolutePath } from '@features/models/core/schemas';
import { useModelsSelector } from '@features/models/data/modelsStore';

const areMapsEqual = (left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean =>
  left.size === right.size && [...left].every(([source, key]) => right.get(source) === key);

// Selectors run on every store notification for every subscriber; cache by the
// inputs' identities so repeat notifications reuse one map (and pass equality
// by reference instead of a member-by-member scan).
let lastModels: ModelsSnapshot['models'] | null = null;
let lastModelsDir: string | null = null;
let lastSources: ReadonlyMap<string, string> = new Map<string, string>();

const selectInstalledSourceKeys = (snapshot: ModelsSnapshot): ReadonlyMap<string, string> => {
  if (snapshot.models !== lastModels || snapshot.modelsDir !== lastModelsDir) {
    const sources = new Map<string, string>();

    for (const model of snapshot.models) {
      sources.set(model.source, model.key);
      sources.set(resolveModelAbsolutePath(model.path, snapshot.modelsDir), model.key);
    }

    lastModels = snapshot.models;
    lastModelsDir = snapshot.modelsDir;
    lastSources = sources;
  }

  return lastSources;
};

/**
 * Every string under which a library model is reachable as an install source
 * — its recorded install source plus its resolved absolute file path — mapped
 * to that model's key. Source rows (folder scan, HuggingFace files) derive
 * "installed" from this live map and link to the model it names; a scan-time
 * snapshot would keep offering Install after the job finishes.
 */
export const useInstalledSourceKeys = (): ReadonlyMap<string, string> =>
  useModelsSelector(selectInstalledSourceKeys, areMapsEqual);

const starterIdentity = (base: string, type: string, name: string): string => `${base}\u0000${type}\u0000${name}`;

/**
 * The installed model a starter entry stands for, matched the way the backend
 * marks starters installed: by install source, else by name (or a previous
 * name) together with base and type.
 */
export const findInstalledStarterModelKey = (
  starter: Pick<StarterModel, 'base' | 'name' | 'previous_names' | 'source' | 'type'>,
  installedSourceKeys: ReadonlyMap<string, string>,
  models: readonly ModelConfig[]
): string | null => {
  const bySource = installedSourceKeys.get(starter.source);
  if (bySource !== undefined) {
    return bySource;
  }
  const names = new Set(
    [starter.name, ...(starter.previous_names ?? [])].map((name) => starterIdentity(starter.base, starter.type, name))
  );
  return models.find((model) => names.has(starterIdentity(model.base, model.type, model.name)))?.key ?? null;
};
