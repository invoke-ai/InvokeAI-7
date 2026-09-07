import type { WidgetViewProps } from '@workbench/widgetContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewHeaderActions } from './PreviewHeaderActions';

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  initAsync: false,
  lng: 'en',
  resources: {
    en: {
      translation: {
        topbar: { invoke: { unavailable: 'Invoke unavailable: {{reason}}', unrunnable: 'Unrunnable' } },
        widgets: {
          preview: {
            hideFilmstrip: 'Hide filmstrip',
            hideInProgressDiffusion: 'Hide in-progress diffusion',
            invoke: 'Invoke',
            showFilmstrip: 'Show filmstrip',
            showInProgressDiffusion: 'Show in-progress diffusion',
          },
        },
      },
    },
  },
});

const state = vi.hoisted(() => ({ filmstripVisible: true, showProgressImagesInViewer: true }));
const patchValues = vi.hoisted(() => vi.fn());
const updateProjectPreferences = vi.hoisted(() => vi.fn());
const executeCommand = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const invocationState = vi.hoisted(() => ({ blockingReasons: [] as string[], isPreparing: false, isValid: true }));

vi.mock('@workbench/shell/topbar/useInvocationState', () => ({
  useInvocationState: () => invocationState,
}));

vi.mock('@features/queue/react', () => ({ useProgressImage: () => null }));

vi.mock('./previewHeaderStore', () => ({
  usePreviewHeaderContext: () => ({
    actionItem: null,
    actions: null,
    copyCurrentVideoFrame: null,
    isVideoFrameCopyAvailable: false,
    openItemMenu: vi.fn(),
    openVideoDetails: null,
  }),
}));

vi.mock('@workbench/widgetState', () => ({
  getProjectWidgetValues: () => ({ filmstripVisible: state.filmstripVisible }),
}));

vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (select: (project: unknown) => unknown) =>
    select({ settings: { showProgressImagesInViewer: state.showProgressImagesInViewer } }),
  useWorkbenchCommands: () => ({
    account: { updateProjectPreferences },
    widgets: { patchValues },
  }),
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = (action: () => void): Promise<void> =>
  act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 40);
    });
  });

const render = async (region: WidgetViewProps['region'] = 'center') => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await settle(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <PreviewHeaderActions
            {...({ region, runtime: { commands: { execute: executeCommand } } } as unknown as WidgetViewProps)}
          />
        </ChakraProvider>
      </I18nextProvider>
    );
  });
};

const button = (label: string): HTMLButtonElement =>
  host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  state.filmstripVisible = true;
  state.showProgressImagesInViewer = true;
  patchValues.mockClear();
  updateProjectPreferences.mockClear();
  executeCommand.mockClear();
  invocationState.blockingReasons = [];
  invocationState.isPreparing = false;
  invocationState.isValid = true;
});

afterEach(async () => {
  await settle(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('preview header toggles', () => {
  it('states both on/off positions the same way', async () => {
    await render();
    const bothOn = [button('Hide filmstrip'), button('Hide in-progress diffusion')];

    for (const control of bothOn) {
      expect(control.getAttribute('aria-pressed'), control.ariaLabel ?? '').toBe('true');
    }

    state.filmstripVisible = false;
    state.showProgressImagesInViewer = false;
    await render();
    const bothOff = [button('Show filmstrip'), button('Show in-progress diffusion')];

    for (const control of bothOff) {
      expect(control.getAttribute('aria-pressed'), control.ariaLabel ?? '').toBe('false');
    }
  });

  it('still toggles the setting each one owns', async () => {
    await render();

    await settle(() => button('Hide filmstrip').click());
    expect(patchValues).toHaveBeenCalledWith('preview', { filmstripVisible: false });

    await settle(() => button('Hide in-progress diffusion').click());
    expect(updateProjectPreferences).toHaveBeenCalledWith({ showProgressImagesInViewer: false });
  });
});

describe('preview floating Invoke control', () => {
  it('is offered only while the widget floats', async () => {
    await render('center');
    expect(host?.querySelector('button[aria-label="Invoke"]')).toBeNull();

    await settle(() => root?.unmount());
    host?.remove();

    await render('right');
    expect(host?.querySelector('button[aria-label="Invoke"]')).toBeNull();

    await settle(() => root?.unmount());
    host?.remove();

    await render('floating');
    expect(host?.querySelector('button[aria-label="Invoke"]')).not.toBeNull();
  });

  it('runs the app-level Invoke command, the same path as the topbar button', async () => {
    await render('floating');

    await settle(() => button('Invoke').click());

    expect(executeCommand).toHaveBeenCalledWith('app.invoke');
  });

  it('dims, names the blocking reason, and refuses the click when Invoke cannot run', async () => {
    invocationState.isValid = false;
    invocationState.blockingReasons = ['The backend is disconnected.'];
    await render('floating');

    const control = button('Invoke unavailable: The backend is disconnected.');
    expect(control.getAttribute('aria-disabled')).toBe('true');

    await settle(() => control.click());

    expect(executeCommand).not.toHaveBeenCalled();
  });
});
