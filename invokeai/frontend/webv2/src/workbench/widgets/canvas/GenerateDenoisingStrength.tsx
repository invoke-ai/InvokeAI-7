import type { NumberInput as ChakraNumberInput, SliderValueChangeDetails } from '@chakra-ui/react';

import { Badge, Flex, NumberInput } from '@chakra-ui/react';
import { GenerationSettingsSection } from '@features/generation/components';
import { useDebouncedDraftValue, useRegisterGenerateDraftFlusher } from '@features/generation/react';
import { Slider } from '@platform/ui';
import {
  CANVAS_DENOISING_STRENGTH_KEY,
  clampCanvasDenoisingStrength,
  MAX_CANVAS_DENOISING_STRENGTH,
  MIN_CANVAS_DENOISING_STRENGTH,
  readCanvasDenoisingStrength,
} from '@workbench/widgets/canvas/invoke/canvasStrength';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { DenoisingStrengthWave } from './DenoisingStrengthWave';

const STRENGTH_DEBOUNCE_MS = 250;

const formatStrengthPercent = (value: number): string => `${Math.round(value * 100)}%`;

const selectCanvasStrength = (project: Parameters<typeof getProjectWidgetValues>[0]): number =>
  readCanvasDenoisingStrength(getProjectWidgetValues(project, 'canvas'));

/**
 * The canvas denoising strength as its own Generate-form section: the one
 * img2img knob, persisted in the canvas widget's values and flushed with the
 * form's other drafts before an invocation.
 */
export const GenerateDenoisingStrength = () => {
  const { t } = useTranslation();
  const { widgets } = useWorkbenchCommands();
  const projectId = useActiveProjectSelector((project) => project.id);
  const strength = useActiveProjectSelector(selectCanvasStrength);

  const commitStrength = useCallback(
    (value: number) => {
      widgets.patchValues('canvas', { [CANVAS_DENOISING_STRENGTH_KEY]: clampCanvasDenoisingStrength(value) });
    },
    [widgets]
  );

  const {
    draftValue: draftStrength,
    flushDraftValue,
    setDraftValue: setStrength,
  } = useDebouncedDraftValue({
    delayMs: STRENGTH_DEBOUNCE_MS,
    onCommit: commitStrength,
    resetKey: projectId,
    value: strength,
  });

  useRegisterGenerateDraftFlusher(flushDraftValue);

  const strengthAriaLabel = useMemo(() => [t('widgets.generate.denoisingStrength')], [t]);
  const strengthSliderValue = useMemo(() => [draftStrength], [draftStrength]);
  const strengthNumberValue = useMemo(() => draftStrength.toFixed(2), [draftStrength]);
  const badges = useMemo(
    () => (
      <>
        <Badge size="xs">{formatStrengthPercent(draftStrength)}</Badge>
        <DenoisingStrengthWave value={draftStrength} />
      </>
    ),
    [draftStrength]
  );

  const onSliderChange = useCallback(
    ({ value }: SliderValueChangeDetails) => {
      const next = value[0];
      if (next !== undefined && Number.isFinite(next)) {
        setStrength(next);
      }
    },
    [setStrength]
  );

  const onNumberChange = useCallback(
    ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
      if (Number.isFinite(valueAsNumber)) {
        setStrength(valueAsNumber);
      }
    },
    [setStrength]
  );

  return (
    <GenerationSettingsSection
      badges={badges}
      defaultOpen
      label={t('widgets.generate.denoisingStrength')}
      sectionId="canvas-denoising"
    >
      <Flex align="center" direction="row" gap="2" p="2">
        <Slider
          aria-label={strengthAriaLabel}
          flex="1"
          formatValue={formatStrengthPercent}
          max={MAX_CANVAS_DENOISING_STRENGTH}
          min={MIN_CANVAS_DENOISING_STRENGTH}
          minW="0"
          ms="2"
          size="sm"
          step={0.01}
          value={strengthSliderValue}
          withThumbTooltip
          onValueChange={onSliderChange}
        />
        <NumberInput.Root
          max={MAX_CANVAS_DENOISING_STRENGTH}
          min={MIN_CANVAS_DENOISING_STRENGTH}
          size="xs"
          step={0.05}
          value={strengthNumberValue}
          w="20"
          onValueChange={onNumberChange}
        >
          <NumberInput.Control />
          <NumberInput.Input aria-label={t('widgets.generate.denoisingStrength')} />
        </NumberInput.Root>
      </Flex>
    </GenerationSettingsSection>
  );
};
