import type { ImageMapState } from '@workbench/image-map/api';
import type { WidgetViewProps } from '@workbench/widgetContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { system } from '@theme/system';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@workbench/WorkbenchContext', () => ({
  useWidgetValuesSelector: () => false,
}));

// The real one pulls the ~1.5MB plotly chunk; the badge under test is its
// sibling, not its child, so a stand-in is enough.
vi.mock('./ImageMapPlot', () => ({ default: () => <div data-testid="plot" /> }));

// The install link resolves the configured encoder against the starter
// catalog and queues it; both come from the models feature, so the catalog is
// pinned here and the queueing spied on.
const models = vi.hoisted(() => {
  // A real subscribable store, like the one behind `useActiveInstallSources`:
  // putting the encoder into (and out of) an in-flight install has to re-render
  // whoever read it, which is exactly the path the widget depends on.
  const listeners = new Set<() => void>();
  let active: ReadonlySet<string> = new Set<string>();

  return {
    activeSources: {
      get: (): ReadonlySet<string> => active,
      set: (next: Iterable<string>): void => {
        active = new Set(next);
        for (const listener of listeners) {
          listener();
        }
      },
      subscribe: (listener: () => void): (() => void) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
      },
    },
    ensureStartersLoaded: vi.fn(),
    install: vi.fn((_request: { config?: unknown; source: string }) => Promise.resolve(true)),
  };
});

vi.mock('@features/models', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');

  return {
    ...(await importOriginal<Record<string, unknown>>()),
    ensureStartersLoaded: models.ensureStartersLoaded,
    useActiveInstallSources: () =>
      useSyncExternalStore(models.activeSources.subscribe, models.activeSources.get, models.activeSources.get),
    useInstallActions: () => ({ install: models.install, installMany: vi.fn(), pendingSources: EMPTY_SOURCES }),
    useStartersSelector: (selector: (snapshot: unknown) => unknown) =>
      selector({ response: { starter_models: STARTERS } }),
  };
});

const EMPTY_SOURCES: ReadonlySet<string> = new Set<string>();
const ENCODER_SOURCE = 'apple/DFN2B-CLIP-ViT-L-14-39B';
const ENCODER_DEPENDENCY_SOURCE = 'InvokeAI/encoder-preprocessor';
const STARTERS = [
  {
    base: 'any',
    dependencies: [
      {
        base: 'any',
        description: 'Preprocessor',
        is_installed: false,
        name: 'encoder-preprocessor',
        source: ENCODER_DEPENDENCY_SOURCE,
        type: 'clip_vision',
      },
    ],
    description: 'DFN2B CLIP ViT-L Image Encoder',
    is_installed: false,
    name: 'DFN2B-CLIP-ViT-L-14-39B',
    source: ENCODER_SOURCE,
    type: 'clip_vision',
  },
];

vi.mock('@workbench/image-map/imageMapStore', async (importOriginal) => {
  const original = (await importOriginal()) as object;

  return {
    ...original,
    ensureImageMapLoaded: vi.fn(),
    refreshImageIndexStatus: vi.fn(),
    refreshImageMapPoints: vi.fn(),
    setClusterLabelsEnabled: vi.fn(),
  };
});

import { imageMapStore, refreshImageIndexStatus, refreshImageMapPoints } from '@workbench/image-map/imageMapStore';

import { ImageMapWidgetView } from './ImageMapWidgetView';

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dataFor = (
  state: Extract<ImageMapState, 'disabled' | 'model_missing'>,
  modelName = 'clip-vit-large-patch14'
) => ({
  clusterEps: null,
  modelName: state === 'model_missing' ? modelName : null,
  pointCount: 0,
  points: [],
  stale: false,
  state,
  updatedAt: null,
  visibleHash: null,
});

const renderState = async (state: Extract<ImageMapState, 'disabled' | 'model_missing'>, modelName?: string) => {
  imageMapStore.setSnapshot({
    clusterLabels: null,
    clusterLabelsHash: null,
    data: dataFor(state, modelName),
    error: null,
    indexCounts: null,
    indexUpdatedAt: null,
    loadState: 'loaded',
    renderError: null,
  });

  await act(() =>
    root?.render(
      <ChakraProvider value={system}>
        <ImageMapWidgetView {...({} as WidgetViewProps)} />
      </ChakraProvider>
    )
  );
};

