import type { CanvasLayerSourceContract, ShapeToolOptions } from '@workbench/canvas-engine/api';
import type { ToolFormProps, ToolPropertyForm } from '@workbench/widgets/canvas/tool-presentation/toolFormContracts';

import { Text } from '@chakra-ui/react';
import { ToggleIconButton } from '@platform/ui/Button';
import { ColorPicker } from '@platform/ui/ColorPicker';
import { MAX_SHAPE_STROKE_WIDTH, getDocumentLayer } from '@workbench/canvas-engine/api';
import { useActiveColorCommands, useActiveColorPair } from '@workbench/widgets/canvas/color-system/useActiveColors';
import { useShapeOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import {
  FormNumberField,
  FormSlider,
  useNumberCommit,
  useSliderGesture,
} from '@workbench/widgets/canvas/tool-presentation/FormControls';
import {
  EditTargetChip,
  PropertyControlRow,
  PropertySegmentedRow,
} from '@workbench/widgets/canvas/tool-presentation/PropertyPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { PaintBucketIcon, SquareIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type ShapeSource = Extract<CanvasLayerSourceContract, { type: 'shape' }>;
type ShapeKind = ShapeToolOptions['kind'];

interface SelectedShape {
  id: string;
  name: string;
  source: ShapeSource;
}

const FALLBACK_COLOR = '#000000';

/**
 * Displayed values follow the selected shape layer, else the creation defaults
 * — kind/width/enablement from the tool options and colors from the active
 * pair (fill = foreground, stroke = background). A selected shape's edits
 * commit to the document (colors record one history entry on release); with
 * nothing selected the color chips edit the pair itself, so there is no second
 * global shape color.
 */
const useShapeEditor = (engine: ToolFormProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useShapeOptions(engine);
  const pair = useActiveColorPair();
  const colorCommands = useActiveColorCommands();
  const selected = useActiveProjectSelector(
    (project): SelectedShape | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'shape'
        ? { id: layer.id, name: layer.name, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.name === b?.name && a?.source === b?.source
  );
  // Polygon shapes (no tool kind) display as rect; every parametric kind passes through.
  const kind: ShapeKind = selected
    ? selected.source.kind === 'polygon'
      ? 'rect'
      : selected.source.kind
    : options.kind;
  const fill = selected ? selected.source.fill : options.fillEnabled ? pair.foreground : null;
  const stroke = selected ? selected.source.stroke : options.strokeEnabled ? pair.background : null;
  const strokeWidth = selected ? selected.source.strokeWidth : options.strokeWidth;

  const commitSource = useCallback(
    (patch: Partial<ShapeSource>) => {
      if (!selected) {
        return;
      }
      const after: ShapeSource = { ...selected.source, ...patch };
      commitPrepared(t('widgets.canvas.toolOptions.shapeEdit'), (model) =>
        model.prepare({ id: selected.id, source: after, type: 'patch-source' })
      );
    },
    [commitPrepared, selected, t]
  );
  const setOptions = useCallback(
    (patch: Partial<ShapeToolOptions>) => {
      engine.interaction.set('shapeOptions', { ...options, ...patch });
    },
    [engine, options]
  );
  const setKind = useCallback(
    (next: ShapeKind) => {
      setOptions({ kind: next });
      commitSource({ kind: next });
    },
    [commitSource, setOptions]
  );
  const previewStrokeWidth = useCallback((value: number) => setOptions({ strokeWidth: value }), [setOptions]);
  const setStrokeWidth = useCallback(
    (value: number) => {
      setOptions({ strokeWidth: value });
      commitSource({ strokeWidth: value });
    },
    [commitSource, setOptions]
  );
  const setFillEnabled = useCallback(
    (checked: boolean) => {
      setOptions({ fillEnabled: checked });
      commitSource({ fill: checked ? (selected?.source.fill ?? pair.foreground) : null });
    },
    [commitSource, pair.foreground, selected, setOptions]
  );
  const setStrokeEnabled = useCallback(
    (checked: boolean) => {
      setOptions({ strokeEnabled: checked });
      commitSource({ stroke: checked ? (selected?.source.stroke ?? pair.background) : null });
    },
    [commitSource, pair.background, selected, setOptions]
  );
  const setFillColor = useCallback(
    (hex: string, commit: boolean) => {
      if (selected) {
        if (commit) {
          commitSource({ fill: hex });
        }
        return;
      }
      colorCommands.setPairColor('foreground', hex);
    },
    [colorCommands, commitSource, selected]
  );
  const setStrokeColor = useCallback(
    (hex: string, commit: boolean) => {
      if (selected) {
        if (commit) {
          commitSource({ stroke: hex });
        }
        return;
      }
      colorCommands.setPairColor('background', hex);
    },
    [colorCommands, commitSource, selected]
  );
  return {
    fill,
    kind,
    selectedName: selected?.name ?? null,
    setFillColor,
    setFillEnabled,
    setKind,
    previewStrokeWidth,
    setStrokeColor,
    setStrokeEnabled,
    setStrokeWidth,
    stroke,
    strokeWidth,
  };
};

const ShapeSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const editor = useShapeEditor(engine);
  const sampleColor = useColorSampler(engine);
  const kindOptions = useMemo(
    () => [
      { label: t('widgets.canvas.toolOptions.shapeRect'), value: 'rect' as const },
      { label: t('widgets.canvas.toolOptions.shapeEllipse'), value: 'ellipse' as const },
      { label: t('widgets.canvas.toolOptions.shapeTriangle'), value: 'triangle' as const },
      { label: t('widgets.canvas.toolOptions.shapeStar'), value: 'star' as const },
    ],
    [t]
  );
  const onFillChange = useCallback((hex: string) => editor.setFillColor(hex, false), [editor]);
  const onFillChangeEnd = useCallback((hex: string) => editor.setFillColor(hex, true), [editor]);
  const onStrokeChange = useCallback((hex: string) => editor.setStrokeColor(hex, false), [editor]);
  const onStrokeChangeEnd = useCallback((hex: string) => editor.setStrokeColor(hex, true), [editor]);
  // Slider ticks preview through the options store; ONE document commit lands on release.
  const previewWidth = useCallback(
    (value: number) => editor.previewStrokeWidth(Math.max(0, Math.round(value))),
    [editor]
  );
  const setWidth = useCallback((value: number) => editor.setStrokeWidth(Math.max(0, Math.round(value))), [editor]);
  const widthGesture = useSliderGesture(Math.round(editor.strokeWidth), setWidth, previewWidth);
  const onWidthCommit = useNumberCommit(setWidth);
  return (
    <>
      <EditTargetChip layerName={editor.selectedName} />
      <PropertySegmentedRow
        label={t('widgets.properties.rows.kind')}
        options={kindOptions}
        value={editor.kind}
        onValueChange={editor.setKind}
      />
      {/* The chip stays enabled-looking but inert when the slot is off; the toggle owns enablement. */}
      <PropertyControlRow label={t('widgets.canvas.toolOptions.shapeFill')}>
        <ColorPicker
          aria-label={t('widgets.canvas.toolOptions.shapeFill')}
          disabled={editor.fill === null}
          value={editor.fill ?? FALLBACK_COLOR}
          onSampleColor={sampleColor}
          onValueChange={onFillChange}
          onValueChangeEnd={onFillChangeEnd}
        />
        <ToggleIconButton
          checked={editor.fill !== null}
          icon={PaintBucketIcon}
          label={t('widgets.canvas.toolOptions.shapeFill')}
          onCheckedChange={editor.setFillEnabled}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.canvas.toolOptions.shapeStroke')}>
        <ColorPicker
          aria-label={t('widgets.canvas.toolOptions.shapeStroke')}
          disabled={editor.stroke === null}
          value={editor.stroke ?? FALLBACK_COLOR}
          onSampleColor={sampleColor}
          onValueChange={onStrokeChange}
          onValueChangeEnd={onStrokeChangeEnd}
        />
        <ToggleIconButton
          checked={editor.stroke !== null}
          icon={SquareIcon}
          label={t('widgets.canvas.toolOptions.shapeStroke')}
          onCheckedChange={editor.setStrokeEnabled}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.width')}>
        <FormSlider
          aria-label={t('widgets.canvas.toolOptions.shapeStrokeWidth')}
          disabled={editor.stroke === null}
          max={MAX_SHAPE_STROKE_WIDTH}
          min={0}
          value={widthGesture.value}
          onValueChange={widthGesture.onChange}
          onValueChangeEnd={widthGesture.onChangeEnd}
        />
        <FormNumberField
          aria-label={t('widgets.canvas.toolOptions.shapeStrokeWidth')}
          disabled={editor.stroke === null}
          max={MAX_SHAPE_STROKE_WIDTH}
          min={0}
          suffix="px"
          value={String(Math.round(editor.strokeWidth))}
          onValueCommit={onWidthCommit}
        />
      </PropertyControlRow>
      <Text color="fg.muted" fontSize="2xs">
        {t('widgets.canvas.toolOptions.shapeHint')}
      </Text>
    </>
  );
};

export const shapeForm: ToolPropertyForm = {
  groups: [{ body: ShapeSettings, id: 'shape', labelKey: 'widgets.properties.groups.shape' }],
  id: 'shape',
  paintsLeaf: true,
};
