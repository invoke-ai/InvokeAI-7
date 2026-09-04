import type {
  CanvasCoreStoreCapability,
  CanvasToolCapability,
  ParametricShapeKind,
  ToolId,
} from '@workbench/canvas-engine/api';

import { Box } from '@chakra-ui/react';
import { Toolbar, ToolbarButton } from '@platform/ui/Toolbar';
import {
  BrushIcon,
  CircleIcon,
  EraserIcon,
  FrameIcon,
  HandIcon,
  LassoIcon,
  MoveIcon,
  PaintBucketIcon,
  Rotate3dIcon,
  SquareDashedIcon,
  SquareIcon,
  StarIcon,
  TriangleIcon,
  TypeIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isCanvasToolEnabled } from './canvasInteractionLock';
import { useCanvasActiveTool, useShapeOptions } from './engineStoreHooks';
import { recordSelectFamilyTool, useSelectFamilyTool, type SelectFamilyTool } from './toolFamilyStore';
import { ToolFamilyButton, type ToolFlyoutItem } from './ToolStripFlyout';

type ToolStripEngine = CanvasCoreStoreCapability & { readonly tools: CanvasToolCapability };

interface ToolStripButtonProps {
  engine: ToolStripEngine;
  icon: typeof HandIcon;
  isInteractionLocked: boolean;
  label: string;
  toolId: ToolId;
}

/** One sticky tool button: active state comes from core stores; click drives the tool capability. */
const ToolStripButton = ({ engine, icon, isInteractionLocked, label, toolId }: ToolStripButtonProps) => {
  const activeTool = useCanvasActiveTool(engine);
  const isDisabled = !isCanvasToolEnabled(toolId, isInteractionLocked);
  const onClick = useCallback(() => engine.tools.setTool(toolId), [engine, toolId]);

  return (
    <ToolbarButton disabled={isDisabled} icon={icon} isActive={activeTool === toolId} label={label} onClick={onClick} />
  );
};

const SHAPE_KIND_ICONS: Record<ParametricShapeKind, React.ElementType> = {
  ellipse: CircleIcon,
  rect: SquareIcon,
  star: StarIcon,
  triangle: TriangleIcon,
};
const SHAPE_KIND_ORDER: readonly ParametricShapeKind[] = ['rect', 'ellipse', 'triangle', 'star'];
const SHAPE_KIND_LABEL_KEYS: Record<ParametricShapeKind, string> = {
  ellipse: 'widgets.canvas.toolOptions.shapeEllipse',
  rect: 'widgets.canvas.toolOptions.shapeRect',
  star: 'widgets.canvas.toolOptions.shapeStar',
  triangle: 'widgets.canvas.toolOptions.shapeTriangle',
};

/** The Shape slot: one tool id, the flyout switching which kind the next drag draws. */
const ShapeFamilyButton = ({
  engine,
  isInteractionLocked,
}: {
  engine: ToolStripEngine;
  isInteractionLocked: boolean;
}) => {
  const { t } = useTranslation();
  const activeTool = useCanvasActiveTool(engine);
  const options = useShapeOptions(engine);
  const items: ToolFlyoutItem[] = useMemo(
    () =>
      SHAPE_KIND_ORDER.map((kind) => ({
        icon: SHAPE_KIND_ICONS[kind],
        id: kind,
        label: t(SHAPE_KIND_LABEL_KEYS[kind]),
      })),
    [t]
  );
  const onActivate = useCallback(() => engine.tools.setTool('shape'), [engine]);
  const onSelectSubtool = useCallback(
    (id: string) => {
      engine.interaction.set('shapeOptions', { ...options, kind: id as ParametricShapeKind });
      engine.tools.setTool('shape');
    },
    [engine, options]
  );
  return (
    <ToolFamilyButton
      currentId={options.kind}
      disabled={!isCanvasToolEnabled('shape', isInteractionLocked)}
      icon={SHAPE_KIND_ICONS[options.kind]}
      isActive={activeTool === 'shape'}
      items={items}
      label={t('widgets.canvas.tools.shape')}
      onActivate={onActivate}
      onSelectSubtool={onSelectSubtool}
    />
  );
};

