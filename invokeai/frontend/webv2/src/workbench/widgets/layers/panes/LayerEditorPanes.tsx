import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { Box, Flex, Icon } from '@chakra-ui/react';
import { useMountEffect } from '@platform/react/useMountEffect';
import { IconButton } from '@platform/ui/Button';
import { SEGMENT_TABS_HEIGHT_PX, SegmentTabs, segmentTabsPanelId, segmentTabsTabId } from '@platform/ui/SegmentTabs';
import { Tooltip } from '@platform/ui/Tooltip';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  LayerColorPaneId,
  LayerColorPaneLayout,
  LayerEditorPaneId,
  LayerEditorPaneLayout,
  PaneBlockLayout,
} from './editorPaneLayout';

import { ColorPane } from './ColorPane';
import {
  clampColorPaneSize,
  clampLayerEditorPaneSize,
  COLOR_PANE_MAX_SIZE_PX,
  COLOR_PANE_MIN_SIZE_PX,
  LAYER_EDITOR_PANE_MAX_SIZE_PX,
  LAYER_EDITOR_PANE_MIN_SIZE_PX,
} from './editorPaneLayout';
import { OverviewPane } from './OverviewPane';
import { PropertiesPane } from './PropertiesPane';
import { SwatchesPane } from './SwatchesPane';
import { TransformPane } from './TransformPane';

const RESIZE_STEP_PX = 16;
/** Parity with the shell panels: releasing at the floor stops there; collapse asks for a real push past it. */
const COLLAPSE_OVERSHOOT_PX = 80;
const HANDLE_HOVER_PROPS = { bg: 'accent.solid', opacity: 0.45 };
const HANDLE_FOCUS_PROPS = { bg: 'accent.solid', opacity: 0.65, outline: '2px solid {colors.accent.solid}' };

interface PaneBlockLabels {
  collapse: string;
  expand: string;
  resize: string;
  tabs: string;
}

/**
 * One fixed pane block of the Layers panel: a tab strip over a panel, with a
 * preferred height, a resize separator on its inner edge, and collapse down to
 * the strip. `edge` names which end of the panel the block is docked to — a
 * top block grows downward and a bottom block grows upward. The panes are part
 * of the panel, never movable widgets.
 */
