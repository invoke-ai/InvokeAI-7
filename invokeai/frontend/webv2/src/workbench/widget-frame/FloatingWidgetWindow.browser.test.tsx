/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { FloatingWidgetState } from '@workbench/layoutContracts';
import type {
  RegisteredWidget,
  WidgetImplementation,
  WidgetManifest,
  WidgetViewProps,
} from '@workbench/widgetContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { closeWorkbenchSettings, settingsDialogStore } from '@workbench/settings/settingsDialogStore';
import i18next from 'i18next';
import { MapIcon, TagsIcon } from 'lucide-react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A floated widget renders bare inside this window, so its header controls
 * only exist here — the map's label and selection toggles used to disappear on
 * float. The window mounts widget actions and the shared settings gear, with
 * its own shade/maximize/dock controls replacing the frame's layout controls.
 */

const windowMocks = vi.hoisted(() => ({
  actionsRegion: null as string | null,
  dockFloating: vi.fn(),
  useFailingWidget: false,
  focusFloating: vi.fn(),
  setFloatingGeometry: vi.fn(),
  setFloatingMode: vi.fn(),
}));

const project = {
  id: 'project-1',
  widgetInstances: {
    'image-map-instance': {
      createdAt: 0,
      id: 'image-map-instance',
      state: { values: {} },
      typeId: 'image-map',
    },
  },
  widgetRegions: { center: { activeInstanceId: null, instanceIds: [] } },
};

vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: unknown) => unknown) => selector(project),
  useActiveProjectId: () => project.id,
  useWorkbenchQueries: () => ({
    getProject: (projectId: string) => (projectId === project.id ? project : null),
    isActiveProject: (projectId: string) => projectId === project.id,
  }),
  useWorkbenchCommands: () => ({ widgets: windowMocks }),
}));

vi.mock('@workbench/WorkbenchWidgetRegistryContext', () => ({
  useWorkbenchWidgetRegistry: () => ({
    getWidgetById: () => (windowMocks.useFailingWidget ? failingWidget : registeredWidget),
    getWidgetsForRegion: () => [],
  }),
}));

// The runtime needs the workbench store; the window's chrome is what is under
// test, and neither the stub view nor the stub actions touch the runtime.
vi.mock('./createWidgetRuntime', () => ({ useWidgetRuntime: () => ({}) }));

import { FloatingWidgetWindow } from './FloatingWidgetWindow';

// The floating slot includes settings, while the overflow menu belongs to the
// full docked header cluster.
const manifest = {
  allowFloating: true,
  allowedRegions: ['center', 'left', 'right'],
  failurePolicy: { isolateRenderFailure: false, onRegistrationFailure: 'disable' },
  icon: MapIcon,
  id: 'image-map',
  label: () => 'Image Map',
  settings: { id: 'imageMap', label: 'Image Map', fields: [], load: () => Promise.resolve({ Field: () => null }) },
  version: 1,
} as unknown as WidgetManifest;

const implementation: WidgetImplementation = {
  headerActions: ({ region }: WidgetViewProps) => {
    windowMocks.actionsRegion = region;

    return (
      <button aria-label="Toggle cluster labels" type="button">
        <TagsIcon />
      </button>
    );
  },
  headerMenu: () => <div data-testid="header-menu" />,
  view: () => <div data-testid="map-body" />,
};

const implementationPromise = Promise.resolve(implementation);
const registeredWidget = {
  implementation: { load: () => implementationPromise, retry: () => {} },
  manifest,
  status: 'enabled',
} as unknown as RegisteredWidget;

const failedLoad = Promise.reject(new Error('chunk unavailable'));
// Nothing awaits this before the render that consumes it; an unhandled
// rejection would fail the run on its own.
failedLoad.catch(() => undefined);
const failingWidget = {
  implementation: { load: () => failedLoad, retry: () => {} },
  // The body isolates its own failure, so only the title bar's containment is
  // under test here.
  manifest: { ...manifest, failurePolicy: { isolateRenderFailure: true, onRegistrationFailure: 'disable' } },
  status: 'enabled',
} as unknown as RegisteredWidget;

