import type * as DndKitCoreModule from '@dnd-kit/core';
import type { ProjectGraphState } from '@features/workflow/contracts';
import type { WorkflowUiAdapter } from '@features/workflow/react';
import type { ProjectGraphAction } from '@features/workflow/utility';

import { ChakraProvider } from '@chakra-ui/react';
import { useDroppable } from '@dnd-kit/core';
import { WorkflowUiProvider } from '@features/workflow/react';
import { createProjectGraph, projectGraphReducer } from '@features/workflow/utility';
import { system } from '@theme/system';
import { act, useCallback, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { formEdgeDroppableId } from './formBuilderDnd';
import { FormBuilderTab } from './FormBuilderTab';
import { PanelModeToggle } from './WorkflowLinearPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Probe renders through a passthrough hook spy; compiler memoization can skip pure helper calls independently of
// component renders.
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof DndKitCoreModule>();

  return { ...actual, useDroppable: vi.fn(actual.useDroppable) };
});

describe('Workflow Linear panel mode toggle', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  const renderToggle = async () => {
    const Harness = () => {
      const [mode, setMode] = useState<'view' | 'edit'>('view');
      return <PanelModeToggle mode={mode} onChange={setMode} />;
    };

    await act(() => {
      root.render(
        <ChakraProvider value={system}>
          <Harness />
        </ChakraProvider>
      );
    });

    return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  };

  const selection = (tabs: HTMLButtonElement[]) => tabs.map((tab) => tab.getAttribute('aria-selected'));

  it('exposes View and Edit as a labelled tablist', async () => {
    const tabs = await renderToggle();

    expect(tabs).toHaveLength(2);
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBeTruthy();
    expect(selection(tabs)).toEqual(['true', 'false']);
    expect(
      tabs
        .map((tab) => tab.getAttribute('aria-controls'))
        .filter((id): id is string => id !== null)
        .map((id) => document.getElementById(id))
    ).not.toContain(null);
  });

  it('activates View and Edit with pointer and arrow keys', async () => {
    const tabs = await renderToggle();

    await act(() => userEvent.click(tabs[1]!));
    expect(selection(tabs)).toEqual(['false', 'true']);

    // Roving focus: the tablist is one tab stop and arrows move within it.
    tabs[1]?.focus();
    await act(() => userEvent.keyboard('{ArrowLeft}'));
    expect(selection(tabs)).toEqual(['true', 'false']);

    await act(() => userEvent.keyboard('{ArrowRight}'));
    expect(selection(tabs)).toEqual(['false', 'true']);
  });
});

