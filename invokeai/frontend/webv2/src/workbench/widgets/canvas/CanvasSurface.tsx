/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- the container ref callback is intentionally re-created when `engine` changes, so a project switch detaches the old engine and attaches the new one. */
import type { CanvasEngineHandle } from '@workbench/widgets/canvas/useCanvasEngine';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { Box } from '@chakra-ui/react';
import { shouldFocusCanvasSurface } from '@workbench/widgets/canvas/surfaceFocus';
import { TextEditPortal } from '@workbench/widgets/canvas/TextEditPortal';
import { useRef } from 'react';

export type CanvasSurfaceEngine = Pick<
  CanvasEngineHandle,
  'document' | 'interaction' | 'layers' | 'surface' | 'viewport'
>;

/**
 * Focus the canvas container in capture before engine handlers so hotkeys resolve here. Preserve focus already
 * inside, especially text editing, to avoid blur-commit before the engine's commit-and-swallow path.
 */
const focusCanvasSurface = (event: ReactPointerEvent<HTMLDivElement>) => {
  if (shouldFocusCanvasSurface(event.currentTarget, event.target, document.activeElement)) {
    event.currentTarget.focus({ preventScroll: true });
  }
};

/**
 * Bind document/overlay canvases and ResizeObserver through an engine-keyed ref callback with cleanup. The engine
 * owns input without React interaction renders.
 */
export const CanvasSurface = ({ engine }: { engine: CanvasSurfaceEngine }) => {
  const screenRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const bindContainer = (container: HTMLDivElement) => {
    const screen = screenRef.current;
    const overlay = overlayRef.current;
    if (!screen || !overlay) {
      return;
    }

    engine.surface.attach(screen, overlay);

    const syncSize = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      engine.surface.resize(container.clientWidth, container.clientHeight, dpr);
    };

    syncSize();
    // Fit the document into view the first time this canvas is shown, once the
    // viewport is sized. The shell keeps widgets mounted across layout switches,
    // so this callback re-runs on every re-show and an unconditional fit would
    // reset the user's zoom and pan each time they came back.
    engine.viewport.fitToViewOnFirstShow();

    const observer = new ResizeObserver(syncSize);
    observer.observe(container);

    return () => {
      observer.disconnect();
      engine.surface.detach();
    };
  };

  return (
    <Box
      ref={bindContainer}
      h="full"
      outline="none"
      overflow="hidden"
      position="relative"
      tabIndex={-1}
      w="full"
      onPointerDownCapture={focusCanvasSurface}
    >
      <canvas ref={screenRef} style={CANVAS_STYLE} />
      <canvas ref={overlayRef} style={OVERLAY_STYLE} />
      {/* Position text editing inside the canvas container so documentToScreen offsets share the canvas origin. */}
      <TextEditPortal engine={engine} />
    </Box>
  );
};

const CANVAS_STYLE: CSSProperties = {
  height: '100%',
  inset: 0,
  position: 'absolute',
  touchAction: 'none',
  width: '100%',
};

const OVERLAY_STYLE: CSSProperties = { ...CANVAS_STYLE, zIndex: 1 };
