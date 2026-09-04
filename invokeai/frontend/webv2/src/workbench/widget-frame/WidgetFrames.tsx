import type { WidgetRegion } from '@workbench/layoutContracts';
import type {
  WidgetInstanceId,
  WidgetInstanceRuntimeMeta,
  WidgetHeaderLabel,
  WidgetHeaderMenu,
  WidgetManifest,
  WidgetRuntimeApi,
  WidgetTypeId,
  WorkbenchRegion,
} from '@workbench/widgetContracts';

import { Box, Flex, HStack, Icon, Stack, Text } from '@chakra-ui/react';
import { flushWorkbenchDrafts } from '@platform/react/draftRegistry';
import { useMountEffect } from '@platform/react/useMountEffect';
import { IconButton } from '@platform/ui/Button';
import { Tooltip } from '@platform/ui/Tooltip';
import { useFocusRegionProps } from '@workbench/focusRegions';
import { isWidgetRegion } from '@workbench/layoutContracts';
import { openWorkbenchSettings } from '@workbench/settings/settingsDialogStore';
import { resolveWidgetInstanceLabel } from '@workbench/widgetLabels';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import {
  clampPanelSize,
  getPanelSizeBounds,
  getVisiblePanelCollapseThreshold,
  shouldSnapPanelShutAt,
} from '@workbench/workbenchState';
import { PictureInPicture2Icon, SettingsIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { WidgetActionsMenu } from './WidgetActionsMenu';
import { WidgetIdentityIcon } from './WidgetIdentityIcon';
import { WidgetSourceLockBadge } from './WidgetSourceLockBadge';

const PANEL_SIZE_STEP_PX = 16;

/** `sizePx` is the floored tracked size; `isSnappedShut` survives the flooring. */
interface PanelResizeDrag {
  isSnappedShut: boolean;
  sizePx: number;
}

const RESIZE_HANDLE_HOVER_PROPS = { bg: 'accent.solid', opacity: 0.45 };
const RESIZE_HANDLE_FOCUS_PROPS = { bg: 'accent.solid', opacity: 0.65, outline: '2px solid {colors.accent.solid}' };

export const WidgetPanelFrame = ({
  children,
  instanceId,
  region,
  typeId,
}: {
  children: ReactNode;
  instanceId?: WidgetInstanceId;
  region: Exclude<WidgetRegion, 'center'>;
  typeId?: WidgetTypeId;
}) => {
  const { t } = useTranslation();
  const regionState = useActiveProjectSelector((project) => project.widgetRegions[region]);
  const { layout } = useWorkbenchCommands();
  const [drag, setDrag] = useState<PanelResizeDrag | null>(null);
  // A frame unmounting mid-gesture would otherwise leave window listeners
  // behind and commit a size to a region no longer on screen.
  const pointerSessionRef = useRef<AbortController | null>(null);

  useMountEffect(() => () => pointerSessionRef.current?.abort());
  const isLeft = region === 'left';
  const isBottom = region === 'bottom';
  // Clamped at render, not just on commit, so a persisted size from before a
  // bounds change heals on screen immediately instead of on the next resize.
  const displaySizePx = clampPanelSize(region, drag?.sizePx ?? regionState.sizePx);
  // Mid-drag past the threshold the panel snaps shut on screen, dockview-style;
  // the store's collapse is only committed on release.
  const isSnappedShut = drag?.isSnappedShut ?? false;
  const renderSizePx = isSnappedShut ? 0 : displaySizePx;
  // Side panels yield to a viewport that cannot hold them (see
  // `panelSizeProps`), so the width on screen can sit below the stored one.
  // The gesture, the keyboard floor and the separator's announced value all
  // work from what is on screen; the store keeps the preferred size.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [measuredSizePx, setMeasuredSizePx] = useState<number | null>(null);

  useEffect(() => {
    const frame = frameRef.current;

    if (isBottom || !frame || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => setMeasuredSizePx(Math.round(frame.getBoundingClientRect().width)));

    observer.observe(frame);

    return () => observer.disconnect();
  }, [isBottom]);
  const visibleSizePx =
    isSnappedShut || measuredSizePx === null ? displaySizePx : Math.min(measuredSizePx, displaySizePx);
  const { max: maxPanelSizePx, min: minPanelSizePx } = getPanelSizeBounds(region);
  const focusRegionProps = useFocusRegionProps(region);

  const commitSize = useCallback(
    (sizePx: number) => {
      const nextSizePx = clampPanelSize(region, sizePx);

      if (nextSizePx !== regionState.sizePx) {
        layout.setRegionSize(region, nextSizePx);
      }
    },
    [layout, region, regionState.sizePx]
  );
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const startSizePx = regionState.sizePx;
      // How far the viewport has squeezed the panel below its stored size.
      const squeezePx = clampPanelSize(region, startSizePx) - visibleSizePx;
      const collapseThresholdPx = getVisiblePanelCollapseThreshold(region, visibleSizePx);
      const direction = isLeft ? 1 : -1;
      const pointerSession = new AbortController();

      pointerSessionRef.current = pointerSession;

      let nextDrag: PanelResizeDrag = { isSnappedShut: false, sizePx: clampPanelSize(region, startSizePx) };

      // Keeps the gesture alive when the pointer leaves the window, which is
      // where it goes when dragging the bottom strip shut. Throws if the
      // pointer is already gone; the window listeners still carry the drag.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // No capture available — fall through to the window listeners.
      }

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaPx = isBottom ? startY - moveEvent.clientY : (moveEvent.clientX - startX) * direction;
        const rawSizePx = startSizePx + deltaPx;

        nextDrag = {
          isSnappedShut: shouldSnapPanelShutAt(collapseThresholdPx, rawSizePx - squeezePx, nextDrag.isSnappedShut),
          sizePx: clampPanelSize(region, rawSizePx),
        };
        setDrag(nextDrag);
      };

      const handlePointerUp = () => {
        pointerSession.abort();
        setDrag(null);

        if (nextDrag.isSnappedShut) {
          // Visibility change, not a resize — `sizePx` keeps the width the user
          // chose so the rail button reopens the panel where they left it.
          layout.setRegionCollapsed(region, true);

          return;
        }

        commitSize(nextDrag.sizePx);
      };

      // An interruption, not an instruction: keeps the size, never collapses.
      const handlePointerCancel = () => {
        pointerSession.abort();
        setDrag(null);
        commitSize(nextDrag.sizePx);
      };

      window.addEventListener('pointermove', handlePointerMove, { signal: pointerSession.signal });
      window.addEventListener('pointerup', handlePointerUp, { signal: pointerSession.signal });
      window.addEventListener('pointercancel', handlePointerCancel, { signal: pointerSession.signal });
    },
    [commitSize, isBottom, isLeft, layout, region, regionState.sizePx, visibleSizePx]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? PANEL_SIZE_STEP_PX * 2 : PANEL_SIZE_STEP_PX;
      const sizeChanges: Partial<Record<string, number>> = isBottom
        ? {
            ArrowDown: -step,
            ArrowUp: step,
            End: maxPanelSizePx - displaySizePx,
            Home: minPanelSizePx - displaySizePx,
          }
        : {
            ArrowLeft: isLeft ? -step : step,
            ArrowRight: isLeft ? step : -step,
            End: maxPanelSizePx - displaySizePx,
            Home: minPanelSizePx - displaySizePx,
          };
      const sizeChange = sizeChanges[event.key];

      if (sizeChange === undefined) {
        return;
      }

      event.preventDefault();

      // Keyboard parity with the drag: a further collapse-ward step at the
      // floor collapses, instead of silently clamping forever. A squeezed
      // panel is already below the floor on screen, so it collapses too.
      if (sizeChange < 0 && visibleSizePx <= minPanelSizePx) {
        layout.setRegionCollapsed(region, true);

        return;
      }

      commitSize(displaySizePx + sizeChange);
    },
    [commitSize, displaySizePx, isBottom, isLeft, layout, maxPanelSizePx, minPanelSizePx, region, visibleSizePx]
  );
  // The stored size is a preference, not a guarantee: side panels yield
  // (`flexShrink`) when the viewport cannot hold both of them plus the
  // center's minimum — a portrait tablet — so the center never collapses and
  // the opposite rail never gets pushed offscreen. The bottom panel keeps a
  // hard height because the column has no minimum-width peer to protect.
  const panelSizeProps = useMemo(
    () =>
      isBottom
        ? { flexShrink: 0, h: `${renderSizePx}px`, w: 'full' }
        : { flexShrink: 1, h: 'full', w: `${renderSizePx}px` },
    [renderSizePx, isBottom]
  );
  // Inside the panel's box, never straddling its edge: the frame clips its
  // overflow, so a handle hung outside loses that half and leaves a ~4px
  // target sitting behind the border people actually aim at.
  const resizeOrientationProps = useMemo(
    () => (isBottom ? { h: '2', left: '0', right: '0', top: '0' } : { bottom: '0', top: '0', w: '2' }),
    [isBottom]
  );
  const resizeSideProps = useMemo(
    () => (!isBottom ? (isLeft ? { right: '0' } : { left: '0' }) : {}),
    [isBottom, isLeft]
  );

  return (
    <Flex
      aria-label={t('widgets.panelLabel', { region })}
      as="aside"
      bg="bg.subtle"
      borderColor="border.subtle"
      borderRightWidth={isLeft && !isSnappedShut ? '1px' : '0'}
      borderLeftWidth={!isLeft && !isBottom && !isSnappedShut ? '1px' : '0'}
      borderTopWidth={isBottom && !isSnappedShut ? '1px' : '0'}
      direction="column"
      overflow="hidden"
      minW="0"
      ref={frameRef}
      data-hotkey-widget-instance-id={instanceId}
      data-hotkey-widget-region={region}
      data-hotkey-widget-type-id={typeId}
      {...focusRegionProps}
      {...panelSizeProps}
    >
      {children}
      <Box
        aria-label={`Resize ${region} widget panel`}
        aria-orientation={isBottom ? 'horizontal' : 'vertical'}
        aria-valuemax={maxPanelSizePx}
        aria-valuemin={Math.min(minPanelSizePx, visibleSizePx)}
        aria-valuenow={visibleSizePx}
        as="div"
        cursor={isBottom ? 'ns-resize' : 'ew-resize'}
        position="absolute"
        role="separator"
        tabIndex={0}
        data-collapse-armed={isSnappedShut ? '' : undefined}
        opacity="0"
        transition="opacity var(--wb-motion-duration-fast) ease, background var(--wb-motion-duration-fast) ease"
        zIndex="1"
        {...resizeOrientationProps}
        {...resizeSideProps}
        _hover={RESIZE_HANDLE_HOVER_PROPS}
        _focusVisible={RESIZE_HANDLE_FOCUS_PROPS}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
      />
    </Flex>
  );
};