/** A second drag after reparenting verifies completion survives dragged-card remounts through DndContext ownership. */
describe('Form builder drag and drop (dnd-kit)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.width = '480px';
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  /** root -> [heading "Field A", divider, container(column, empty)] */
  const buildInitialGraph = (): ProjectGraphState => {
    let doc = createProjectGraph('form-dnd-test');

    doc = projectGraphReducer(doc, { content: 'Field A', elementType: 'heading', type: 'addFormElement' });
    doc = projectGraphReducer(doc, { elementType: 'divider', type: 'addFormElement' });
    doc = projectGraphReducer(doc, { elementType: 'container', layout: 'column', type: 'addFormElement' });

    return doc;
  };

  const Harness = ({ initialGraph }: { initialGraph: ProjectGraphState }) => {
    const [projectGraph, setProjectGraph] = useState(initialGraph);
    const editGraph = useCallback((action: ProjectGraphAction) => {
      setProjectGraph((current) => projectGraphReducer(current, action));
    }, []);
    const adapter = useMemo(
      () =>
        ({
          commands: {
            bindLibraryWorkflow: () => undefined,
            editGraph,
            redo: () => undefined,
            replace: () => undefined,
            undo: () => undefined,
          },
          widgets: { open: () => undefined, patchValues: () => undefined },
        }) as unknown as WorkflowUiAdapter,
      [editGraph]
    );

    return (
      <WorkflowUiProvider adapter={adapter}>
        <FormBuilderTab projectGraph={projectGraph} />
      </WorkflowUiProvider>
    );
  };

  const renderHarness = async (initialGraph: ProjectGraphState = buildInitialGraph()): Promise<void> => {
    await act(() => {
      root.render(
        <ChakraProvider value={system}>
          <Harness initialGraph={initialGraph} />
        </ChakraProvider>
      );
    });
  };

  /** The title-bar `HStack` is the drag handle: it's the direct DOM parent of its title `Text`. */
  const titleBarFor = (title: string): HTMLElement => {
    const leaf = [...host.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.children.length === 0 && element.textContent?.trim() === title
    );

    if (!leaf?.parentElement) {
      throw new Error(`title bar not found for "${title}"`);
    }

    return leaf.parentElement;
  };

  /** The card's content `Box` — the title bar's rounded-chrome parent's second (and last) child. */
  const cardContentFor = (title: string): HTMLElement => {
    const chrome = titleBarFor(title).parentElement;
    const content = chrome?.lastElementChild;

    if (!(content instanceof HTMLElement)) {
      throw new Error(`card content not found for "${title}"`);
    }

    return content;
  };

  const pointer = (type: string, target: EventTarget, clientX: number, clientY: number): void => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, isPrimary: true, pointerId: 1 })
    );
  };

  const key = (target: EventTarget, code: string): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code }));
  };

  // Re-measuring and sensor activation run on rAF outside React's synchronous
  // event handling, so each step needs a real tick — a bare `act()` leaves
  // `over` stale and the drop resolves against the wrong target.
  const interact = (action: () => void): Promise<void> =>
    act(async () => {
      action();
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 50);
      });
    });

  /** Drags `sourceTitle`'s title bar to `(x, y)` with a >4px jitter move first to arm the PointerSensor. */
  const dragTo = async (sourceTitle: string, x: number, y: number): Promise<void> => {
    const handle = titleBarFor(sourceTitle);
    const startRect = handle.getBoundingClientRect();
    const startX = startRect.left + startRect.width / 2;
    const startY = startRect.top + startRect.height / 2;

    await interact(() => pointer('pointerdown', handle, startX, startY));
    await interact(() => pointer('pointermove', handle.ownerDocument, startX + 8, startY));
    await interact(() => pointer('pointermove', handle.ownerDocument, x, y));
    // The remeasure lands a tick after the move that triggered it, so a no-op
    // settle move re-runs collision detection against current rects.
    await interact(() => pointer('pointermove', handle.ownerDocument, x, y + 1));
    await interact(() => pointer('pointerup', handle.ownerDocument, x, y + 1));
  };

  /** Keyboard drag uses Space/arrows/Space and a net-zero settle nudge for delayed measurement. */
  const dragToWithKeyboard = async (sourceTitle: string, targetCenterY: number): Promise<void> => {
    const handle = titleBarFor(sourceTitle);
    const startRect = handle.getBoundingClientRect();
    const startCenterY = startRect.top + startRect.height / 2;
    const direction = targetCenterY >= startCenterY ? 'ArrowDown' : 'ArrowUp';
    const opposite = direction === 'ArrowDown' ? 'ArrowUp' : 'ArrowDown';
    const steps = Math.round(Math.abs(targetCenterY - startCenterY) / 25);

    handle.focus();
    expect(handle.ownerDocument.activeElement).toBe(handle);

    // Space lifts (dnd-kit's `KeyboardSensor` start code).
    await interact(() => key(handle, 'Space'));

    for (let step = 0; step < steps; step++) {
      await interact(() => key(handle, direction));
    }
    await interact(() => key(handle, direction));
    await interact(() => key(handle, opposite));

    await interact(() => key(handle, 'Space'));
  };

  it('keeps dragging alive after a field is dropped into a container', async () => {
    await renderHarness();

    // Drag 1: "Field A" (a heading) into the empty container's drop zone.
    const emptyHint = [...host.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.textContent === 'Empty container — drag elements here'
    );

    expect(emptyHint).toBeDefined();

    const dropZoneRect = emptyHint!.getBoundingClientRect();

    await dragTo('Heading', dropZoneRect.left + dropZoneRect.width / 2, dropZoneRect.top + dropZoneRect.height / 2);

    const containerContent = cardContentFor('Container (column)');

    expect(containerContent.textContent).toContain('Heading');
    expect(containerContent.textContent).not.toContain('Empty container');

    // Immediately drag again after reparenting to catch lost completion state from the remounted source.
    const headingCardRect = titleBarFor('Heading').parentElement!.getBoundingClientRect();

    await dragTo('Divider', headingCardRect.left + headingCardRect.width / 2, headingCardRect.bottom - 2);

    // The divider moved into the container, next to the heading.
    const containerContentAfter = cardContentFor('Container (column)');

    expect(containerContentAfter.textContent).toContain('Heading');
    expect(containerContentAfter.textContent).toContain('Divider');

    // No card is left stuck at the mid-drag 40% opacity.
    const opacities = [...host.querySelectorAll<HTMLElement>('*')].map((element) => getComputedStyle(element).opacity);

    expect(opacities).not.toContain('0.4');
  });

  /** Exercise KeyboardSensor and rectangle collision fallback; keyboard drags have no pointer coordinates. */
  it('moves a form element into a container with the keyboard', async () => {
    await renderHarness();

    const emptyHint = [...host.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.textContent === 'Empty container — drag elements here'
    );

    expect(emptyHint).toBeDefined();

    const dropZoneRect = emptyHint!.getBoundingClientRect();

    await dragToWithKeyboard('Heading', dropZoneRect.top + dropZoneRect.height / 2);

    const containerContent = cardContentFor('Container (column)');

    expect(containerContent.textContent).toContain('Heading');
    expect(containerContent.textContent).not.toContain('Empty container');
  });

  /** Test keyboard edge targeting separately from container drops to exercise the translated-card-center fallback. */
  it('reorders a form element above a sibling with the keyboard', async () => {
    await renderHarness();

    const headingCardRect = titleBarFor('Heading').parentElement!.getBoundingClientRect();

    await dragToWithKeyboard('Divider', headingCardRect.top + headingCardRect.height * 0.25);

    const leafElements = [...host.querySelectorAll<HTMLElement>('*')].filter(
      (element) => element.children.length === 0
    );
    const dividerIndex = leafElements.findIndex((element) => element.textContent?.trim() === 'Divider');
    const headingIndex = leafElements.findIndex((element) => element.textContent?.trim() === 'Heading');

    expect(dividerIndex).toBeGreaterThanOrEqual(0);
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(dividerIndex).toBeLessThan(headingIndex);
  });

  /**
   * Count untouched card hook calls during pointer moves to verify drop-target context isolation despite compiler
   * memoization.
   */
  it('does not re-render an unrelated card on a drag-move that only changes the drop target', async () => {
    const initialGraph = buildInitialGraph();
    const dividerId = Object.values(initialGraph.form.elements).find((element) => element.type === 'divider')!.id;
    const dividerDroppableId = formEdgeDroppableId(dividerId);

    await renderHarness(initialGraph);

    // Capture the empty hint's rect before drag changes its text to Drop here.
    const emptyHint = [...host.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.textContent === 'Empty container — drag elements here'
    );

    expect(emptyHint).toBeDefined();

    const dropZoneRect = emptyHint!.getBoundingClientRect();
    const midX = dropZoneRect.left + dropZoneRect.width / 2;
    const midY = dropZoneRect.top + dropZoneRect.height / 2;

    const handle = titleBarFor('Heading');
    const startRect = handle.getBoundingClientRect();
    const startX = startRect.left + startRect.width / 2;
    const startY = startRect.top + startRect.height / 2;

    // Activate the sensor and settle delayed measurement before testing moves within one logical target.
    await interact(() => pointer('pointerdown', handle, startX, startY));
    await interact(() => pointer('pointermove', handle.ownerDocument, startX + 8, startY));
    await interact(() => pointer('pointermove', handle.ownerDocument, midX, midY));
    await interact(() => pointer('pointermove', handle.ownerDocument, midX, midY + 1));
    vi.mocked(useDroppable).mockClear();

    // Move within the same target to exercise per-frame state churn without changing the intended drop.
    await interact(() => pointer('pointermove', handle.ownerDocument, midX, midY + 2));
    await interact(() => pointer('pointermove', handle.ownerDocument, midX, midY + 3));

    const dividerCardRerendered = vi
      .mocked(useDroppable)
      .mock.calls.some(([options]) => options.id === dividerDroppableId);

    expect(dividerCardRerendered).toBe(false);

    // End the drag cleanly so it doesn't leak into other tests.
    await interact(() => pointer('pointerup', handle.ownerDocument, midX, midY + 3));
  });
});
