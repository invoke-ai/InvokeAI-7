import type { GenerationModelCatalogItem as ModelConfig } from '@features/generation/contracts';
import type { GenerateModelConfig, GenerateSettings, LoraModelConfig } from '@features/generation/core/types';

import { Stack, Text } from '@chakra-ui/react';
import { getDefaultGenerateSettings, isSupportedGenerateModel } from '@features/generation/core/baseGenerationPolicies';
import { isLoraModelConfig, normalizeGenerateSettings } from '@features/generation/core/settings';
import {
  ensureArchitectureCapabilitiesLoaded,
  useArchitectureCapabilitiesSelector,
} from '@features/generation/data/architectureCapabilitiesStore';
import { resolveGenerateWidgetValues } from '@features/generation/settings';
import { Button } from '@platform/ui/Button';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { getGenerateFormCommitPatch } from './generateFormViewModel';
import { GenerateSettingsForm } from './GenerateSettingsForm';
import { useGenerationUi } from './GenerationUiContext';

export const GenerateWidgetView = () => {
  const { t } = useTranslation();
  const ui = useGenerationUi();
  const capabilitiesStatus = useArchitectureCapabilitiesSelector((snapshot) => snapshot.status);
  const capabilitiesError = useArchitectureCapabilitiesSelector((snapshot) => snapshot.error);
  const projectId = ui.project.activeProjectId;
  const storedValues = ui.project.generateValues;
  const error = ui.models.error;
  const models = ui.models.catalog;
  const status = ui.models.status;

  const supportedModels = useMemo<GenerateModelConfig[]>(() => models.filter(isSupportedGenerateModel), [models]);
  const loraModels = useMemo(
    () => models.filter((model): model is ModelConfig & LoraModelConfig => isLoraModelConfig(model)),
    [models]
  );
  const resolved = useMemo(() => resolveGenerateWidgetValues({ models, storedValues }), [models, storedValues]);
  const settings =
    resolved?.values ?? normalizeGenerateSettings(storedValues) ?? getDefaultGenerateSettings(supportedModels[0]);
  const selectedModel = resolved?.values.model;

  const commitSettings = useCallback(
    (nextSettings: GenerateSettings) => {
      const model = supportedModels.find((candidate) => candidate.key === nextSettings.modelKey);

      if (!model) {
        return;
      }

      const next = resolveGenerateWidgetValues({
        models,
        storedValues: { ...nextSettings, model },
      });

      if (next) {
        ui.settings.patchGenerateSettings(getGenerateFormCommitPatch(next.values), projectId);
      }
    },
    [models, projectId, supportedModels, ui]
  );

  const patchSettings = useCallback(
    (values: Partial<GenerateSettings>) => {
      ui.settings.patchGenerateSettings(values, projectId);
    },
    [projectId, ui]
  );

  // Every field below is prefilled from architecture policy and is editable, so rendering the form
  // before the backend's table arrives would offer generic fallbacks as if they were the model's
  // own -- and a single keystroke would commit them. App boot kicks the fetch, so this is one round
  // trip in practice.
  if (capabilitiesStatus !== 'loaded') {
    return (
      <Stack gap="1.5" p="1">
        {capabilitiesStatus === 'error' ? (
          <>
            <Text color="fg.error" fontSize="2xs">
              {capabilitiesError ?? t('widgets.generate.capabilitiesLoadFailed')}
            </Text>
            <Button size="xs" variant="outline" onClick={ensureArchitectureCapabilitiesLoaded}>
              {t('widgets.generate.retry')}
            </Button>
          </>
        ) : (
          <Text color="fg.subtle" fontSize="2xs">
            {t('widgets.generate.loadingCapabilities')}
          </Text>
        )}
      </Stack>
    );
  }

  return (
    <GenerateSettingsForm
      isLoadingModels={status === 'idle' || status === 'loading'}
      loadError={error}
      loraModels={loraModels}
      models={models}
      projectId={projectId}
      selectedModel={selectedModel}
      settings={settings}
      supportedModels={supportedModels}
      onCommitSettings={commitSettings}
      onPatchSettings={patchSettings}
    />
  );
};