/**
 * The docked half of the float/dock pair: one icon in the widget's header
 * actions that detaches it into a floating window. Its opposite — the dock
 * control — sits in the same corner of `FloatingWidgetWindow`'s title bar, so
 * the mode is one click away either way instead of a menu item in one mode and
 * a button in the other.
 */
export const WidgetFloatButton = ({
  instanceId,
  manifest,
  region,
}: {
  instanceId: WidgetInstanceId;
  manifest: WidgetManifest;
  region: WorkbenchRegion;
}) => {
  const { t } = useTranslation();
  const { widgets } = useWorkbenchCommands();
  // A dialog or popover's chrome never floats; anything else is a dockable
  // layout region, which is also the dock-back target.
  const dockableRegion = isWidgetRegion(region) ? region : undefined;
  // Floating unmounts the docked subtree; the draft registry's cleanup only
  // deregisters the flusher, so an uncommitted edit is lost without this. The
  // region rides along: one instance may be placed in several regions (the
  // preview lives in the center and a rail), and the window docks back into
  // the one whose button was clicked.
  const handleFloat = useCallback(() => {
    if (!dockableRegion) {
      return;
    }

    flushWorkbenchDrafts();
    widgets.float(instanceId, dockableRegion);
  }, [dockableRegion, instanceId, widgets]);
  // Floating is offered only from dockable regions; the floating window's own
  // chrome carries the dock control. Even the last center *view* may float:
  // the emptied surface falls back to the center's fallback view, and the
  // window's dock control restores it — only the destructive placements
  // (`closeWidgetPlacement`, `toggleRegionWidget`) still refuse that.
  const canFloat = Boolean(manifest.allowFloating) && dockableRegion !== undefined;

  if (!canFloat) {
    return null;
  }

  return (
    <Tooltip content={t('widgets.floating.floatWindow')}>
      <IconButton
        aria-label={t('widgets.floating.floatWindow')}
        color="fg.muted"
        size="2xs"
        variant="ghost"
        onClick={handleFloat}
      >
        <Icon as={PictureInPicture2Icon} boxSize="3.5" />
      </IconButton>
    </Tooltip>
  );
};

