import type { SelectionOp } from '@workbench/canvas-engine/api';
import type { ToolFormProps } from '@workbench/widgets/canvas/tool-presentation/toolFormContracts';

import { HStack } from '@chakra-ui/react';
import { Button, IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { isLeafPixelEditEligible, lookupDocumentLeaf } from '@workbench/canvas-engine/api';
import { useCanvasHasSelection } from '@workbench/widgets/canvas/engineStoreHooks';
import { useActiveProjectSelector } from '@workbench/WorkbenchContext';
import { SquareIcon, SquareMinusIcon, SquarePlusIcon, SquaresIntersectIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const OP_MODES: readonly SelectionOp[] = ['replace', 'add', 'subtract', 'intersect'];

const OP_MODE_LABEL_KEYS: Record<SelectionOp, string> = {
  add: 'widgets.canvas.toolOptions.selectionAdd',
  intersect: 'widgets.canvas.toolOptions.selectionIntersect',
  replace: 'widgets.canvas.toolOptions.selectionReplace',
  subtract: 'widgets.canvas.toolOptions.selectionSubtract',
};

const OP_MODE_ICONS: Record<SelectionOp, typeof SquareIcon> = {
  add: SquarePlusIcon,
  intersect: SquaresIntersectIcon,
  replace: SquareIcon,
  subtract: SquareMinusIcon,
};

const OpModeButton = ({
  active,
  mode,
  onSelect,
}: {
  active: boolean;
  mode: SelectionOp;
  onSelect: (mode: SelectionOp) => void;
}) => {
  const { t } = useTranslation();
  const onClick = useCallback(() => onSelect(mode), [mode, onSelect]);
  const label = t(OP_MODE_LABEL_KEYS[mode]);
  const Icon = OP_MODE_ICONS[mode];
  return (
    <Tooltip content={label}>
      <IconButton
        aria-label={label}
        aria-pressed={active}
        size="xs"
        variant={active ? 'solid' : 'ghost'}
        onClick={onClick}
      >
        <Icon />
      </IconButton>
    </Tooltip>
  );
};

/**
 * The boolean op mode every pixel-selection tool shares (also settable
 * transiently with shift / alt while committing), plus the gesture hint while
 * no selection exists. The mode lives in each tool's own options store.
 */
/** The four op-mode toggles alone; the form places them in a labelled row. */
export const SelectionOpModeButtons = ({
  mode,
  onModeChange,
}: {
  mode: SelectionOp;
  onModeChange: (mode: SelectionOp) => void;
}) => {
  const { t } = useTranslation();
  return (
    <HStack aria-label={t('widgets.canvas.toolOptions.selectionMode')} flexShrink={0} gap="1" role="group">
      {OP_MODES.map((opMode) => (
        <OpModeButton key={opMode} active={mode === opMode} mode={opMode} onSelect={onModeChange} />
      ))}
    </HStack>
  );
};

/**
 * Commands over the live selection. Fill, erase and lift need an eligible
 * (unlocked, visible) paint layer — the same rule the engine enforces; invert
 * and deselect need only a selection.
 */
export const SelectionActions = ({ engine }: ToolFormProps) => {
  const { t } = useTranslation();
  const hasSelection = useCanvasHasSelection(engine);
  const canPaintTarget = useActiveProjectSelector((project) => {
    const { document } = project.canvas;
    return isLeafPixelEditEligible(lookupDocumentLeaf(document, document.selectedLayerId ?? ''));
  });
  const onFill = useCallback(() => engine.selection.fillSelection(), [engine]);
  const onErase = useCallback(() => engine.selection.eraseSelection(), [engine]);
  const onInvert = useCallback(() => engine.selection.invertSelection(), [engine]);
  const onDeselect = useCallback(() => engine.selection.deselect(), [engine]);
  const onLiftToLayer = useCallback(() => engine.selection.liftSelectionToLayer(), [engine]);
  const canEdit = hasSelection && canPaintTarget;
  return (
    <HStack flexWrap="wrap" gap="1">
      <Button disabled={!canEdit} size="xs" variant="ghost" onClick={onFill}>
        {t('widgets.canvas.toolOptions.fillSelection')}
      </Button>
      <Button disabled={!canEdit} size="xs" variant="ghost" onClick={onErase}>
        {t('widgets.canvas.toolOptions.eraseSelection')}
      </Button>
      <Button disabled={!canEdit} size="xs" variant="ghost" onClick={onLiftToLayer}>
        {t('widgets.canvas.toolOptions.liftSelectionToLayer')}
      </Button>
      <Button disabled={!hasSelection} size="xs" variant="ghost" onClick={onInvert}>
        {t('widgets.canvas.toolOptions.invertSelection')}
      </Button>
      <Button disabled={!hasSelection} size="xs" variant="ghost" onClick={onDeselect}>
        {t('widgets.canvas.toolOptions.deselect')}
      </Button>
    </HStack>
  );
};
