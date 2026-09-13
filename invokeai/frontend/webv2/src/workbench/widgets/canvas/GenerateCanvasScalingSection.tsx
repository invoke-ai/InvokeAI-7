/**
 * Canvas "Scale before processing" for the generate widget: whether the bbox
 * is denoised at its own size, grown to the model's optimal area, or at a
 * manual size, with the result always resized back to the bbox. Persisted in
 * the canvas widget's values next to the denoising strength; read back by
 * `prepareCanvasInvocation` and threaded into the pure graph compiler.
 */

import type { NumberInput as ChakraNumberInput, SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasScaleMethod, PidMode } from '@features/generation/contracts';
import type { Project } from '@workbench/projectContracts';

import { Badge, createListCollection, HStack, NumberInput, Stack, Text } from '@chakra-ui/react';
import { resolveCanvasProcessingSize } from '@features/generation/canvasProcessingSize';
import { GenerationSettingsSection } from '@features/generation/components';
import { clampDimension, getGenerationDimensions } from '@features/generation/settings';
import { Field, Select } from '@platform/ui';
import {
  CANVAS_SCALE_METHODS,
  CANVAS_SCALING_KEYS,
  readCanvasScaling,
} from '@workbench/widgets/canvas/invoke/canvasScaling';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: true } as const;

const selectCanvasValues = (project: Project): Record<string, unknown> => getProjectWidgetValues(project, 'canvas');

/** The generate model's base/type and PiD mode decide the grid and optimal area the policy works in. */
const selectProcessingContext = (project: Project) => {
  const generate = getProjectWidgetValues(project, 'generate') as {
    model?: { base?: string; type?: string } | null;
    pidMode?: PidMode;
  };
  const model = generate.model;
  return {
    bbox: project.canvas.document.bbox,
    model: model && typeof model.base === 'string' ? { base: model.base, type: model.type ?? 'main' } : null,
    pidMode: generate.pidMode ?? 'off',
  };
};

const processingContextEqual = (
  a: ReturnType<typeof selectProcessingContext>,
  b: ReturnType<typeof selectProcessingContext>
): boolean =>
  a.bbox.width === b.bbox.width &&
  a.bbox.height === b.bbox.height &&
  a.model?.base === b.model?.base &&
  a.model?.type === b.model?.type &&
  a.pidMode === b.pidMode;

export const GenerateCanvasScalingSection = () => {
  const { t } = useTranslation();
  const { widgets } = useWorkbenchCommands();
  const values = useActiveProjectSelector(selectCanvasValues);
  const scaling = useMemo(() => readCanvasScaling(values), [values]);
  const context = useActiveProjectSelector(selectProcessingContext, processingContextEqual);
  const model = context.model as Parameters<typeof resolveCanvasProcessingSize>[0] | null;
  const dimensions = getGenerationDimensions(model ?? undefined, context.pidMode);
  const processingSize = useMemo(
    () => (model ? resolveCanvasProcessingSize(model, context.pidMode, context.bbox, scaling) : null),
    [context, model, scaling]
  );
  const resizes =
    processingSize !== null &&
    (processingSize.width !== context.bbox.width || processingSize.height !== context.bbox.height);

  const opt = useCallback((key: string) => t(`widgets.generate.scalingOptions.${key}`), [t]);
  const patch = useCallback((partial: Record<string, unknown>) => widgets.patchValues('canvas', partial), [widgets]);

  const methodCollection = useMemo(
    () =>
      createListCollection({
        items: CANVAS_SCALE_METHODS.map((method) => ({ label: opt(`methods.${method}`), value: method })),
      }),
    [opt]
  );
  const methodValue = useMemo(() => [scaling.method], [scaling.method]);
  const handleMethodChange = useCallback(
    ({ value }: SelectValueChangeDetails) => {
      const method = value[0] as CanvasScaleMethod | undefined;
      if (!method) {
        return;
      }
      // Manual starts from the size the frame processes at today, so both
      // sides are pinned and a later frame resize cannot move one of them.
      const seed =
        method === 'manual' && processingSize
          ? {
              [CANVAS_SCALING_KEYS.height]: scaling.height ?? processingSize.height,
              [CANVAS_SCALING_KEYS.width]: scaling.width ?? processingSize.width,
            }
          : {};
      patch({ ...seed, [CANVAS_SCALING_KEYS.method]: method });
    },
    [patch, processingSize, scaling.height, scaling.width]
  );
  const snap = useCallback((value: number) => clampDimension(value, dimensions.grid), [dimensions.grid]);
  // Typing needs the raw digits to land; the size snaps to the grid on commit
  // (Enter / blur), and the compiler clamps whatever is persisted meanwhile.
  const sideHandlers = useCallback(
    (key: string) => ({
      onValueChange: ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
        if (Number.isFinite(valueAsNumber)) {
          patch({ [key]: valueAsNumber });
        }
      },
      onValueCommit: ({ valueAsNumber }: ChakraNumberInput.ValueChangeDetails) => {
        if (Number.isFinite(valueAsNumber)) {
          patch({ [key]: snap(valueAsNumber) });
        }
      },
    }),
    [patch, snap]
  );
  const widthHandlers = useMemo(() => sideHandlers(CANVAS_SCALING_KEYS.width), [sideHandlers]);
  const heightHandlers = useMemo(() => sideHandlers(CANVAS_SCALING_KEYS.height), [sideHandlers]);

  const badges = useMemo(
    () => (
      <Badge size="xs">
        {scaling.method === 'none' || !processingSize
          ? opt(`methods.${scaling.method}`)
          : `${processingSize.width}x${processingSize.height}`}
      </Badge>
    ),
    [opt, processingSize, scaling.method]
  );

  return (
    <GenerationSettingsSection
      badges={badges}
      defaultOpen={false}
      label={t('widgets.generate.scaleBeforeProcessing')}
      sectionId="canvas-scaling"
    >
      <Stack gap="2" p="2">
        <Field label={opt('method')}>
          <Select
            aria-label={opt('method')}
            collection={methodCollection}
            positioning={SELECT_POSITIONING}
            size="xs"
            value={methodValue}
            valueText={opt(`methods.${scaling.method}`)}
            onValueChange={handleMethodChange}
          />
        </Field>
        {scaling.method === 'manual' ? (
          <HStack gap="2">
            <Field label={opt('width')}>
              <NumberInput.Root
                max={dimensions.max}
                min={dimensions.min}
                size="xs"
                step={dimensions.grid}
                value={String(scaling.width ?? context.bbox.width)}
                {...widthHandlers}
              >
                <NumberInput.Control />
                <NumberInput.Input aria-label={opt('width')} />
              </NumberInput.Root>
            </Field>
            <Field label={opt('height')}>
              <NumberInput.Root
                max={dimensions.max}
                min={dimensions.min}
                size="xs"
                step={dimensions.grid}
                value={String(scaling.height ?? context.bbox.height)}
                {...heightHandlers}
              >
                <NumberInput.Control />
                <NumberInput.Input aria-label={opt('height')} />
              </NumberInput.Root>
            </Field>
          </HStack>
        ) : null}
        {scaling.method !== 'none' && processingSize ? (
          <Text color="fg.muted" fontSize="2xs">
            {resizes
              ? t('widgets.generate.scalingOptions.processingSize', {
                  height: processingSize.height,
                  width: processingSize.width,
                })
              : t('widgets.generate.scalingOptions.processingAtFrame')}
          </Text>
        ) : null}
      </Stack>
    </GenerationSettingsSection>
  );
};