/**
 * The trailing action cluster of a widget's chrome: the manifest's own
 * `headerActions`, the settings gear, the float control, and the shared
 * overflow menu. Panels render it inside {@link WidgetHeader}; the center
 * region renders it on its own, floating over the work surface, so it lives
 * apart from the header row.
 */
export const WidgetHeaderActionsGroup = ({
  actions,
  HeaderMenu,
  instance,
  manifest,
  region,
  runtime,
}: {
  actions?: ReactNode;
  HeaderMenu?: WidgetHeaderMenu;
  instance: WidgetInstanceRuntimeMeta;
  manifest: WidgetManifest;
  region: WorkbenchRegion;
  runtime: WidgetRuntimeApi;
}) => {
  const { t } = useTranslation();
  const label = resolveWidgetInstanceLabel(instance, manifest, t);
  const handleSettingsClick = useCallback(
    () => openWorkbenchSettings(manifest.settingsSection),
    [manifest.settingsSection]
  );

  return (
    <HStack flexShrink={0} gap="0.5">
      {actions}
      {manifest.settingsSection ? (
        <Tooltip content={t('widgets.settingsLabel', { label })}>
          <IconButton
            aria-label={t('widgets.settingsLabel', { label })}
            color="fg.muted"
            size="2xs"
            variant="ghost"
            onClick={handleSettingsClick}
          >
            <Icon as={SettingsIcon} boxSize="3.5" />
          </IconButton>
        </Tooltip>
      ) : null}
      <WidgetFloatButton instanceId={instance.id} manifest={manifest} region={region} />
      <WidgetActionsMenu
        HeaderMenu={HeaderMenu}
        instance={instance}
        manifest={manifest}
        region={region}
        runtime={runtime}
      />
    </HStack>
  );
};

