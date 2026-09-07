import { MouseSensor, type Activator, type SensorOptions, type SensorProps } from '@dnd-kit/core';

/**
 * Sensors for the shell's drag-and-drop that make touch scrolling possible.
 *
 * A distance-only activation constraint (the stock `PointerSensor` setup)
 * claims a touch-drag as soon as the pointer moves a few pixels — before the
 * browser can start panning — so any scrollable surface of draggable items
 * (the gallery grid, the preview filmstrip) is unscrollable by touch: the
 * image is picked up and dragged instead.
 *
 * `HoldToDragSensor` arbitrates the gesture for touch pointers with a timing
 * gate, and keeps pens and the pre-gate behavior for surfaces that cannot pan:
 *
 * - A touch `pointerdown` starts a hold. While the hold is pending the sensor
 *   leaves the gesture strictly alone, so the browser is free to pan: an early
 *   move past the tolerance cancels the gate and the native scroll keeps the
 *   gesture. When the hold elapses the gate *arms* — the draggable node gets
 *   `data-drag-armed` so the tile can show its cue — and only movement past
 *   the tolerance after that starts the drag. A motionless hold that lifts is
 *   therefore an ordinary tap: the sensor never activates, no click is
 *   suppressed, and selection works exactly as before.
 * - If the touched element sits under a `touch-action: none` (itself, or any
 *   ancestor below the first scroll container) the browser can never pan, so
 *   there is nothing to arbitrate: touch drags activate on a small distance,
 *   the pre-gate behavior. This keeps non-scrolling drag surfaces (the preview
 *   frame, floating widget windows) feeling immediate.
 * - Pen pointers activate on a small distance, like the mouse: pen panning
 *   cannot be `preventDefault`ed after the fact (no touch events fire for a
 *   pen), so a hold gate would hand the armed gesture to the browser's pan
 *   claim unpredictably.
 *
 * From the moment the hold arms the gate, the sensor holds the browser's pan
 * off with a document-level non-passive `touchmove` listener — pointer events
 * cannot `preventDefault` a pan, and the browser's own pan threshold can be
 * tighter than the move tolerance (Android Chrome starts scrolling around
 * 8px) — so an armed drag cannot be stolen by the native scroll before it
 * activates, nor mid-drag afterwards.
 *
 * Every path through the state machine ends the gesture explicitly
 * (`onEnd`/`onCancel`), which is what clears dnd-kit's activation guard; a
 * sensor that stops mid-gesture without doing so blocks every later drag on
 * the context until reload. In particular, `pointercancel` — the browser
 * claiming the gesture for a pan — is handled for every pointer type, which
 * is why pens route through this sensor instead of reaching `MouseSensor`
 * (whose mouse-event set has no cancel event).
 */

export const TOUCH_DRAG_HOLD_DELAY_MS = 400;
export const TOUCH_DRAG_MOVE_TOLERANCE_PX = 10;

/** Distance that activates a drag when no hold gate applies (mouse, pen, non-pannable surfaces). */
const DRAG_ACTIVATION_DISTANCE_PX = 6;

const ARMED_CUE_ATTRIBUTE = 'data-drag-armed';

const isScrollableOverflow = (overflow: string) =>
  overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';

/**
 * Whether the browser may pan from a touch starting on `target`: true unless a
 * `touch-action: none` appears on the element itself or an ancestor below the
 * first scroll container. (`touch-action` intersects down the ancestor chain,
 * so a `none` anywhere below the scroller forbids the pan outright.)
 */
const canSurfacePan = (target: EventTarget | null): boolean => {
  let element = target instanceof Element ? target : null;

  while (element) {
    const { overflowX, overflowY, touchAction } = getComputedStyle(element);

    if (touchAction === 'none') {
      return false;
    }

    if (isScrollableOverflow(overflowX) || isScrollableOverflow(overflowY)) {
      return true;
    }

    element = element.parentElement;
  }

  return true;
};

const stopClickPropagation = (event: Event) => {
  event.stopPropagation();
};

export interface HoldToDragSensorOptions extends SensorOptions {
  activationConstraint?: {
    delay: number;
    tolerance: number;
  };
  onActivation?(props: { event: Event }): void;
}

type Gate = 'immediate' | 'waiting' | 'armed' | 'active';