const LayerPaneBlock = ({
  activePane,
  blockId,
  children,
  clampSize,
  edge,
  labels,
  layout,
  maxSizePx,
  minSizePx,
  onLayoutChange,
  onSelectPane,
  panes,
}: {
  activePane: string;
  blockId: string;
  children: ReactNode;
  clampSize: (next: number) => number;
  edge: 'top' | 'bottom';
  labels: PaneBlockLabels;
  layout: PaneBlockLayout;
  maxSizePx: number;
  minSizePx: number;
  onLayoutChange: (next: PaneBlockLayout) => void;
  onSelectPane: (pane: string) => void;
  panes: ReadonlyArray<{ id: string; label: string }>;
}) => {
  const { isCollapsed, sizePx } = layout;
  // A drag previews the size locally; the store hears about it on release.
  const [previewSizePx, setPreviewSizePx] = useState<number | null>(null);
  const drag = useRef<AbortController | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Toward the panel's middle: the direction a drag or grow-key moves the handle.
  const growSign = edge === 'top' ? 1 : -1;
  const panelId = segmentTabsPanelId(blockId);

  useMountEffect(() => () => drag.current?.abort());

  const patch = useCallback(
    (next: Partial<PaneBlockLayout>) => onLayoutChange({ ...layout, ...next }),
    [layout, onLayoutChange]
  );
  const toggle = useCallback(() => patch({ isCollapsed: !isCollapsed }), [isCollapsed, patch]);
  const commitSize = useCallback(
    (next: number) => {
      const clamped = clampSize(next);
      if (clamped !== sizePx) {
        patch({ sizePx: clamped });
      }
    },
    [clampSize, patch, sizePx]
  );
  const onSeparatorPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const controller = new AbortController();
      drag.current?.abort();
      drag.current = controller;
      let latest = sizePx;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // The window listeners carry the drag without capture.
      }
      const move = (moveEvent: PointerEvent) => {
        latest = sizePx + (moveEvent.clientY - startY) * growSign;
        // Past the overshoot the preview snaps to the strip, so the release's collapse is never a surprise.
        setPreviewSizePx(latest <= minSizePx - COLLAPSE_OVERSHOOT_PX ? SEGMENT_TABS_HEIGHT_PX : clampSize(latest));
      };
      const finish = (apply: boolean) => () => {
        controller.abort();
        setPreviewSizePx(null);
        if (!apply) {
          return;
        }
        if (latest <= minSizePx - COLLAPSE_OVERSHOOT_PX) {
          patch({ isCollapsed: true });
          return;
        }
        commitSize(latest);
      };
      window.addEventListener('pointermove', move, { signal: controller.signal });
      window.addEventListener('pointerup', finish(true), { signal: controller.signal });
      window.addEventListener('pointercancel', finish(false), { signal: controller.signal });
    },
    [clampSize, commitSize, growSign, minSizePx, patch, sizePx]
  );
  const onSeparatorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? RESIZE_STEP_PX * 2 : RESIZE_STEP_PX;
      const grow = edge === 'top' ? 'ArrowDown' : 'ArrowUp';
      const shrink = edge === 'top' ? 'ArrowUp' : 'ArrowDown';
      const change =
        event.key === grow
          ? step
          : event.key === shrink
            ? -step
            : event.key === 'End'
              ? maxSizePx - sizePx
              : event.key === 'Home'
                ? minSizePx - sizePx
                : undefined;
      if (change === undefined) {
        return;
      }
      event.preventDefault();
      // A further collapse-ward step at the floor collapses; the separator unmounts, so focus moves to the strip first.
      if (change < 0 && sizePx <= minSizePx) {
        toggleRef.current?.focus();
        patch({ isCollapsed: true });
        return;
      }
      commitSize(sizePx + change);
    },
    [commitSize, edge, maxSizePx, minSizePx, patch, sizePx]
  );
  const collapseLabel = isCollapsed ? labels.expand : labels.collapse;
  const collapseIcon =
    edge === 'top' ? (isCollapsed ? ChevronDownIcon : ChevronUpIcon) : isCollapsed ? ChevronUpIcon : ChevronDownIcon;
  const separator = !isCollapsed ? (
    <Box flexShrink={0} h="1px" position="relative" zIndex="1">
      <Box
        aria-label={labels.resize}
        aria-orientation="horizontal"
        aria-valuemax={maxSizePx}
        aria-valuemin={minSizePx}
        aria-valuenow={sizePx}
        cursor="ns-resize"
        h="2"
        left="0"
        opacity="0"
        position="absolute"
        right="0"
        role="separator"
        tabIndex={0}
        top="-4px"
        transition="opacity var(--wb-motion-duration-fast) ease"
        _focusVisible={HANDLE_FOCUS_PROPS}
        _hover={HANDLE_HOVER_PROPS}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onSeparatorPointerDown}
      />
    </Box>
  ) : null;
  const collapseButton = useMemo(
    () => (
      <Tooltip content={collapseLabel}>
        <IconButton
          ref={toggleRef}
          aria-expanded={!isCollapsed}
          aria-label={collapseLabel}
          color="fg.muted"
          size="2xs"
          variant="ghost"
          onClick={toggle}
        >
          <Icon as={collapseIcon} boxSize="3.5" />
        </IconButton>
      </Tooltip>
    ),
    [collapseIcon, collapseLabel, isCollapsed, toggle]
  );
  const strip = (
    <SegmentTabs
      activeId={activePane}
      ariaLabel={labels.tabs}
      idBase={blockId}
      showActivePanel={!isCollapsed}
      tabs={panes}
      trailing={collapseButton}
      onSelect={onSelectPane}
    />
  );
  const panel = !isCollapsed ? (
    <Box
      aria-labelledby={segmentTabsTabId(blockId, activePane)}
      flex="1"
      id={panelId}
      minH="0"
      overflow="hidden"
      role="tabpanel"
    >
      {children}
    </Box>
  ) : null;

  return (
    <Flex
      borderColor="border.subtle"
      data-layer-pane-block={blockId}
      data-pane-collapsed={isCollapsed ? '' : undefined}
      direction="column"
      flex={isCollapsed ? '0 0 auto' : `0 1 ${previewSizePx ?? sizePx}px`}
      minH={`${SEGMENT_TABS_HEIGHT_PX}px`}
      overflow="hidden"
      {...(edge === 'top' ? { borderBottomWidth: '1px' } : { borderTopWidth: '1px' })}
    >
      {edge === 'top' ? (
        <>
          {strip}
          {panel}
          {separator}
        </>
      ) : (
        <>
          {separator}
          {strip}
          {panel}
        </>
      )}
    </Flex>
  );
};

const EDITOR_PANES: ReadonlyArray<{ id: LayerEditorPaneId; labelKey: string }> = [
  { id: 'properties', labelKey: 'widgets.labels.properties' },
  { id: 'transform', labelKey: 'widgets.labels.transform' },
  { id: 'overview', labelKey: 'widgets.labels.overview' },
];