export const WidgetHeader = ({
  actions,
  HeaderLabel,
  HeaderMenu,
  instance,
  manifest,
  region,
  runtime,
}: {
  actions?: ReactNode;
  HeaderLabel?: WidgetHeaderLabel;
  HeaderMenu?: WidgetHeaderMenu;
  instance: WidgetInstanceRuntimeMeta;
  manifest: WidgetManifest;
  region: WorkbenchRegion;
  runtime: WidgetRuntimeApi;
}) => {
  const { t } = useTranslation();
  // Manifests may provide a component label (e.g. Workflow's editable
  // `Workflow / [name]`); plain strings render as the standard title.
  const label = resolveWidgetInstanceLabel(instance, manifest, t);

  return (
    <HStack justify="space-between" borderBottomWidth={1} h={10} ps="3" pe="2">
      <HStack flex="1" gap="1.5" minW="0">
        <WidgetIdentityIcon icon={manifest.icon} />
        {HeaderLabel && !instance.title ? (
          <HeaderLabel region={region} />
        ) : (
          <Text data-widget-identity-label="" fontSize="xs" fontWeight="700">
            {label}
          </Text>
        )}
        <WidgetSourceLockBadge typeId={manifest.id} />
      </HStack>
      <WidgetHeaderActionsGroup
        HeaderMenu={HeaderMenu}
        actions={actions}
        instance={instance}
        manifest={manifest}
        region={region}
        runtime={runtime}
      />
    </HStack>
  );
};

export const WidgetTooltipFrame = ({
  children,
  icon,
  isLoading = false,
}: {
  children: ReactNode;
  icon: WidgetManifest['icon'];
  isLoading?: boolean;
}) => (
  <HStack align="start" gap="1.5" minW="9rem">
    <WidgetIdentityIcon icon={icon} isLoading={isLoading} />
    <Box minW="0">{children}</Box>
  </HStack>
);

export const FieldPlaceholder = ({ label, h }: { label: string; h: string }) => (
  <Stack gap="1">
    <Text color="fg.muted" fontSize="2xs" fontWeight="600" textTransform="uppercase">
      {label}
    </Text>
    <Box bg="bg.subtle" borderWidth="1px" borderColor="border.subtle" h={h} rounded="md" w="full" />
  </Stack>
);
