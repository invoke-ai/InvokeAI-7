import type { GenerationModelCatalogItem as ModelConfig } from '@features/generation/contracts';
import type { GenerateModelConfig, GenerateSettings, LoraModelConfig } from '@features/generation/core/types';

import { Box, HStack, Spinner, Stack, Text } from '@chakra-ui/react';
import { getDefaultGenerateSettings, isSupportedGenerateModel } from '@features/generation/core/baseGenerationPolicies';
import { isLoraModelConfig, normalizeGenerateSettings } from '@features/generation/core/settings';
import {
  ensureArchitectureCapabilitiesLoaded,
  getArchitectureCapabilitiesSnapshot,
  useArchitectureCapabilitiesSelector,
} from '@features/generation/data/architectureCapabilitiesStore';
import { resolveGenerateWidgetValues } from '@features/generation/settings';
import { focusIfUnclaimed } from '@platform/react/focusIfUnclaimed';
import { Button } from '@platform/ui/Button';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getGenerateFormCommitPatch } from './generateFormViewModel';
import { GenerateSettingsForm } from './GenerateSettingsForm';
import { useGenerationUi } from './GenerationUiContext';

export const GenerateWidgetView = () => {
  const { t } = useTranslation();
  const ui = useGenerationUi();
  const capabilitiesStatus = useArchitectureCapabilitiesSelector((snapshot) => snapshot.status);
  const capabilitiesError = useArchitectureCapabilitiesSelector((snapshot) => snapshot.error);
  const [hasRequestedRetry, setHasRequestedRetry] = useState(false);
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
  // The resolver reads the architecture table from the core registry and fails closed while it is
  // absent, so the load status is a real input here: without it a resolve attempted before the
  // table arrives would be cached as `null` and survive the retry that fixed it, leaving a saved
  // project with an empty model picker.
  const resolved = useMemo(
    () => (capabilitiesStatus === 'loaded' ? resolveGenerateWidgetValues({ models, storedValues }) : null),
    [capabilitiesStatus, models, storedValues]
  );
  const settings =
    resolved?.values ?? normalizeGenerateSettings(storedValues) ?? getDefaultGenerateSettings(supportedModels[0]);
  const selectedModel = resolved?.values.model;
  // The click flips the status to `loading` synchronously. Keeping the failure surface mounted for
  // the retry it started is what keeps the button -- and the user's focus -- in place.
  const isRetrying = hasRequestedRetry && capabilitiesStatus === 'loading';

  // Set by the click, consumed when the form the retry revealed mounts.
  const focusHandoffPending = useRef(false);

  const retryCapabilities = useCallback(() => {
    if (isRetrying) {
      return;
    }

    focusHandoffPending.current = true;
    setHasRequestedRetry(true);
    // The request belongs to this retry. Once it settles, a later reload -- an account switch, a
    // retry started from another panel -- is not this widget's: no failure surface while it loads,
    // and no focus taken when it lands. The form may already have mounted and taken the handoff.
    void ensureArchitectureCapabilitiesLoaded().then(() => {
      focusHandoffPending.current &&= getArchitectureCapabilitiesSnapshot().status === 'loaded';
      setHasRequestedRetry(false);
    });
  }, [isRetrying]);

  const handOverFocus = useCallback((element: HTMLDivElement | null) => {
    if (element && focusHandoffPending.current) {
      focusHandoffPending.current = false;
      focusIfUnclaimed(element);
    }
  }, []);

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
    if (capabilitiesStatus === 'error' || isRetrying) {
      return (
        <Stack aria-busy={isRetrying} aria-live="polite" gap="2" justify="center" minH="8rem" p="1" role="alert">
          <Text color="fg.error" fontSize="2xs" textWrap="pretty">
            {t('widgets.generate.capabilitiesLoadFailed')}
          </Text>
          {capabilitiesError ? (
            <Text color="fg.muted" fontSize="2xs" textWrap="pretty">
              {capabilitiesError}
            </Text>
          ) : null}
          {/* `aria-disabled` rather than `disabled`: a disabled button drops the focus it holds. */}
          <Button
            alignSelf="flex-start"
            aria-busy={isRetrying}
            aria-disabled={isRetrying}
            size="xs"
            variant="outline"
            onClick={retryCapabilities}
          >
            {isRetrying ? <Spinner size="xs" /> : null}
            {t('widgets.generate.retry')}
          </Button>
        </Stack>
      );
    }

    return (
      <HStack
        align="center"
        aria-atomic="true"
        aria-busy="true"
        aria-live="polite"
        color="fg.muted"
        gap="1.5"
        justify="center"
        minH="8rem"
        p="1"
        role="status"
      >
        <Spinner size="xs" />
        <Text fontSize="2xs">{t('widgets.generate.loadingCapabilities')}</Text>
      </HStack>
    );
  }

  return (
    // A successful retry unmounts the button that held focus; hand it to the form the retry revealed.
    <Box ref={handOverFocus}>
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
    </Box>
  );
};
