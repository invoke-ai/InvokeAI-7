import type { DynamicPromptsExpansion } from '@features/generation/react';
import type { GraphWidgetSource } from '@workbench/graphWidgets';
import type { InvocationRoute, ResultDestination } from '@workbench/invocationContracts';
import type { WidgetTypeId } from '@workbench/widgetContracts';

import { useDynamicPrompts } from '@features/generation/react';
import { getArchitectureCapabilitiesSnapshot, subscribeArchitectureCapabilities } from '@features/generation/runtime';
import {
  getEffectivePrompts,
  normalizeGenerateSettings,
  sanitizeBatchCount,
  sanitizeDynamicPromptsConfig,
} from '@features/generation/settings';
import { ensureModelsLoaded, useModelsSelector } from '@features/models';
import { getInvocationTemplatesSnapshot, subscribeInvocationTemplates } from '@features/workflow/react';
import { localizeForLoopValidationReason } from '@features/workflow/utility';
import { useMountEffect } from '@platform/react/useMountEffect';
import { useExternalStoreSelector } from '@platform/state/selectors';
import { submitActiveInvocation } from '@workbench/activeInvocationSubmission';
import { useIsCanvasInvocationPreparing } from '@workbench/canvasInvocationPreparation';
import { getPlacedWidgetTypeIds, getVisibleWidgetTypeIds, graphWidgetSources } from '@workbench/graphWidgets';
import {
  createInvocationRouteInputSelector,
  isInvocationRouteValid,
  resolveInvocationRouteInput,
} from '@workbench/invocation';
import {
  useActiveProjectSelector,
  useWorkbenchCommands,
  useWorkbenchQueries,
  useWorkbenchSelector,
} from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const selectInvocationRouteInput = createInvocationRouteInputSelector();

/**
 * Route resolution reads two stores imperatively: the capability table (Generate validation fails
 * closed without it) and the invocation templates (workflow readiness). The selector that resolves
 * the route is only re-run when its snapshot changes, so the snapshot has to change with either --
 * a templates load that lands after the table would otherwise leave "Node definitions are still
 * loading." on Invoke until an unrelated edit.
 */
const subscribeRouteSources = (listener: () => void): (() => void) => {
  const unsubscribeCapabilities = subscribeArchitectureCapabilities(listener);
  const unsubscribeTemplates = subscribeInvocationTemplates(listener);

  return () => {
    unsubscribeCapabilities();
    unsubscribeTemplates();
  };
};

let routeSources: {
  capabilities: ReturnType<typeof getArchitectureCapabilitiesSnapshot>;
  templates: ReturnType<typeof getInvocationTemplatesSnapshot>;
} | null = null;

/** Referentially stable until one of the two stores publishes a new snapshot. */
const getRouteSourcesSnapshot = () => {
  const capabilities = getArchitectureCapabilitiesSnapshot();
  const templates = getInvocationTemplatesSnapshot();

  if (routeSources?.capabilities !== capabilities || routeSources.templates !== templates) {
    routeSources = { capabilities, templates };
  }

  return routeSources;
};

const areTypeIdSetsEqual = (left: ReadonlySet<WidgetTypeId>, right: ReadonlySet<WidgetTypeId>): boolean =>
  left.size === right.size && [...left].every((typeId) => right.has(typeId));

const readDynamicPromptsConfig = (values: Record<string, unknown>) => ({
  combinatorial: values.dynamicPromptsCombinatorial,
  maxPrompts: values.dynamicPromptsMaxPrompts,
  sampleSeed: values.dynamicPromptsSampleSeed,
  seedBehaviour: values.dynamicPromptsSeedBehaviour,
});

const readEffectivePositivePrompt = (values: Record<string, unknown>): string => {
  const settings = normalizeGenerateSettings(values);

  return settings ? getEffectivePrompts(settings).positivePrompt : '';
};

export const getBatchCount = (values: Record<string, unknown>): number => sanitizeBatchCount(values.batchCount);

export interface InvocationState {
  batchCount: number;
  blockingReasons: string[];
  invocation: InvocationRoute;
  isPreparing: boolean;
  isValid: boolean;
  sources: GraphWidgetSource[];
  visibleTypeIds: ReadonlySet<WidgetTypeId>;
  placedTypeIds: ReadonlySet<WidgetTypeId>;
  promptExpansion: DynamicPromptsExpansion;
  sourceValues: Record<string, unknown>;
  invoke: (destinationOverride?: ResultDestination) => Promise<void>;
}