/** Every button the message currently offers, in DOM order. */
const buttonLabels = (): string[] =>
  Array.from(host?.querySelectorAll('button') ?? []).map((button) => button.textContent ?? '');

/** The install jobs the app currently has in flight, as the widget sees them. */
const setActiveInstalls = async (sources: string[]) => {
  await act(() => {
    models.activeSources.set(sources);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  models.activeSources.set([]);
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

describe('Image Map unavailable states', () => {
  it.each([
    [
      'model_missing',
      'Embedding model not installed',
      'To enable image indexing, install the image encoder model',
      // A standing action: nothing polls while the indexer is inert, so the
      // message has to offer its own way to ask the server again.
      ['Check again'],
    ],
    [
      'disabled',
      'Image indexing is off',
      'To enable image indexing, set `image_index_enabled: true` in the server configuration file and restart the server to build a semantic index of your gallery.',
      [],
    ],
  ] as const)(
    'keeps the %s diagnosis visible while exposing a failed refresh',
    async (state, title, detail, actions) => {
      await renderState(state);

      expect(host?.textContent).toContain(title);
      expect(host?.textContent).toContain(detail);
      expect(buttonLabels()).toEqual(actions);

      await act(() => {
        imageMapStore.patchSnapshot({ error: 'The server could not be reached.', loadState: 'error' });
      });

      expect(host?.textContent).toContain(title);
      expect(host?.textContent).toContain('The server could not be reached.');
      expect(host?.querySelector('[role="alert"]')?.textContent).toBe('The server could not be reached.');
      expect(buttonLabels()).toEqual(['Retry']);
    }
  );
});

describe('Image Map missing-model install link', () => {
  it('queues the starter install for the configured encoder', async () => {
    await renderState('model_missing', 'DFN2B-CLIP-ViT-L-14-39B');

    expect(host?.textContent).toContain(
      'To enable image indexing, install the image encoder model DFN2B-CLIP-ViT-L-14-39B from the Model Manager to build a semantic index of your gallery.'
    );

    const link = host?.querySelector('button');

    expect(link?.textContent).toBe('DFN2B-CLIP-ViT-L-14-39B');

    await act(async () => {
      link?.click();
      await Promise.resolve();
    });

    expect(models.install).toHaveBeenCalledWith(expect.objectContaining({ source: 'apple/DFN2B-CLIP-ViT-L-14-39B' }));
  });

  it('queues the starter dependencies ahead of the model itself', async () => {
    await renderState('model_missing', 'DFN2B-CLIP-ViT-L-14-39B');

    await act(async () => {
      host?.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(models.install.mock.calls.map(([request]) => request.source)).toEqual([
      ENCODER_DEPENDENCY_SOURCE,
      ENCODER_SOURCE,
    ]);
    // The curated metadata rides along, so the model registers under its
    // starter identity instead of whatever probing guesses.
    expect(models.install).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ name: 'DFN2B-CLIP-ViT-L-14-39B', type: 'clip_vision' }),
        source: ENCODER_SOURCE,
      })
    );
  });

  it('reports an in-flight download instead of offering the install again', async () => {
    models.activeSources.set([ENCODER_SOURCE]);
    await renderState('model_missing', 'DFN2B-CLIP-ViT-L-14-39B');

    expect(host?.textContent).toContain('DFN2B-CLIP-ViT-L-14-39B (installing…)');
    expect(buttonLabels()).toEqual(['Check again']);
  });

  it('asks the server again as soon as the download lands', async () => {
    models.activeSources.set([ENCODER_SOURCE]);
    await renderState('model_missing', 'DFN2B-CLIP-ViT-L-14-39B');

    expect(refreshImageMapPoints).not.toHaveBeenCalled();

    await setActiveInstalls([]);

    // The server picks the encoder up on the next request, so this refresh is
    // what starts indexing without a restart.
    expect(refreshImageMapPoints).toHaveBeenCalledTimes(1);
    expect(refreshImageIndexStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps the message and the in-flight install mounted while a refresh runs', async () => {
    models.activeSources.set([ENCODER_SOURCE]);
    await renderState('model_missing', 'DFN2B-CLIP-ViT-L-14-39B');

    // A refresh flips loadState to `loading`; a spinner here would unmount the
    // link and lose both the download's pending state and the watcher that
    // refreshes when it lands.
    await act(() => {
      imageMapStore.patchSnapshot({ loadState: 'loading' });
    });

    expect(host?.textContent).toContain('DFN2B-CLIP-ViT-L-14-39B (installing…)');

    await setActiveInstalls([]);

    expect(refreshImageMapPoints).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default encoder name when the server reports none', async () => {
    await renderState('model_missing', '');

    expect(host?.textContent).toContain(
      'install the image encoder model DFN2B-CLIP-ViT-L-14-39B from the Model Manager'
    );
  });

  it('leaves a model the starter catalog does not carry as plain text', async () => {
    await renderState('model_missing');

    expect(host?.textContent).toContain(
      'install the image encoder model clip-vit-large-patch14 from the Model Manager'
    );
    expect(buttonLabels()).toEqual(['Check again']);
  });
});

describe('Image Map indexing activity', () => {
  const renderMapWithCounts = async (
    counts: { total: number; embedded: number; pending: number; failed: number } | null
  ) => {
    imageMapStore.setSnapshot({
      clusterLabels: null,
      clusterLabelsHash: null,
      data: {
        clusterEps: null,
        modelName: null,
        pointCount: 2,
        points: [
          { cluster: 0, imageName: 'a.png', x: 0, y: 0 },
          { cluster: 0, imageName: 'b.png', x: 1, y: 1 },
        ],
        stale: false,
        state: 'ready',
        updatedAt: '2026-08-24T01:00:00',
        visibleHash: 'hash',
      },
      error: null,
      indexCounts: counts,
      indexUpdatedAt: counts ? Date.now() : null,
      loadState: 'loaded',
      renderError: null,
    });

    await act(() =>
      root?.render(
        <ChakraProvider value={system}>
          <ImageMapWidgetView {...({} as WidgetViewProps)} />
        </ChakraProvider>
      )
    );
    // The plot is `lazy()`, so the first render in the file waits on the
    // dynamic import and then on the re-render Suspense schedules once it
    // resolves. Polled rather than flushed a fixed number of times: the badge
    // has to be asserted against the resolved tree, not the fallback.
    for (let attempt = 0; attempt < 50 && !host?.querySelector('[data-testid="plot"]'); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      });
    }
  };

  it('reports an index run over the map instead of drawing it silently', async () => {
    // The has-points branch preempts the progress panel, which is right — a
    // usable stale map beats a progress bar — but it used to do so with no
    // sign that anything was happening, which is what a model-change re-index
    // looks like from the panel: the old map, no labels, no explanation.
    await renderMapWithCounts({ embedded: 1204, failed: 0, pending: 16846, total: 18050 });

    expect(host?.querySelector('[data-testid="plot"]')).not.toBeNull();
    expect(host?.textContent).toContain('indexing 1,204/18,050');
    // The map stays: the badge must not replace it.
    expect(host?.textContent).not.toContain('Indexing images');
  });

  it('names the labels in the badge, since they vanish while the vocabulary rebuilds', async () => {
    await renderMapWithCounts({ embedded: 1204, failed: 0, pending: 16846, total: 18050 });

    const progressbar = host?.querySelector('[role="progressbar"]');

    expect(progressbar?.getAttribute('aria-label')).toContain('cluster labels update as images finish');
  });

  it('shows no badge once the index is idle', async () => {
    await renderMapWithCounts({ embedded: 18050, failed: 0, pending: 0, total: 18050 });

    expect(host?.querySelector('[data-testid="plot"]')).not.toBeNull();
    expect(host?.textContent).not.toContain('indexing');
  });

  it('shows no badge when the counts are absent, as for a non-admin', async () => {
    await renderMapWithCounts(null);

    expect(host?.querySelector('[data-testid="plot"]')).not.toBeNull();
    expect(host?.textContent).not.toContain('indexing');
  });
});
