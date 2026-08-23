import type { GenerationModelCatalogItem, GenerateWidgetValues } from '@features/generation/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { promptTemplatesQueryOptions } from '@features/generation/queries';
import { normalizeGenerateSettings, resolveGenerateWidgetValues } from '@features/generation/settings';
import { QueryObserver } from '@tanstack/react-query';

interface ReadonlyStore<Snapshot> {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
}

export interface GenerateWidgetSyncProjectSnapshot {
  id: string;
  values: object;
}

export interface GenerateWidgetSyncRuntimeDeps {
  /**
   * Whether the backend's architecture capability table has arrived.
   *
   * `reconcile` writes its result into the project, so it must not run on fallback policy: the
   * values would be persisted, not just displayed. Subscribed like the other read models so the
   * first reconcile happens as soon as the table lands.
   */
  capabilitiesLoaded: ReadonlyStore<boolean>;
  models: ReadonlyStore<readonly GenerationModelCatalogItem[]>;
  patchValues(values: Partial<GenerateWidgetValues>, projectId: string, origin: 'system'): void;
  project: ReadonlyStore<GenerateWidgetSyncProjectSnapshot>;
  queryClient: QueryClient;
}

export interface GenerateWidgetSyncRuntime {
  dispose(): void;
}

/**
 * Keeps the active project's persisted Generate values at the resolver's fixed
 * point. The runtime owns every external subscription and is deliberately
 * React-free; App supplies the two read models and the one aggregate command.
 */
export const createGenerateWidgetSyncRuntime = (deps: GenerateWidgetSyncRuntimeDeps): GenerateWidgetSyncRuntime => {
  const promptTemplateOptions = promptTemplatesQueryOptions();
  const promptTemplateObserver = new QueryObserver(deps.queryClient, {
    ...promptTemplateOptions,
    enabled: false,
  });
  let isDisposed = false;
  let isReconciling = false;
  let isPromptTemplateQueryEnabled = false;

  const reconcile = (): void => {
    if (isDisposed || isReconciling || !deps.capabilitiesLoaded.getSnapshot()) {
      return;
    }

    isReconciling = true;

    try {
      const project = deps.project.getSnapshot();
      const models = deps.models.getSnapshot();
      const hasAppliedPromptTemplate = Boolean(normalizeGenerateSettings(project.values)?.promptTemplate);

      if (hasAppliedPromptTemplate !== isPromptTemplateQueryEnabled) {
        isPromptTemplateQueryEnabled = hasAppliedPromptTemplate;
        promptTemplateObserver.setOptions({
          ...promptTemplateOptions,
          enabled: isPromptTemplateQueryEnabled,
        });
      }

      const promptTemplateResult = promptTemplateObserver.getCurrentResult();
      const resolved = resolveGenerateWidgetValues({
        models,
        promptTemplates: promptTemplateResult.isSuccess ? promptTemplateResult.data : undefined,
        storedValues: project.values,
      });

      if (resolved?.systemPatch) {
        deps.patchValues(resolved.systemPatch, project.id, 'system');
      }
    } finally {
      isReconciling = false;
    }
  };

  const unsubscribeProject = deps.project.subscribe(reconcile);
  const unsubscribeModels = deps.models.subscribe(reconcile);
  const unsubscribeCapabilities = deps.capabilitiesLoaded.subscribe(reconcile);
  const unsubscribePromptTemplates = promptTemplateObserver.subscribe(reconcile);

  reconcile();

  return {
    dispose: () => {
      if (isDisposed) {
        return;
      }

      isDisposed = true;
      unsubscribePromptTemplates();
      unsubscribeCapabilities();
      unsubscribeModels();
      unsubscribeProject();
      promptTemplateObserver.destroy();
    },
  };
};

export {
  ensureArchitectureCapabilitiesLoaded,
  getArchitectureCapabilitiesSnapshot,
  subscribeArchitectureCapabilities,
  type ArchitectureCapabilitiesSnapshot,
} from './data/architectureCapabilitiesStore';
