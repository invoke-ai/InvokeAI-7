import type { SelectValueChangeDetails } from '@chakra-ui/react';
import type { CanvasLayerSourceContract, TextToolOptions } from '@workbench/canvas-engine/api';
import type { ToolFormProps, ToolPropertyForm } from '@workbench/widgets/canvas/tool-presentation/toolFormContracts';

import { createListCollection, HStack } from '@chakra-ui/react';
import { IconButton } from '@platform/ui/Button';
import { ColorPicker } from '@platform/ui/ColorPicker';
import { Select } from '@platform/ui/Select';
import {
  MAX_TEXT_FONT_SIZE,
  MIN_TEXT_FONT_SIZE,
  TEXT_FONT_FAMILIES,
  TEXT_FONT_WEIGHTS,
  getDocumentLayer,
} from '@workbench/canvas-engine/api';
import { useActiveColorCommands, useActiveColorPair } from '@workbench/widgets/canvas/color-system/useActiveColors';
import { useTextEditSession, useTextOptions } from '@workbench/widgets/canvas/engineStoreHooks';
import {
  FormNumberField,
  FormSlider,
  useNumberCommit,
  useSliderGesture,
} from '@workbench/widgets/canvas/tool-presentation/FormControls';
import { EditTargetChip, PropertyControlRow } from '@workbench/widgets/canvas/tool-presentation/PropertyPrimitives';
import { useColorSampler } from '@workbench/widgets/canvas/useColorSampler';
import { usePreparedCommit } from '@workbench/widgets/canvas/useStructuralCommit';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { AlignCenterIcon, AlignLeftIcon, AlignRightIcon } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

type TextSource = Extract<CanvasLayerSourceContract, { type: 'text' }>;
type TextAlign = TextToolOptions['align'];

interface SelectedText {
  id: string;
  name: string;
  source: TextSource;
}

const SELECT_POSITIONING = { placement: 'bottom-start', sameWidth: false } as const;
const WEIGHT_TRIGGER_PROPS = { minW: '4.5rem', w: '4.5rem' } as const;

const ALIGN_ICONS: Record<TextAlign, typeof AlignLeftIcon> = {
  center: AlignCenterIcon,
  left: AlignLeftIcon,
  right: AlignRightIcon,
};

const ALIGN_LABEL_KEYS: Record<TextAlign, string> = {
  center: 'widgets.canvas.toolOptions.textAlignCenter',
  left: 'widgets.canvas.toolOptions.textAlignLeft',
  right: 'widgets.canvas.toolOptions.textAlignRight',
};

const ALIGN_VALUES: readonly TextAlign[] = ['left', 'center', 'right'];

const AlignButton = ({
  active,
  onSelect,
  value,
}: {
  active: boolean;
  onSelect: (value: TextAlign) => void;
  value: TextAlign;
}) => {
  const { t } = useTranslation();
  const Icon = ALIGN_ICONS[value];
  const onClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <IconButton
      aria-label={t(ALIGN_LABEL_KEYS[value])}
      aria-pressed={active}
      size="xs"
      variant={active ? 'solid' : 'ghost'}
      onClick={onClick}
    >
      <Icon />
    </IconButton>
  );
};

/**
 * Displayed values: an open editing session's live source, else the selected
 * text layer, else the tool defaults — with color from the active foreground
 * when neither a session nor a selection owns one, so there is no second
 * global text color. Style edits update the defaults, then restyle the live
 * session (folded into its single commit) or commit one history entry on the
 * selected layer; color edits with nothing to own them edit the pair.
 */