export class HoldToDragSensor {
  static activators: Activator<HoldToDragSensorOptions>[] = [
    {
      eventName: 'onPointerDown',
      handler: (event, options) => {
        const nativeEvent = event.nativeEvent as PointerEvent;

        if (!nativeEvent.isPrimary || nativeEvent.button !== 0) {
          return false;
        }

        if (nativeEvent.pointerType !== 'touch' && nativeEvent.pointerType !== 'pen') {
          return false;
        }

        options.onActivation?.({ event: nativeEvent });
        return true;
      },
    },
  ];

  /**
   * Mirror of `TouchSensor.setup()`: a non-passive `touchmove` listener present
   * from startup makes `preventDefault()` work in touchmove listeners added
   * later (required for iOS Safari), which the active drag relies on.
   */
  static setup(): () => void {
    const noop = () => {};

    window.addEventListener('touchmove', noop, { capture: false, passive: false });

    return () => window.removeEventListener('touchmove', noop);
  }

  autoScrollEnabled = true;

  private readonly props: SensorProps<HoldToDragSensorOptions>;
  private readonly document: Document;
  private readonly pointerId: number;
  private readonly startX: number;
  private readonly startY: number;
  private readonly tolerance: number;
  private readonly cueNode: HTMLElement | null;
  private readonly abortController = new AbortController();
  private holdTimer: number | null = null;
  private gate: Gate | 'idle' = 'idle';
  private detached = false;

  constructor(props: SensorProps<HoldToDragSensorOptions>) {
    this.props = props;

    const event = props.event as PointerEvent;
    this.document = event.target instanceof Element ? event.target.ownerDocument : window.document;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.cueNode = props.activeNode.node.current;

    const { activationConstraint } = props.options ?? {};
    this.tolerance = activationConstraint?.tolerance ?? TOUCH_DRAG_MOVE_TOLERANCE_PX;

    // Pointer listeners live on the document, not the touched element: the
    // element may unmount mid-gesture (the virtualized grid under auto-scroll),
    // and document-level listeners keep receiving the events.
    const { signal } = this.abortController;
    this.document.addEventListener('pointermove', this.handlePointerMove, { signal });
    this.document.addEventListener('pointerup', this.handlePointerEnd, { signal });
    this.document.addEventListener('pointercancel', this.handlePointerCancel, { signal });
    this.document.addEventListener('pointerdown', this.handleSecondaryPointerDown, { signal });
    this.document.addEventListener('touchmove', this.handleTouchMove, { passive: false, signal });
    this.document.addEventListener('keydown', this.handleKeyDown, { signal });
    this.document.addEventListener('visibilitychange', this.handleCancel, { signal });
    window.addEventListener('resize', this.handleCancel, { signal });
    window.addEventListener('contextmenu', this.handleContextMenu, { signal });
    window.addEventListener('dragstart', this.handleNativeDragStart, { signal });

    if (event.pointerType === 'pen' || !canSurfacePan(event.target)) {
      this.gate = 'immediate';
      return;
    }

    this.gate = 'waiting';
    this.holdTimer = window.setTimeout(() => {
      if (this.gate !== 'waiting') {
        return;
      }

      this.gate = 'armed';
      this.cueNode?.setAttribute(ARMED_CUE_ATTRIBUTE, 'true');
      this.props.onPending(
        this.props.active,
        { delay: this.delay, tolerance: this.tolerance },
        { x: this.startX, y: this.startY }
      );
    }, this.delay);
  }

  private get delay(): number {
    return this.props.options?.activationConstraint?.delay ?? TOUCH_DRAG_HOLD_DELAY_MS;
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) {
      return;
    }

    if (this.gate === 'active') {
      this.props.onMove({ x: event.clientX, y: event.clientY });
      return;
    }

