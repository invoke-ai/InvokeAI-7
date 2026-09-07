/* oxlint-disable react-perf/jsx-no-new-function-as-prop */
import type { GenerationModelCatalogItem as ModelConfig } from '@features/generation/contracts';
import type { VaeModelConfig } from '@features/generation/core/types';

import { Icon } from '@chakra-ui/react';
import { isSupportedGenerateModel } from '@features/generation/core/baseGenerationPolicies';
import { normalizeGenerateSettings } from '@features/generation/core/settings';
import { IconButton, Tooltip } from '@platform/ui';
import { RotateCcwIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { flushGenerateDrafts } from './generateDraftRegistry';
import { GeneratePresetsPopover } from './GeneratePresetsPopover';
import { useGenerationUi } from './GenerationUiContext';
import {
  getModelDefaultsPatch,
  getModelDefaultSettings,
  settingsMatchModelDefaults,
} from './shared/modelDefaultSettings';

/**
 * Widget-header actions: the preset library (save/apply/rename/delete named
 * settings snapshots) and reset-every-model-governed-setting-to-model-defaults.
 * They sit in the header because they act on the whole panel, not one zone.
 */
export const GenerateHeaderActions = () => {
  const { t } = useTranslation();
  const ui = useGenerationUi();
  const models = ui.models.catalog;
  const projectId = ui.project.activeProjectId;
  const settings = normalizeGenerateSettings(ui.project.generateValues);
  const supportedModels = useMemo(() => models.filter(isSupportedGenerateModel), [models]);
  const selectedModel = useMemo(
    () => supportedModels.find((model) => model.key === settings?.modelKey),
    [supportedModels, settings?.modelKey]
  );
  const vaeModels = useMemo(
    () => models.filter((model): model is ModelConfig & VaeModelConfig => model.type === 'vae'),
    [models]
  );
  const modelDefaultSettings =
    settings && selectedModel ? getModelDefaultSettings(settings, selectedModel, vaeModels) : null;
  const isAtModelDefaults =
    settings && modelDefaultSettings ? settingsMatchModelDefaults(settings, modelDefaultSettings) : false;

  const resetToModelDefaults = () => {
    if (!selectedModel || !settings) {
      return;
    }

    // Flush pending debounced edits first so this patch lands on top of them;
    // the patch only carries model-governed keys, so flushed prompt edits survive.
    flushGenerateDrafts();
    ui.settings.patchGenerateSettings(getModelDefaultsPatch(settings, selectedModel, vaeModels), projectId);
  };

  const resetLabel = t('widgets.generate.resetAllToModelDefaults');

  return (
    <>
      <GeneratePresetsPopover />
      <Tooltip content={resetLabel}>
        <IconButton
          aria-label={resetLabel}
          color="fg.muted"
          disabled={!selectedModel || isAtModelDefaults}
          size="2xs"
          variant="ghost"
          onClick={resetToModelDefaults}
        >
          <Icon as={RotateCcwIcon} boxSize="3.5" />
        </IconButton>
      </Tooltip>
    </>
  );
};