const state: FloatingWidgetState = {
  heightPx: 400,
  mode: 'windowed',
  returnRegion: 'right',
  stackOrder: 1,
  widthPx: 500,
  x: 40,
  y: 40,
};

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          floating: { dock: 'Dock to panel', maximize: 'Maximize', move: 'Move {{label}} window', shade: 'Shade' },
          labels: { imageMap: 'Image Map' },
          settingsLabel: '{{label}} settings',
        },
      },
    },
  },
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderWindow = async (floatingState: FloatingWidgetState = state) => {
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <FloatingWidgetWindow instanceId="image-map-instance" stackRank={0} state={floatingState} />
        </ChakraProvider>
      </I18nextProvider>
    );
    await implementationPromise;
  });
  // The chrome slot suspends on the implementation chunk; one more flush lets
  // the resolved actions paint before the assertions run.
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  closeWorkbenchSettings();
  windowMocks.actionsRegion = null;
  windowMocks.useFailingWidget = false;
  windowMocks.dockFloating.mockClear();
  windowMocks.setFloatingGeometry.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('FloatingWidgetWindow chrome', () => {
  it("mounts the widget's own header actions in the title bar, for the floating region", async () => {
    await renderWindow();

    expect(host?.querySelector('button[aria-label="Toggle cluster labels"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="map-body"]')).not.toBeNull();
    expect(windowMocks.actionsRegion).toBe('floating');
  });

  it('keeps one shared settings gear without duplicating the window layout controls', async () => {
    await renderWindow();

    expect(host?.querySelectorAll('button[aria-label="Image Map settings"]')).toHaveLength(1);
    expect(host?.querySelector('button[aria-label*="actions"]')).toBeNull();
    expect(host?.querySelector('button[aria-label="Float Window"]')).toBeNull();
    expect(host?.querySelector<HTMLButtonElement>('button[aria-label="Dock to panel"]')).not.toBeNull();
  });

  it('opens settings for the floating widget instance and remembers its gear for focus restoration', async () => {
    await renderWindow();
    const gear = host!.querySelector<HTMLButtonElement>('button[aria-label="Image Map settings"]')!;
    await act(async () => {
      gear.click();
      await Promise.resolve();
    });
    expect(settingsDialogStore.getSnapshot()).toMatchObject({
      isOpen: true,
      sectionId: 'imageMap',
      target: { instanceId: 'image-map-instance', projectId: 'project-1' },
    });
    expect(settingsDialogStore.getSnapshot().returnFocus).toBe(gear);
  });

  it('keeps the window usable when the widget implementation fails to load', async () => {
    windowMocks.useFailingWidget = true;

    await renderWindow();

    // The chrome slot's `use()` rethrows the rejected load on every render.
    // Nothing between this bar and the app root catches it, so the window has
    // to contain it — dropping the widget's actions, keeping the dock control
    // that is the only way back to the rail.
    expect(host?.querySelector('button[aria-label="Toggle cluster labels"]')).toBeNull();
    expect(host?.querySelector<HTMLButtonElement>('button[aria-label="Dock to panel"]')).not.toBeNull();
  });

  it('does not move the window when an arrow key is pressed on a widget action', async () => {
    await renderWindow();

    const toggle = host?.querySelector<HTMLButtonElement>('button[aria-label="Toggle cluster labels"]');

    await act(async () => {
      toggle?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
      await Promise.resolve();
    });

    expect(windowMocks.setFloatingGeometry).not.toHaveBeenCalled();
  });

  it('still moves the window when an arrow key is pressed on the title bar itself', async () => {
    await renderWindow();

    const titleBar = host?.querySelector<HTMLElement>('[aria-label="Move Image Map window"]');

    await act(async () => {
      titleBar?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' }));
      await Promise.resolve();
    });

    expect(windowMocks.setFloatingGeometry).toHaveBeenCalled();
  });

  it('keeps the widget actions reachable while the window is shaded', async () => {
    await renderWindow({ ...state, mode: 'shaded' });

    expect(host?.querySelector('button[aria-label="Toggle cluster labels"]')).not.toBeNull();
    expect(host?.querySelector('button[aria-label="Image Map settings"]')).not.toBeNull();
    expect(host?.querySelector('[data-testid="map-body"]')).toBeNull();
  });

  it('still docks from the title bar with the widget actions alongside', async () => {
    await renderWindow();

    await act(async () => {
      host?.querySelector<HTMLButtonElement>('button[aria-label="Dock to panel"]')?.click();
      await Promise.resolve();
    });

    expect(windowMocks.dockFloating).toHaveBeenCalledWith('image-map-instance');
  });
});