    const distance = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);

    if (this.gate === 'immediate') {
      if (distance > DRAG_ACTIVATION_DISTANCE_PX) {
        this.startDrag();
      }

      return;
    }

    if (this.gate === 'armed') {
      // The hold succeeded; movement beyond the tolerance is the drag itself.
      if (distance > this.tolerance) {
        this.startDrag();
      }

      return;
    }

    // Waiting: movement past the tolerance is scrolling intent. The native
    // scroll keeps the gesture; stop tracking it.
    if (distance > this.tolerance) {
      this.endGesture(false);
    }
  };

  private readonly handlePointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) {
      return;
    }

    // A lift: an ordinary tap (never activated) or the end of a drag. Both end
    // the gesture; only an activated drag suppresses the trailing click.
    this.endGesture(true);
  };

  private readonly handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerId) {
      return;
    }

    // The browser claimed the gesture (a native pan). Its event stream ends
    // here, so the sensor must too — a stuck gesture blocks all later drags.
    this.cancelGesture();
  };

  private readonly handleSecondaryPointerDown = (event: PointerEvent) => {
    if (this.gate === 'active') {
      // A second finger during a live drag changes nothing.
      return;
    }

    if (!event.isPrimary) {
      // A second finger during the hold is pinch or scroll intent, never a drag.
      this.cancelGesture();
    }
  };

  private readonly handleTouchMove = (event: TouchEvent) => {
    // From arming onward, hold the browser's pan off: pointer events cannot
    // preventDefault a pan, and the browser's own pan threshold can be tighter
    // than the move tolerance (Android Chrome starts scrolling around 8px), so
    // an armed drag would otherwise be lost to the native scroll the instant
    // the finger moves.
    if ((this.gate === 'armed' || this.gate === 'active') && event.cancelable) {
      event.preventDefault();
    }
  };

  private readonly handleContextMenu = (event: MouseEvent) => {
    if (this.gate === 'armed') {
      // Android's long-press menu (~500ms) outlasts the hold delay. Treat it as
      // menu intent: disarm so a drag cannot start over the open menu, and let
      // the menu through.
      this.cancelGesture();
      return;
    }

    // Mid-drag or mid-gesture: suppress the native menu, as the stock sensors do.
    event.preventDefault();
  };

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.cancelGesture();
    }
  };

  private readonly handleCancel = () => {
    this.cancelGesture();
  };

  private readonly handleNativeDragStart = (event: Event) => {
    event.preventDefault();
  };

  private startDrag() {
    this.clearHoldTimer();
    this.clearArmedCue();
    this.gate = 'active';

    // A drag that ends where it started must not also click its own tile, so
    // swallow the trailing click. Removed shortly after detach (not with the
    // other listeners) so the click that follows the lift stays swallowed.
    this.document.addEventListener('click', stopClickPropagation, true);
    this.document.getSelection()?.removeAllRanges();
    // Keep the selection clear for the whole drag, as the stock sensors do.
    this.document.addEventListener('selectionchange', this.clearSelection, { signal: this.abortController.signal });
    this.props.onStart({ x: this.startX, y: this.startY });
  }

  private readonly clearSelection = () => {
    this.document.getSelection()?.removeAllRanges();
  };

  /**
   * Ends the in-flight gesture. Mirrors the stock sensors' end semantics:
   * `onAbort` when nothing ever activated, then `onEnd`/`onCancel` — the call
   * that clears dnd-kit's activation guard.
   */
  private endGesture(ended: boolean) {
    const activated = this.gate === 'active';

    this.detach();

    if (!activated) {
      this.props.onAbort(this.props.active);
    }

    if (ended) {
      this.props.onEnd();
    } else {
      this.props.onCancel();
    }
  }

  private cancelGesture() {
    this.endGesture(false);
  }

  private clearHoldTimer() {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private clearArmedCue() {
    this.cueNode?.removeAttribute(ARMED_CUE_ATTRIBUTE);
  }

  detach() {
    if (this.detached) {
      return;
    }

    this.detached = true;
    this.gate = 'idle';
    this.clearHoldTimer();
    this.clearArmedCue();
    this.abortController.abort();
    setTimeout(() => this.document.removeEventListener('click', stopClickPropagation, true), 50);
  }
}

/**
 * The stock `MouseSensor` activates for any non-right button, where the
 * `PointerSensor` it replaces only ever accepted the primary button. Restore
 * that guard so middle-click and back/forward buttons cannot start drags.
 */
export class PrimaryMouseSensor extends MouseSensor {}

PrimaryMouseSensor.activators = [
  {
    eventName: 'onMouseDown',
    handler: ({ nativeEvent: event }, { onActivation }) => {
      if (event.button !== 0) {
        return false;
      }

      onActivation?.({ event });
      return true;
    },
  },
];
