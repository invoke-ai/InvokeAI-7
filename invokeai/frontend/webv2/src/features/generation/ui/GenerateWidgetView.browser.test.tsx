import type { GenerationModelCatalogItem } from '@features/generation/contracts';
import type { ArchitectureCapabilitiesRow } from '@features/generation/core/architectureCapabilities';

import { ChakraProvider } from '@chakra-ui/react';
import { architectureCapabilitiesFixture } from '@features/generation/core/architectureCapabilities.testing';
import { ensureArchitectureCapabilitiesLoaded } from '@features/generation/data/architectureCapabilitiesStore';
import { accountLifecycle } from '@platform/state/accountLifecycle';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerateWidgetView } from './GenerateWidgetView';
import { GenerationUiProvider, type GenerationUiAdapter } from './GenerationUiContext';

vi.mock('react-i18next', () => {
  const messages: Record<string, string> = {
    'widgets.generate.capabilitiesLoadFailed': 'Could not load model capabilities from the backend.',
    'widgets.generate.loadingCapabilities': 'Loading model capabilities…',
    'widgets.generate.retry': 'Retry',
  };

  return { useTranslation: () => ({ t: (key: string) => messages[key] ?? key }) };
});

/**
 * The form has its own suite; what this view owns is the capability gate and the values it hands
 * down, so the stub reports exactly those two.
 */
vi.mock('./GenerateSettingsForm', () => ({
  GenerateSettingsForm: ({
    selectedModel,
    settings,
  }: {
    selectedModel?: { key: string };
    settings: { positivePrompt: string };
  }) => (
    <div data-testid="generate-form">{`model:${selectedModel?.key ?? 'none'} prompt:${settings.positivePrompt}`}</div>
  ),
}));

const getArchitectureCapabilities = vi.fn<() => Promise<ArchitectureCapabilitiesRow[]>>();

/** A request still in flight: the fetch neither resolves nor rejects while the assertions run. */
const pendingRequest = (): Promise<ArchitectureCapabilitiesRow[]> =>
  new Promise(() => {
    // Intentionally never settles.
  });

vi.mock('@features/generation/data/architectureCapabilitiesApi', () => ({
  getArchitectureCapabilities: () => getArchitectureCapabilities(),
}));

const OTHER_MODEL: GenerationModelCatalogItem = {
  base: 'sdxl',
  key: 'other-sdxl',
  name: 'Other SDXL',
  type: 'main',
} as GenerationModelCatalogItem;

const STORED_MODEL: GenerationModelCatalogItem = {
  base: 'sdxl',
  key: 'stored-sdxl',
  name: 'Stored SDXL',
  type: 'main',
} as GenerationModelCatalogItem;

/**
 * Catalog and stored values are pinned module constants on purpose: the project store hands the
 * view the same references on every render, which is what let a resolve attempted before the
 * capability table arrived stay cached after the retry that fixed it.
 */
const CATALOG: readonly GenerationModelCatalogItem[] = [OTHER_MODEL, STORED_MODEL];

const STORED_VALUES = {
  cfgRescaleMultiplier: 0,
  cfgScale: 7.5,
  height: 1024,
  modelKey: STORED_MODEL.key,
  negativePrompt: '',
  positivePrompt: 'a saved prompt',
  scheduler: 'euler',
  seed: 7,
  shouldRandomizeSeed: false,
  steps: 30,
  width: 1024,
};

const patchGenerateSettings = vi.fn();

const buildAdapter = (): GenerationUiAdapter =>
  ({
    models: { catalog: CATALOG, error: null, status: 'loaded' },
    project: { activeProjectId: 'project-1', generateValues: STORED_VALUES },
    settings: { patchGenerateSettings },
  }) as unknown as GenerationUiAdapter;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = async (run: () => void = () => undefined) => {
  await act(async () => {
    run();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });
  });
};

const renderView = () =>
  settle(() =>
    root?.render(
      <ChakraProvider value={system}>
        <GenerationUiProvider adapter={buildAdapter()}>
          <GenerateWidgetView />
        </GenerationUiProvider>
      </ChakraProvider>
    )
  );

const retryButton = (): HTMLButtonElement => {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Retry');

  if (!button) {
    throw new Error('the retry button did not render');
  }

  return button;
};

const formStub = (): HTMLElement | null => document.querySelector('[data-testid="generate-form"]');

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  getArchitectureCapabilities.mockReset();
  patchGenerateSettings.mockClear();
});

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  // Returns the capability store and the core registry to their unloaded state between tests.
  accountLifecycle.invalidate();
});

describe('GenerateWidgetView capability gate', () => {
  it('announces the wait for the capability table instead of rendering the form', async () => {
    getArchitectureCapabilities.mockReturnValue(pendingRequest());

    await renderView();
    await settle(ensureArchitectureCapabilitiesLoaded);

    const region = document.querySelector('[role="status"]');

    expect(region?.getAttribute('aria-busy')).toBe('true');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toContain('Loading model capabilities');
    expect(formStub()).toBeNull();
  });

  it('restores the project model once a retry loads the table', async () => {
    getArchitectureCapabilities.mockRejectedValueOnce(new Error('Fixture capability outage.'));

    await renderView();
    await settle(ensureArchitectureCapabilitiesLoaded);

    const alert = document.querySelector('[role="alert"]');

    expect(alert?.textContent).toContain('Fixture capability outage.');
    expect(formStub()).toBeNull();

    getArchitectureCapabilities.mockResolvedValueOnce(architectureCapabilitiesFixture);

    await settle(() => retryButton().click());

    // The stored selection, not the catalog's first entry, and the project's own prompt.
    expect(formStub()?.textContent).toBe('model:stored-sdxl prompt:a saved prompt');
  });

  it('keeps focus on the retry button while its own retry is in flight', async () => {
    getArchitectureCapabilities.mockRejectedValueOnce(new Error('Fixture capability outage.'));

    await renderView();
    await settle(ensureArchitectureCapabilitiesLoaded);

    getArchitectureCapabilities.mockReturnValue(pendingRequest());

    await settle(() => {
      retryButton().focus();
      retryButton().click();
    });

    expect(document.activeElement).toBe(retryButton());
    expect(retryButton().getAttribute('aria-busy')).toBe('true');
    expect(retryButton().disabled).toBe(false);
    expect(document.querySelector('[role="alert"]')?.getAttribute('aria-busy')).toBe('true');
  });
});