const useTextEditor = (engine: ToolFormProps['engine']) => {
  const { t } = useTranslation();
  const commitPrepared = usePreparedCommit(engine);
  const options = useTextOptions(engine);
  const pair = useActiveColorPair();
  const colorCommands = useActiveColorCommands();
  const session = useTextEditSession(engine);
  const selected = useActiveProjectSelector(
    (project): SelectedText | null => {
      const { document } = project.canvas;
      const layer = document.selectedLayerId ? getDocumentLayer(document, document.selectedLayerId) : undefined;
      return layer && layer.type === 'raster' && layer.source.type === 'text'
        ? { id: layer.id, name: layer.name, source: layer.source }
        : null;
    },
    (a, b) => a?.id === b?.id && a?.name === b?.name && a?.source === b?.source
  );
  const styleSource = session ? session.source : (selected?.source ?? null);
  const align = styleSource?.align ?? options.align;
  const fontFamily = styleSource?.fontFamily ?? options.fontFamily;
  const fontSize = styleSource?.fontSize ?? options.fontSize;
  const fontWeight = styleSource?.fontWeight ?? options.fontWeight;
  const lineHeight = styleSource?.lineHeight ?? options.lineHeight;
  const color = styleSource?.color ?? pair.foreground;
  const active = useMemo(
    () => ({ align, color, fontFamily, fontSize, fontWeight, lineHeight }),
    [align, color, fontFamily, fontSize, fontWeight, lineHeight]
  );
  const applyEdit = useCallback(
    (patch: Partial<TextSource>, commit: boolean) => {
      const { color: colorPatch, ...stylePatch } = patch;
      if (Object.keys(stylePatch).length > 0) {
        engine.interaction.set('textOptions', { align, fontFamily, fontSize, fontWeight, lineHeight, ...stylePatch });
      }
      if (session) {
        engine.layers.updateTextEditStyle(patch);
        return;
      }
      if (selected) {
        if (commit) {
          const after: TextSource = { ...selected.source, ...patch };
          commitPrepared(t('widgets.canvas.toolOptions.textEdit'), (model) =>
            model.prepare({ id: selected.id, source: after, type: 'patch-source' })
          );
        }
        return;
      }
      if (colorPatch !== undefined) {
        colorCommands.setPairColor('foreground', colorPatch);
      }
    },
    [align, colorCommands, commitPrepared, engine, fontFamily, fontSize, fontWeight, lineHeight, selected, session, t]
  );
  // The chip names what applyEdit actually writes: the SESSION when one is
  // open (its layer's name, or the new-text placeholder in create mode), else
  // the selected text layer, else the defaults.
  const sessionLayerName = useActiveProjectSelector((project): string | null => {
    if (!session?.layerId) {
      return null;
    }
    return getDocumentLayer(project.canvas.document, session.layerId)?.name ?? null;
  });
  const targetName = session ? (sessionLayerName ?? t('widgets.properties.target.newText')) : (selected?.name ?? null);
  return { active, applyEdit, targetName };
};

const TextFontSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { active, applyEdit, targetName } = useTextEditor(engine);
  const familyCollection = useMemo(
    () => createListCollection<{ label: string; value: string }>({ items: [...TEXT_FONT_FAMILIES] }),
    []
  );
  const familyValue = useMemo(() => [active.fontFamily], [active.fontFamily]);
  const familyLabel = useMemo(
    () => TEXT_FONT_FAMILIES.find((entry) => entry.value === active.fontFamily)?.label ?? active.fontFamily,
    [active.fontFamily]
  );
  const onFamily = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      const next = value[0];
      if (next && next !== active.fontFamily) {
        applyEdit({ fontFamily: next }, true);
      }
    },
    [active.fontFamily, applyEdit]
  );
  const weightCollection = useMemo(
    () =>
      createListCollection<{ label: string; value: string }>({
        items: TEXT_FONT_WEIGHTS.map((weight) => ({ label: String(weight), value: String(weight) })),
      }),
    []
  );
  const weightValue = useMemo(() => [String(active.fontWeight)], [active.fontWeight]);
  const onWeight = useCallback(
    ({ value }: SelectValueChangeDetails<{ label: string; value: string }>) => {
      const next = value[0] ? Number(value[0]) : undefined;
      if (next && next !== active.fontWeight) {
        applyEdit({ fontWeight: next }, true);
      }
    },
    [active.fontWeight, applyEdit]
  );
  // Ticks preview through the defaults/session; ONE document commit lands on release.
  const previewSize = useCallback(
    (value: number) =>
      applyEdit({ fontSize: Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(value))) }, false),
    [applyEdit]
  );
  const setSize = useCallback(
    (value: number) =>
      applyEdit({ fontSize: Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(value))) }, true),
    [applyEdit]
  );
  const sizeGesture = useSliderGesture(Math.round(active.fontSize), setSize, previewSize);
  const onSize = useNumberCommit(setSize);
  const previewLineHeight = useCallback(
    (value: number) => applyEdit({ lineHeight: Math.max(0.5, Math.round(value * 10) / 10) }, false),
    [applyEdit]
  );
  const setLineHeight = useCallback(
    (value: number) => applyEdit({ lineHeight: Math.max(0.5, Math.round(value * 10) / 10) }, true),
    [applyEdit]
  );
  const lineHeightGesture = useSliderGesture(active.lineHeight, setLineHeight, previewLineHeight);
  const onLineHeight = useNumberCommit(setLineHeight);
  return (
    <>
      <EditTargetChip layerName={targetName} />
      <PropertyControlRow label={t('widgets.properties.rows.family')}>
        <Select
          aria-label={t('widgets.canvas.toolOptions.textFont')}
          collection={familyCollection}
          gridColumn="2 / -1"
          positioning={SELECT_POSITIONING}
          size="xs"
          value={familyValue}
          valueText={familyLabel}
          w="full"
          onValueChange={onFamily}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.size')}>
        <FormSlider
          aria-label={t('widgets.canvas.toolOptions.textSize')}
          max={MAX_TEXT_FONT_SIZE}
          min={MIN_TEXT_FONT_SIZE}
          value={sizeGesture.value}
          onValueChange={sizeGesture.onChange}
          onValueChangeEnd={sizeGesture.onChangeEnd}
        />
        <FormNumberField
          aria-label={t('widgets.canvas.toolOptions.textSize')}
          max={MAX_TEXT_FONT_SIZE}
          min={MIN_TEXT_FONT_SIZE}
          suffix="px"
          value={String(Math.round(active.fontSize))}
          onValueCommit={onSize}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.weight')}>
        <Select
          aria-label={t('widgets.canvas.toolOptions.textWeight')}
          collection={weightCollection}
          flexShrink={0}
          positioning={SELECT_POSITIONING}
          size="xs"
          triggerProps={WEIGHT_TRIGGER_PROPS}
          value={weightValue}
          valueText={String(active.fontWeight)}
          w="4.5rem"
          onValueChange={onWeight}
        />
      </PropertyControlRow>
      <PropertyControlRow label={t('widgets.properties.rows.lineHeight')}>
        <FormSlider
          aria-label={t('widgets.canvas.toolOptions.textLineHeight')}
          max={4}
          min={0.5}
          step={0.1}
          value={lineHeightGesture.value}
          onValueChange={lineHeightGesture.onChange}
          onValueChangeEnd={lineHeightGesture.onChangeEnd}
        />
        <FormNumberField
          aria-label={t('widgets.canvas.toolOptions.textLineHeight')}
          max={4}
          min={0.5}
          step={0.1}
          value={active.lineHeight.toFixed(1)}
          onValueCommit={onLineHeight}
        />
      </PropertyControlRow>
    </>
  );
};

const TextParagraphSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const onAlign = useCallback((next: TextAlign) => applyEdit({ align: next }, true), [applyEdit]);
  return (
    <PropertyControlRow label={t('widgets.properties.rows.align')}>
      <HStack gap="0.5">
        {ALIGN_VALUES.map((value) => (
          <AlignButton key={value} active={active.align === value} value={value} onSelect={onAlign} />
        ))}
      </HStack>
    </PropertyControlRow>
  );
};

const TextColorSettings = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const { active, applyEdit } = useTextEditor(engine);
  const sampleColor = useColorSampler(engine);
  const onChange = useCallback((hex: string) => applyEdit({ color: hex }, false), [applyEdit]);
  const onChangeEnd = useCallback((hex: string) => applyEdit({ color: hex }, true), [applyEdit]);
  return (
    <PropertyControlRow label={t('widgets.properties.rows.color')}>
      <ColorPicker
        aria-label={t('widgets.canvas.toolOptions.textColor')}
        value={active.color}
        onSampleColor={sampleColor}
        onValueChange={onChange}
        onValueChangeEnd={onChangeEnd}
      />
    </PropertyControlRow>
  );
};

export const textForm: ToolPropertyForm = {
  groups: [
    { body: TextFontSettings, id: 'text-font', labelKey: 'widgets.properties.groups.font' },
    { body: TextParagraphSettings, id: 'text-paragraph', labelKey: 'widgets.properties.groups.paragraph' },
    { body: TextColorSettings, id: 'text-color', labelKey: 'widgets.properties.rows.color' },
  ],
  id: 'text',
  paintsLeaf: true,
};