/**
 * The editor panes under the tree: the active tool's Properties, the selected
 * layer's Transform, and the document Overview, persisted through the widget's
 * project state.
 */
export const LayerEditorPanes = ({
  layout,
  onLayoutChange,
}: {
  layout: LayerEditorPaneLayout;
  onLayoutChange: (next: LayerEditorPaneLayout) => void;
}) => {
  const { t } = useTranslation();
  const { activePane } = layout;
  const panes = useMemo(() => EDITOR_PANES.map(({ id, labelKey }) => ({ id, label: t(labelKey) })), [t]);
  const labels = useMemo<PaneBlockLabels>(
    () => ({
      collapse: t('widgets.layers.panes.collapse'),
      expand: t('widgets.layers.panes.expand'),
      resize: t('widgets.layers.panes.resize'),
      tabs: t('widgets.layers.panes.tabs'),
    }),
    [t]
  );
  const onSelectPane = useCallback(
    (pane: string) =>
      onLayoutChange(
        pane === layout.activePane
          ? { ...layout, isCollapsed: !layout.isCollapsed }
          : { ...layout, activePane: pane as LayerEditorPaneId, isCollapsed: false }
      ),
    [layout, onLayoutChange]
  );
  const onBlockLayoutChange = useCallback(
    (next: PaneBlockLayout) => onLayoutChange({ ...layout, ...next }),
    [layout, onLayoutChange]
  );

  return (
    <LayerPaneBlock
      activePane={activePane}
      blockId="layer-editor-pane"
      clampSize={clampLayerEditorPaneSize}
      edge="bottom"
      labels={labels}
      layout={layout}
      maxSizePx={LAYER_EDITOR_PANE_MAX_SIZE_PX}
      minSizePx={LAYER_EDITOR_PANE_MIN_SIZE_PX}
      onLayoutChange={onBlockLayoutChange}
      onSelectPane={onSelectPane}
      panes={panes}
    >
      {activePane === 'transform' ? (
        <TransformPane />
      ) : activePane === 'overview' ? (
        <OverviewPane />
      ) : (
        <PropertiesPane />
      )}
    </LayerPaneBlock>
  );
};

const COLOR_PANES: ReadonlyArray<{ id: LayerColorPaneId; labelKey: string }> = [
  { id: 'color', labelKey: 'widgets.labels.color' },
  { id: 'swatches', labelKey: 'widgets.labels.swatches' },
];

/**
 * The color panes above the tree: the project foreground/background pair with
 * its picker and channels, and the swatch shelves as a sibling tab — the
 * layers panel's persistent color workspace.
 */
export const LayerColorPane = ({
  layout,
  onLayoutChange,
}: {
  layout: LayerColorPaneLayout;
  onLayoutChange: (next: LayerColorPaneLayout) => void;
}) => {
  const { t } = useTranslation();
  const { activePane } = layout;
  const panes = useMemo(() => COLOR_PANES.map(({ id, labelKey }) => ({ id, label: t(labelKey) })), [t]);
  const labels = useMemo<PaneBlockLabels>(
    () => ({
      collapse: t('widgets.layers.colorPane.collapse'),
      expand: t('widgets.layers.colorPane.expand'),
      resize: t('widgets.layers.colorPane.resize'),
      tabs: t('widgets.layers.colorPane.tabs'),
    }),
    [t]
  );
  const onSelectPane = useCallback(
    (pane: string) =>
      onLayoutChange(
        pane === layout.activePane
          ? { ...layout, isCollapsed: !layout.isCollapsed }
          : { ...layout, activePane: pane as LayerColorPaneId, isCollapsed: false }
      ),
    [layout, onLayoutChange]
  );
  const onBlockLayoutChange = useCallback(
    (next: PaneBlockLayout) => onLayoutChange({ ...layout, ...next }),
    [layout, onLayoutChange]
  );

  return (
    <LayerPaneBlock
      activePane={activePane}
      blockId="layer-color-pane"
      clampSize={clampColorPaneSize}
      edge="top"
      labels={labels}
      layout={layout}
      maxSizePx={COLOR_PANE_MAX_SIZE_PX}
      minSizePx={COLOR_PANE_MIN_SIZE_PX}
      onLayoutChange={onBlockLayoutChange}
      onSelectPane={onSelectPane}
      panes={panes}
    >
      {activePane === 'swatches' ? <SwatchesPane /> : <ColorPane />}
    </LayerPaneBlock>
  );
};