/** The Select slot: marquee and lasso as one family; the slot stands for the last one used. */
const SelectFamilyButton = ({
  engine,
  isInteractionLocked,
}: {
  engine: ToolStripEngine;
  isInteractionLocked: boolean;
}) => {
  const { t } = useTranslation();
  const activeTool = useCanvasActiveTool(engine);
  const stored = useSelectFamilyTool();
  // A hotkey or programmatic switch into the family also becomes its memory.
  useEffect(() => {
    if (activeTool === 'marquee' || activeTool === 'lasso') {
      recordSelectFamilyTool(activeTool);
    }
  }, [activeTool]);
  const current: SelectFamilyTool = activeTool === 'marquee' || activeTool === 'lasso' ? activeTool : stored;
  const items: ToolFlyoutItem[] = useMemo(
    () => [
      { icon: SquareDashedIcon, id: 'marquee', label: t('widgets.canvas.tools.marquee') },
      { icon: LassoIcon, id: 'lasso', label: t('widgets.canvas.tools.lasso') },
    ],
    [t]
  );
  const onActivate = useCallback(() => engine.tools.setTool(current), [current, engine]);
  const onSelectSubtool = useCallback(
    (id: string) => {
      recordSelectFamilyTool(id as SelectFamilyTool);
      engine.tools.setTool(id as ToolId);
    },
    [engine]
  );
  return (
    <ToolFamilyButton
      currentId={current}
      disabled={!isCanvasToolEnabled(current, isInteractionLocked)}
      icon={current === 'lasso' ? LassoIcon : SquareDashedIcon}
      isActive={activeTool === 'marquee' || activeTool === 'lasso'}
      items={items}
      label={t(current === 'lasso' ? 'widgets.canvas.tools.lasso' : 'widgets.canvas.tools.marquee')}
      onActivate={onActivate}
      onSelectSubtool={onSelectSubtool}
    />
  );
};

/**
 * Clears the center region's floating chrome, whose inset already includes the
 * gap below the islands. Outside the center the variable is undefined and the
 * strip falls back to its own top margin.
 */
const TOOL_STRIP_TOP = 'var(--wb-center-chrome-inset, var(--chakra-spacing-2))';

/**
 * The canvas's left-docked, vertical tool strip, topped out directly beneath
 * the region's floating chrome islands. Color-picker is intentionally absent —
 * it's alt-hold-only for now (see `canvas-engine/input/pointerPipeline.ts`),
 * not a sticky tool a user selects directly.
 */
const ToolStripRoot = ({
  engine,
  isInteractionLocked = false,
}: {
  engine: ToolStripEngine;
  isInteractionLocked?: boolean;
}) => {
  const { t } = useTranslation();

  return (
    <Box left="2" position="absolute" top={TOOL_STRIP_TOP} zIndex="2">
      <Toolbar aria-label={t('widgets.canvas.tools.label')}>
        <ToolStripButton
          engine={engine}
          icon={HandIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.view')}
          toolId="view"
        />
        <ToolStripButton
          engine={engine}
          icon={MoveIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.move')}
          toolId="move"
        />
        <ToolStripButton
          engine={engine}
          icon={Rotate3dIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.transform')}
          toolId="transform"
        />
        <ToolStripButton
          engine={engine}
          icon={FrameIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.bbox')}
          toolId="bbox"
        />
        <ToolStripButton
          engine={engine}
          icon={BrushIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.brush')}
          toolId="brush"
        />
        <ToolStripButton
          engine={engine}
          icon={EraserIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.eraser')}
          toolId="eraser"
        />
        <ShapeFamilyButton engine={engine} isInteractionLocked={isInteractionLocked} />
        <ToolStripButton
          engine={engine}
          icon={PaintBucketIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.gradient')}
          toolId="gradient"
        />
        <ToolStripButton
          engine={engine}
          icon={TypeIcon}
          isInteractionLocked={isInteractionLocked}
          label={t('widgets.canvas.tools.text')}
          toolId="text"
        />
        <SelectFamilyButton engine={engine} isInteractionLocked={isInteractionLocked} />
      </Toolbar>
    </Box>
  );
};

export const ToolStrip = Object.assign(ToolStripRoot, { Button: ToolStripButton });