export const useInvocationState = (): InvocationState => {
  const { t } = useTranslation();
  const routeInput = useActiveProjectSelector(selectInvocationRouteInput);
  const visibleTypeIds = useActiveProjectSelector(getVisibleWidgetTypeIds, areTypeIdSetsEqual);
  const placedTypeIds = useActiveProjectSelector(getPlacedWidgetTypeIds, areTypeIdSetsEqual);
  const commands = useWorkbenchCommands();
  const queries = useWorkbenchQueries();
  const backendConnectionStatus = useWorkbenchSelector((snapshot) => snapshot.backendConnection.status);
  const models = useModelsSelector((snapshot) => snapshot.models);
  const modelsStatus = useModelsSelector((snapshot) => snapshot.status);
  const availabilityModels = modelsStatus === 'loaded' ? models : undefined;
  const { invocation } = routeInput;
  const isCanvasPreparing = useIsCanvasInvocationPreparing(routeInput.projectId);
  const isPreparing = invocation.sourceId === 'canvas' && isCanvasPreparing;

  useMountEffect(() => {
    void ensureModelsLoaded();
  });

  // `getGenerationValidationReasons` fails closed while the capability table is absent, and workflow
  // readiness while the node templates are, so either load -- including one that only succeeds on
  // retry -- has to reach Invoke on its own. The route is resolved inside the stores' selector, like
  // `useModelGridSize`: both are module state, so to React Compiler a bare call is a pure function of
  // these arguments and stays memoised until an unrelated edit changes one of them.
  const resolvedRoute = useExternalStoreSelector(
    subscribeRouteSources,
    getRouteSourcesSnapshot,
    useCallback(
      () => resolveInvocationRouteInput(routeInput, 'global', invocation, availabilityModels),
      [availabilityModels, invocation, routeInput]
    )
  );
  const isConnected = backendConnectionStatus === 'connected';
  const sourceValues =
    invocation.sourceId === 'upscale'
      ? routeInput.upscaleValues
      : invocation.sourceId === 'video'
        ? routeInput.videoValues
        : invocation.sourceId === 'workflow'
          ? routeInput.workflowValues
          : routeInput.generateValues;

  const promptExpansion = useDynamicPrompts(
    readEffectivePositivePrompt(routeInput.generateValues),
    invocation.sourceId === 'generate' || invocation.sourceId === 'canvas'
      ? sanitizeDynamicPromptsConfig(readDynamicPromptsConfig(routeInput.generateValues))
      : null
  );
  // A prompt that will not expand cannot be submitted — the alternative is putting
  // the literal `{a|b}` in front of the model — so this blocks rather than just
  // annotating. `submitResolvedInvocation` enforces the same rule for the hotkey.
  const expansionReason = promptExpansion.isError
    ? 'The prompt could not be expanded.'
    : (promptExpansion.error ?? null);

  const blockingReasons = useMemo(
    () => [
      ...(isConnected ? [] : ['The backend is disconnected.']),
      ...(expansionReason === null ? [] : [expansionReason]),
      ...resolvedRoute.validationReasons.map((reason) => localizeForLoopValidationReason(reason, t)),
    ],
    [expansionReason, isConnected, resolvedRoute.validationReasons, t]
  );
  const isValid = isInvocationRouteValid(resolvedRoute) && isConnected && expansionReason === null;

  const invoke = useCallback(
    (destinationOverride?: ResultDestination) =>
      submitActiveInvocation({
        commands,
        destinationOverride,
        formatControlLayerError: (code, layerName) =>
          t('widgets.layers.control.invalidLayer', {
            name: layerName,
            reason: t(`widgets.layers.control.validation.${code}`),
          }),
        getModels: () => availabilityModels,
        queries,
      }),
    [availabilityModels, commands, queries, t]
  );

  return {
    batchCount: getBatchCount(sourceValues),
    blockingReasons,
    invocation,
    invoke,
    isPreparing,
    isValid,
    placedTypeIds,
    promptExpansion,
    sourceValues,
    sources: graphWidgetSources,
    visibleTypeIds,
  };
};
