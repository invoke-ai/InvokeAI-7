/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { GalleryImage, GalleryImageItem, GalleryItemsPage, GalleryVideoItem } from '@features/gallery';
import type { QueueItem } from '@features/queue/contracts';
import type { WidgetViewProps } from '@workbench/widgetContracts';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { system } from '@theme/system';
import i18next from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queueItem: QueueItem = {
  cancellable: true,
  id: 'queue-item-live',
  snapshot: {
    backendSubmission: { batchCount: 1, graph: { edges: [], id: 'graph-1', nodes: {} }, kind: 'workflow' },
    destination: 'gallery',
    filterIntermediateResults: false,
    galleryBoardId: null,
    graph: { id: 'graph-1', label: 'Live generation' },
    presentation: { batchCount: 1, height: 64, width: 64 },
    sourceId: 'workflow',
    submittedAt: '2026-07-21T00:00:00.000Z',
  },
  status: 'running',
};

const createImageItem = (name: string, createdAt: string): GalleryImageItem => ({
  boardId: 'none',
  category: 'general',
  createdAt,
  fullUrl: `/images/${name}/full`,
  height: 720,
  isIntermediate: false,
  kind: 'image',
  name,
  sourceQueueItemId: `queue-${name}`,
  starred: false,
  thumbnailUrl: `/images/${name}/thumbnail`,
  width: 1280,
});

const createVideoItem = (name: string, createdAt: string): GalleryVideoItem => ({
  boardId: 'none',
  category: 'general',
  createdAt,
  durationSeconds: 65.1,
  fps: 23.976,
  fullUrl: `data:video/mp4;base64,${name}`,
  height: 1080,
  isIntermediate: false,
  kind: 'video',
  name,
  starred: false,
  thumbnailUrl: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" data-name="${name}"/>`,
  width: 1920,
});

const mocks = vi.hoisted(() => {
  const recentImages = [
    {
      height: 64,
      imageName: 'newest',
      imageUrl: '/images/newest/full',
      queuedAt: '2026-07-21T00:00:00.000Z',
      sourceQueueItemId: 'queue-item-done',
      thumbnailUrl: '/images/newest/thumbnail',
      width: 64,
    },
    {
      height: 64,
      imageName: 'oldest',
      imageUrl: '/images/oldest/full',
      queuedAt: '2026-07-21T00:00:00.000Z',
      sourceQueueItemId: 'queue-item-done',
      thumbnailUrl: '/images/oldest/thumbnail',
      width: 64,
    },
  ];

  return {
    commands: {
      account: { updateProjectPreferences: vi.fn() },
      gallery: { selectImage: vi.fn(), selectItem: vi.fn(), setCompareImage: vi.fn(), setCompareItem: vi.fn() },
      notifications: { reportError: vi.fn() },
      widgets: { patchValues: vi.fn() },
    },
    project: {
      queue: { items: [] as unknown[] },
      settings: { antialiasProgressImages: false, showProgressImagesInViewer: false },
      widgetInstances: {
        gallery: {
          state: {
            values: {
              recentImages,
              selectedImage: { ...recentImages[0], boardId: 'none' },
              selectedImageName: 'newest',
            },
          },
          typeId: 'gallery',
        },
        preview: { state: { values: {} }, typeId: 'preview' },
      },
    },
    galleryItemPageOffsets: [] as number[],
    galleryItemWindowOffsets: [] as number[],
    galleryItemPages: [] as GalleryItemsPage[],
    imageActionOptions: null as null | {
      getItemActionContext?: () => {
        getItemSelectionPage?: (item: GalleryImageItem | GalleryVideoItem) => number;
        items: Array<GalleryImageItem | GalleryVideoItem>;
        loadOrderedRefs: (signal: AbortSignal) => Promise<Array<{ kind: 'image' | 'video'; name: string }>>;
        selectedItemKey: string | null;
      };
      onImagesDeleted?: (imageNames: string[]) => void;
    },
    recentImages,
    useActiveProgressTarget: vi.fn(() => null as unknown),
    useProgressImage: vi.fn(() => null as unknown),
  };
});

vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectId: () => 'project-1',
  useActiveProjectSelector: (selector: (project: typeof mocks.project) => unknown) => selector(mocks.project),
  useWidgetValuesSelector: () => ({}),
  useWorkbenchCommands: () => mocks.commands,
  useWorkbenchQueries: () => ({ getSnapshot: () => ({ activeProject: mocks.project }) }),
  useWorkbenchSelector: (selector: (snapshot: unknown) => unknown) =>
    selector({ backendConnection: { status: 'connected' } }),
}));

vi.mock('@features/queue/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useActiveProgressTarget: () => mocks.useActiveProgressTarget(),
  useProgressImage: () => mocks.useProgressImage(),
}));

vi.mock('@features/gallery/queries', () => ({
  GALLERY_MAX_ROWS: 600,
  GALLERY_PAGE_SIZE: 60,
  flattenGalleryItemsData: (data: InfiniteData<GalleryItemsPage, number> | undefined) =>
    data?.pages.flatMap((page) => page.items) ?? [],
  galleryBoardsOptions: () => ({ queryFn: () => [], queryKey: ['test-boards'], staleTime: Infinity }),
  galleryItemsInfiniteOptions: (
    query: { boardId: string; orderDir?: 'ASC' | 'DESC' },
    window: { kind: 'anchor' | 'infinite' | 'page'; offset?: number } = { kind: 'infinite' }
  ) => {
    const pages = mocks.galleryItemPages.map((page) => {
      const items = page.items.filter((item) => item.boardId === query.boardId);

      return {
        ...page,
        items: query.orderDir === 'ASC' ? items.reverse() : items,
      };
    });
    const initialOffset = window.offset ?? 0;
    const initialPage = pages[initialOffset / 60] ?? { items: [], total: 0 };

    mocks.galleryItemWindowOffsets.push(initialOffset);

    return {
      getNextPageParam: (_lastPage: GalleryItemsPage, _allPages: GalleryItemsPage[], lastPageParam: number) =>
        pages[lastPageParam / 60 + 1] ? lastPageParam + 60 : undefined,
      getPreviousPageParam: (_firstPage: GalleryItemsPage, _allPages: GalleryItemsPage[], firstPageParam: number) =>
        // An anchored infinite window cannot grow upward past its anchor.
        firstPageParam >= 60 && (window.kind !== 'infinite' || firstPageParam - 60 >= initialOffset)
          ? firstPageParam - 60
          : undefined,
      initialData: { pageParams: [initialOffset], pages: [initialPage] },
      initialPageParam: initialOffset,
      queryFn: ({ pageParam }: { pageParam: number }) => {
        mocks.galleryItemPageOffsets.push(pageParam);
        return Promise.resolve(pages[pageParam / 60] ?? { items: [], total: 0 });
      },
      queryKey: ['test-items', query.boardId, query.orderDir, window.kind, initialOffset],
      staleTime: Infinity,
    };
  },
}));

vi.mock('@workbench/image-actions', () => ({
  EMPTY_IMAGE_RECALL_CAPABILITIES: {},
  ImageContextMenu: () => null,
  RecallActionButtons: () => null,
  buildImageRecallSettings: () => ({}),
  executeImageRecall: () => {},
  getCurrentGenerateValues: () => ({}),
  getImageRecallVerb: () => ({ icon: () => null, label: '' }),
  getGalleryCanvasImportMenuItems: () => [],
  getImageContextMenuImages: () => [],
  getImageContextMenuRecallRequestKey: () => null,
  getImageRecallCapabilities: () => ({}),
  getImageRecallMessage: () => '',
  getImageRecallTitle: () => '',
  getSelectedGalleryImage: () => null,
  getSelectedGalleryImageFromValues: () => null,
  useDeletionConfirmation: () => ({
    dialog: null,
    requestDeletionConfirmation: (_itemRefs: unknown, executeDeletion: () => Promise<void>) => executeDeletion(),
  }),
  useImageActions: (options: typeof mocks.imageActionOptions) => {
    mocks.imageActionOptions = options;
    return {};
  },
}));

vi.mock('@features/generation/react', () => ({
  GenerationUiProvider: ({ children }: { children?: unknown }) => children,
  adjustFocusedPromptAttention: () => {},
  createGenerateFormValuesSelector: () => () => ({}),
  flushGenerateDrafts: () => {},
  focusPositivePrompt: () => {},
  promptHistoryNavigation: {},
  useDebouncedDraftValue: () => ({}),
  useRegisterGenerateDraftFlusher: () => {},
}));

import { PreviewWidgetView } from './PreviewWidgetView';

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  lng: 'en',
  resources: {
    en: {
      translation: {
        common: { countOfTotal: '{{count}} of {{total}}' },
        widgets: {
          preview: {
            framesPerSecond: '{{count}} fps',
            itemCount_one: '{{count}} item',
            itemCount_other: '{{count}} items',
            nextItemInBoard: 'Next item in board',
            previousItemInBoard: 'Previous item in board',
            videoDuration: 'Duration {{duration}}',
          },
        },
      },
    },
  },
});

const registeredCommands = new Map<string, () => void>();
const registeredHotkeys = new Map<string, readonly string[]>();
const runtime = {
  commands: {
    register: ({ handler, id }: { handler: () => void; id: string }) => {
      registeredCommands.set(id, handler);
      return () => {
        if (registeredCommands.get(id) === handler) {
          registeredCommands.delete(id);
        }
      };
    },
  },
  hotkeys: {
    register: ({ defaultKeys, id }: { defaultKeys: readonly string[]; id: string }) => {
      registeredHotkeys.set(id, defaultKeys);
      return () => {
        if (registeredHotkeys.get(id) === defaultKeys) {
          registeredHotkeys.delete(id);
        }
      };
    },
  },
  instanceId: 'preview-instance',
  workbench: { closeWidgetInstance: () => {} },
} as unknown as WidgetViewProps['runtime'];
const manifest = { id: 'preview', label: 'Preview' } as unknown as WidgetViewProps['manifest'];
const instance = { id: 'preview-instance', typeId: 'preview' } as unknown as WidgetViewProps['instance'];

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderTree = async (client: QueryClient) => {
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <ChakraProvider value={system}>
          <QueryClientProvider client={client}>
            <DndContext>
              <PreviewWidgetView instance={instance} manifest={manifest} region="center" runtime={runtime} />
            </DndContext>
          </QueryClientProvider>
        </ChakraProvider>
      </I18nextProvider>
    );
    await Promise.resolve();
  });
};

const render = async () => {
  host = document.createElement('div');
  host.style.cssText = 'height:320px;width:480px;';
  document.body.append(host);
  root = createRoot(host);

  const client = new QueryClient();

  queryClient = client;
  await renderTree(client);
};

// Re-renders the mounted tree against the SAME query client, so cached pages
// survive exactly as they do in production and a window change has to earn
// its data. Widget values are read by identity, so callers hand the view a
// fresh values object rather than mutating in place.
const rerender = async () => {
  if (!queryClient) {
    throw new Error('Expected render() to have created a query client.');
  }

  await renderTree(queryClient);
};

const setGalleryValues = (patch: Record<string, unknown>) => {
  const state = mocks.project.widgetInstances.gallery.state as { values: Record<string, unknown> };

  state.values = { ...state.values, ...patch };
};

// Applies Preview's most recent selection to the gallery values the way the
// real reducer would — item, key, and the stamped page — and re-renders. The
// selection command is a mock, so without this a second arrow press would
// still start from the item the first one left.
const commitLastSelection = async () => {
  const lastCall = mocks.commands.gallery.selectItem.mock.lastCall as
    | [GalleryImageItem, unknown, number | undefined, boolean | undefined]
    | undefined;

  if (!lastCall) {
    throw new Error('Expected a selection to commit.');
  }

  const [item, , selectionPage] = lastCall;
  const state = mocks.project.widgetInstances.gallery.state as { values: Record<string, unknown> };
  const selectedImageQuery = (state.values.selectedImageQuery ?? {}) as Record<string, unknown>;

  setGalleryValues({
    selectedImage: {
      boardId: item.boardId,
      height: item.height,
      imageName: item.name,
      imageUrl: item.fullUrl,
      queuedAt: item.createdAt,
      sourceQueueItemId: item.sourceQueueItemId,
      thumbnailUrl: item.thumbnailUrl,
      width: item.width,
    },
    selectedImageName: item.name,
    selectedImageQuery: { ...selectedImageQuery, page: selectionPage ?? selectedImageQuery.page },
  });
  await rerender();
};

const deepQuery = {
  boardId: 'none',
  galleryView: 'images',
  imageOrderDir: 'DESC',
  page: 30,
  paginationMode: 'infinite',
  searchTerm: '',
};

const legacyImage = (name: string, queuedAt: string, sourceQueueItemId = `queue-${name}`) => ({
  boardId: 'none',
  height: 64,
  imageName: name,
  imageUrl: `/images/${name}/full`,
  queuedAt,
  sourceQueueItemId,
  thumbnailUrl: `/images/${name}/thumbnail`,
  width: 64,
});

// A board whose page 30 holds `deep` (newest first) and whose page 31 holds
// `next`; every other page is empty. Enough to anchor a window at row 1800
// and to have a boundary to cross.
const deepBoardPages = (deep: GalleryImageItem[], next: GalleryImageItem[] = []) =>
  Array.from({ length: 32 }, (_unused, index) => {
    if (index === 30) {
      return { items: deep, total: deep.length + next.length };
    }

    return index === 31
      ? { items: next, total: deep.length + next.length }
      : { items: [], total: deep.length + next.length };
  });

const getBoundary = (): HTMLElement => {
  const boundary = host?.querySelector<HTMLElement>('[tabindex="0"]');

  if (!boundary) {
    throw new Error('Expected the preview keyboard boundary to be rendered.');
  }

  return boundary;
};

const pressArrow = async (key: 'ArrowLeft' | 'ArrowRight') => {
  await act(async () => {
    getBoundary().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
    await Promise.resolve();
  });
};

beforeEach(() => {
  registeredCommands.clear();
  registeredHotkeys.clear();
  mocks.commands.account.updateProjectPreferences.mockClear();
  mocks.commands.gallery.selectImage.mockClear();
  mocks.commands.gallery.selectItem.mockClear();
  mocks.project.queue.items = [];
  mocks.project.settings.showProgressImagesInViewer = false;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).compareImage;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).galleryPage;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).imageOrderDir;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).paginationMode;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).semanticImageQuery;
  delete (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).selectedImageQuery;
  mocks.project.widgetInstances.gallery.state.values.recentImages = mocks.recentImages;
  mocks.project.widgetInstances.gallery.state.values.selectedImage = {
    ...mocks.recentImages[0],
    boardId: 'none',
  };
  mocks.project.widgetInstances.gallery.state.values.selectedImageName = 'newest';
  mocks.galleryItemPageOffsets.length = 0;
  mocks.galleryItemWindowOffsets.length = 0;
  mocks.imageActionOptions = null;
  mocks.galleryItemPages = [
    {
      items: mocks.recentImages.map((image) => ({
        boardId: 'none',
        category: 'general' as const,
        createdAt: image.queuedAt,
        fullUrl: image.imageUrl,
        height: image.height,
        isIntermediate: false,
        kind: 'image' as const,
        name: image.imageName,
        sourceQueueItemId: image.sourceQueueItemId,
        starred: false,
        thumbnailUrl: image.thumbnailUrl,
        width: image.width,
      })),
      total: mocks.recentImages.length,
    },
  ];
  mocks.useActiveProgressTarget.mockReturnValue(null);
  mocks.useProgressImage.mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  host?.remove();
  host = null;
  root = null;
});

describe('preview keyboard navigation boundary', () => {
  it('handles one arrow press as exactly one selection and stops propagation', async () => {
    const documentKeydown = vi.fn();
    document.addEventListener('keydown', documentKeydown);

    try {
      await render();
      await pressArrow('ArrowRight');

      expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
      expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'image', name: 'oldest' }),
        undefined,
        expect.any(Number),
        true
      );
      expect(documentKeydown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', documentKeydown);
    }
  });

  it('keeps a just-completed batch navigable before the backend refetch lands', async () => {
    // The batch finished and its queue item is already gone; the backend list
    // (staleTime + coalesced invalidation) still only has the older image.
    // recentImages is the bridge: every batch image must stay in the sequence,
    // or ArrowRight from the newest skips the whole batch onto old images.
    mocks.project.queue.items = [];
    mocks.project.widgetInstances.gallery.state.values.recentImages = [
      {
        height: 64,
        imageName: 'batch-2',
        imageUrl: '/images/batch-2/full',
        queuedAt: '2026-07-22T00:00:02.000Z',
        sourceQueueItemId: 'queue-item-done',
        thumbnailUrl: '/images/batch-2/thumbnail',
        width: 64,
      },
      {
        height: 64,
        imageName: 'batch-1',
        imageUrl: '/images/batch-1/full',
        queuedAt: '2026-07-22T00:00:01.000Z',
        sourceQueueItemId: 'queue-item-done',
        thumbnailUrl: '/images/batch-1/thumbnail',
        width: 64,
      },
    ];
    mocks.project.widgetInstances.gallery.state.values.selectedImage = {
      boardId: 'none',
      height: 64,
      imageName: 'batch-2',
      imageUrl: '/images/batch-2/full',
      queuedAt: '2026-07-22T00:00:02.000Z',
      sourceQueueItemId: 'queue-item-done',
      thumbnailUrl: '/images/batch-2/thumbnail',
      width: 64,
    };
    mocks.project.widgetInstances.gallery.state.values.selectedImageName = 'batch-2';
    mocks.galleryItemPages = [{ items: [createImageItem('pre-batch', '2026-07-20T00:00:00.000Z')], total: 1 }];

    await render();
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'batch-1' }),
      undefined,
      expect.any(Number),
      true
    );
  });

  it('keeps settled recents out of an infinite window anchored at a deep reveal', async () => {
    // A deep reveal anchors Preview's window ~1800 rows down the board. Recents
    // belong at the TOP of the listing: date-sorting them into a slice from
    // the middle puts images in Preview that the grid is not showing, and
    // stepping onto one files it under a board page it is nowhere near.
    const deepNewer = createImageItem('deep-newer', '2026-07-20T00:00:02.000Z');
    const deepOlder = createImageItem('deep-older', '2026-07-20T00:00:01.000Z');

    setGalleryValues({
      galleryPage: 0,
      recentImages: [legacyImage('fresh-generation', '2026-07-23T00:00:00.000Z', 'queue-item-done')],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([deepNewer, deepOlder]);

    await render();
    // Descending: Right steps deeper into the anchored slice...
    await pressArrow('ArrowRight');
    // ...and Left, off the top of it, must not find the recent above it.
    await pressArrow('ArrowLeft');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'deep-older' }),
      undefined,
      30,
      true
    );
  });

  it('keeps recents out of a deep window whose stamp outlives a switch to paginated mode', async () => {
    // The live setting says paginated while the stamp still describes the deep
    // infinite window Preview is querying. The window is what the list is made
    // of, so it is what the exclusion follows.
    const deepNewer = createImageItem('deep-newer', '2026-07-20T00:00:02.000Z');
    const deepOlder = createImageItem('deep-older', '2026-07-20T00:00:01.000Z');

    setGalleryValues({
      galleryPage: 0,
      paginationMode: 'paginated',
      recentImages: [legacyImage('fresh-generation', '2026-07-23T00:00:00.000Z', 'queue-item-done')],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([deepNewer, deepOlder]);

    await render();
    await pressArrow('ArrowRight');
    await pressArrow('ArrowLeft');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'deep-older' }),
      undefined,
      30,
      true
    );
  });

  it('stamps the top of the listing on an in-flight image a deep window does not hold', async () => {
    // In-flight work still merges into a deep window, and the window has no
    // page for it. The page the preview opened on is 30 board pages from
    // where the image will land, so it must not be what gets stamped.
    mocks.project.queue.items = [queueItem];
    setGalleryValues({
      galleryPage: 0,
      recentImages: [legacyImage('in-flight', '2026-07-23T00:00:00.000Z', 'queue-item-live')],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);

    await render();
    await pressArrow('ArrowLeft');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'in-flight' }),
      undefined,
      0,
      true
    );
  });

  it('stamps the top of the listing when the compare image is swapped in', async () => {
    // The compare slot holds an arbitrary image the window may not contain.
    // Reusing the deep page filed a top-of-board image under row 1800, and
    // Preview then queried a slice its own selection was not in.
    setGalleryValues({
      compareImage: legacyImage('compare-top', '2026-07-24T00:00:00.000Z'),
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);

    await render();

    const swap = registeredCommands.get('viewer.swapImages');

    expect(swap).toBeDefined();
    await act(async () => {
      swap?.();
      await Promise.resolve();
    });

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'compare-top' }),
      undefined,
      0,
      true
    );
  });

  it('holds a deep window still while the cursor walks across a page boundary and back', async () => {
    // An anchored infinite window is one-way: it cannot grow upward past its
    // anchor. So the anchor must stay where the selection was made, and every
    // step — including one that lands on a page the boundary fetch has just
    // added — stamps THAT anchor, not the row it landed on. Stamping the row
    // re-keys the window at each boundary, discards the old entry, and makes
    // everything the user just walked through unreachable.
    const deepA = createImageItem('deep-a', '2026-07-20T00:00:04.000Z');
    const deepB = createImageItem('deep-b', '2026-07-20T00:00:03.000Z');
    const deepC = createImageItem('deep-c', '2026-07-20T00:00:02.000Z');
    const deepD = createImageItem('deep-d', '2026-07-20T00:00:01.000Z');

    setGalleryValues({
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-b', '2026-07-20T00:00:03.000Z'),
      selectedImageName: 'deep-b',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([deepA, deepB], [deepC, deepD]);

    await render();
    // Across the boundary: the fetch adds page 31, and the item selected out
    // of it is still stamped with the window's anchor.
    await pressArrow('ArrowRight');
    await commitLastSelection();
    // One more step inside the new page.
    await pressArrow('ArrowRight');
    await commitLastSelection();
    // And back, twice: the second press crosses the boundary in the direction
    // the window cannot grow, and must find page 30 still loaded.
    await pressArrow('ArrowLeft');
    await commitLastSelection();
    await pressArrow('ArrowLeft');

    const selected = mocks.commands.gallery.selectItem.mock.calls.map(([item, , page]) => [
      (item as { name: string }).name,
      page,
    ]);

    expect(selected).toEqual([
      ['deep-c', 30],
      ['deep-d', 30],
      ['deep-c', 30],
      ['deep-b', 30],
    ]);
    expect(mocks.galleryItemWindowOffsets).not.toContain(1860);
    expect(mocks.galleryItemWindowOffsets).not.toContain(0);
  });

  it('moves to the top of the listing when a selection is made there from outside Preview', async () => {
    // Board, view, order, mode and search are unchanged, so the query identity
    // is the same. A grid click on the newest image stamps the grid's page, 0,
    // and Preview must follow it — held sticky, the anchor kept querying rows
    // 1800+ for a selection at row 0.
    const topNewer = createImageItem('top-newer', '2026-07-22T00:00:02.000Z');
    const topOlder = createImageItem('top-older', '2026-07-22T00:00:01.000Z');

    setGalleryValues({
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);
    mocks.galleryItemPages[0] = { items: [topNewer, topOlder], total: 3 };

    await render();

    expect(mocks.galleryItemWindowOffsets).toContain(1800);

    mocks.galleryItemWindowOffsets.length = 0;
    setGalleryValues({
      selectedImage: legacyImage('top-newer', '2026-07-22T00:00:02.000Z'),
      selectedImageName: 'top-newer',
      selectedImageQuery: { ...deepQuery, page: 0 },
    });
    await rerender();
    await pressArrow('ArrowRight');

    expect(mocks.galleryItemWindowOffsets).not.toContain(1800);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'top-older' }),
      undefined,
      0,
      true
    );
  });

  it('hands image actions a page that keeps a deletion successor in the deep window', async () => {
    // A successor is chosen from Preview's own list. Selected without a page
    // it is stamped with the GRID's page — 0 once a result has landed on the
    // board or the project was reloaded — and lands outside the window it
    // came from: forward arrow dead, back arrow a 1800-row teleport.
    const deepNewer = createImageItem('deep-newer', '2026-07-20T00:00:02.000Z');
    const deepOlder = createImageItem('deep-older', '2026-07-20T00:00:01.000Z');

    setGalleryValues({
      galleryPage: 0,
      recentImages: [legacyImage('fresh-generation', '2026-07-23T00:00:00.000Z', 'queue-item-done')],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([deepNewer, deepOlder]);

    await render();

    const context = mocks.imageActionOptions?.getItemActionContext?.();

    expect(context?.getItemSelectionPage?.(deepOlder)).toBe(30);
    // A recent is not in the window; it lives at the top of the listing.
    expect(context?.getItemSelectionPage?.(createImageItem('fresh-generation', '2026-07-23T00:00:00.000Z'))).toBe(0);
  });

  it('swaps the compare image in and back out without losing the deep window', async () => {
    // Swapping a top-of-board image in moves the window to the top, and the
    // deep image goes into the compare slot. Swapping back must return to the
    // window that image was navigated in, not guess at one.
    setGalleryValues({
      compareImage: legacyImage('compare-top', '2026-07-24T00:00:00.000Z'),
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);
    mocks.galleryItemPages[0] = { items: [createImageItem('compare-top', '2026-07-24T00:00:00.000Z')], total: 2 };

    await render();

    const swap = () =>
      act(async () => {
        registeredCommands.get('viewer.swapImages')?.();
        await Promise.resolve();
      });

    await swap();

    expect(mocks.commands.gallery.selectItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'image', name: 'compare-top' }),
      undefined,
      0,
      true
    );

    // Commit the swap as the reducer would: the top image is selected at page
    // 0, and the deep image is now in the compare slot.
    await commitLastSelection();
    setGalleryValues({ compareImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z') });
    await rerender();
    await swap();

    expect(mocks.commands.gallery.selectItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'image', name: 'deep-newer' }),
      undefined,
      30,
      true
    );
  });

  it('does not restore a remembered page into a different listing', async () => {
    // Between the swap and the swap back the user moved to another board.
    // The remembered page named a window of the first board's listing;
    // stamped into the second board's query it would anchor that listing
    // 1800 rows down around an image that is not in it.
    setGalleryValues({
      compareImage: legacyImage('compare-top', '2026-07-24T00:00:00.000Z'),
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);
    mocks.galleryItemPages[0] = { items: [createImageItem('compare-top', '2026-07-24T00:00:00.000Z')], total: 2 };

    await render();

    const swap = () =>
      act(async () => {
        registeredCommands.get('viewer.swapImages')?.();
        await Promise.resolve();
      });

    await swap();
    await commitLastSelection();
    // The grid: another board, a click on one of its images. The compare slot
    // survives that, still holding the deep image from the first board.
    setGalleryValues({
      compareImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImage: { ...legacyImage('other-board-image', '2026-07-25T00:00:00.000Z'), boardId: 'board-b' },
      selectedImageName: 'other-board-image',
      selectedImageQuery: { ...deepQuery, boardId: 'board-b', page: 0 },
    });
    await rerender();
    await swap();

    expect(mocks.commands.gallery.selectItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'image', name: 'deep-newer' }),
      undefined,
      0,
      true
    );
  });

  it('only restores a remembered page for the item it was remembered for', async () => {
    setGalleryValues({
      compareImage: legacyImage('compare-top', '2026-07-24T00:00:00.000Z'),
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);
    mocks.galleryItemPages[0] = { items: [createImageItem('compare-top', '2026-07-24T00:00:00.000Z')], total: 2 };

    await render();

    const swap = () =>
      act(async () => {
        registeredCommands.get('viewer.swapImages')?.();
        await Promise.resolve();
      });

    await swap();
    await commitLastSelection();
    // A different image lands in the compare slot before the swap back.
    setGalleryValues({ compareImage: legacyImage('another-top', '2026-07-24T00:00:01.000Z') });
    await rerender();
    await swap();

    expect(mocks.commands.gallery.selectItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'image', name: 'another-top' }),
      undefined,
      0,
      true
    );
  });

  it('hands image actions the window anchor for an item on a later page of the window', async () => {
    // The stamp is the anchor of the window holding the item, not the page
    // the item happens to sit on: a successor from page 31 of a window
    // anchored at page 30 is stamped 30.
    const deepA = createImageItem('deep-a', '2026-07-20T00:00:04.000Z');
    const deepB = createImageItem('deep-b', '2026-07-20T00:00:03.000Z');
    const deepC = createImageItem('deep-c', '2026-07-20T00:00:02.000Z');

    setGalleryValues({
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-b', '2026-07-20T00:00:03.000Z'),
      selectedImageName: 'deep-b',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([deepA, deepB], [deepC]);

    await render();
    // Cross the boundary so page 31 is part of the window.
    await pressArrow('ArrowRight');
    await commitLastSelection();

    const context = mocks.imageActionOptions?.getItemActionContext?.();

    expect(context?.items.map((item) => item.name)).toContain('deep-c');
    expect(context?.getItemSelectionPage?.(deepC)).toBe(30);
  });

  it('does not restore a remembered page for an item since moved to another board', async () => {
    // Moving the compare image re-boards it in place and leaves the selection's
    // query alone, so the memo's key still matches. The page it remembers is a
    // window of the OLD board's listing, which the item is no longer in.
    setGalleryValues({
      compareImage: legacyImage('compare-top', '2026-07-24T00:00:00.000Z'),
      galleryPage: 0,
      recentImages: [],
      selectedImage: legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'),
      selectedImageName: 'deep-newer',
      selectedImageQuery: deepQuery,
    });
    mocks.galleryItemPages = deepBoardPages([createImageItem('deep-newer', '2026-07-20T00:00:02.000Z')]);
    mocks.galleryItemPages[0] = { items: [createImageItem('compare-top', '2026-07-24T00:00:00.000Z')], total: 2 };

    await render();

    const swap = () =>
      act(async () => {
        registeredCommands.get('viewer.swapImages')?.();
        await Promise.resolve();
      });

    await swap();
    await commitLastSelection();
    // The deep image, now in the compare slot, is moved to another board.
    setGalleryValues({
      compareImage: { ...legacyImage('deep-newer', '2026-07-20T00:00:02.000Z'), boardId: 'board-b' },
    });
    await rerender();
    await swap();

    expect(mocks.commands.gallery.selectItem).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'image', name: 'deep-newer', boardId: 'board-b' }),
      undefined,
      0,
      true
    );
  });

  it('fetches the next infinite page before stepping past the loaded backend boundary', async () => {
    const newest: GalleryImage = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general',
      starred: false,
    };
    const oldest: GalleryImage = {
      ...mocks.recentImages[1],
      boardId: 'none',
      imageCategory: 'general',
      starred: false,
    };
    mocks.project.widgetInstances.gallery.state.values.recentImages = [mocks.recentImages[0]];
    mocks.galleryItemPages = [
      {
        items: [
          {
            boardId: newest.boardId,
            category: newest.imageCategory,
            createdAt: newest.queuedAt,
            fullUrl: newest.imageUrl,
            height: newest.height,
            isIntermediate: false,
            kind: 'image',
            name: newest.imageName,
            sourceQueueItemId: newest.sourceQueueItemId,
            starred: newest.starred,
            thumbnailUrl: newest.thumbnailUrl,
            width: newest.width,
          },
        ],
        total: 2,
      },
      {
        items: [
          {
            boardId: oldest.boardId,
            category: oldest.imageCategory,
            createdAt: oldest.queuedAt,
            fullUrl: oldest.imageUrl,
            height: oldest.height,
            isIntermediate: false,
            kind: 'image',
            name: oldest.imageName,
            sourceQueueItemId: oldest.sourceQueueItemId,
            starred: oldest.starred,
            thumbnailUrl: oldest.thumbnailUrl,
            width: oldest.width,
          },
        ],
        total: 2,
      },
    ];

    await render();
    await pressArrow('ArrowRight');

    await vi.waitFor(() => {
      expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'image', name: 'oldest' }),
        undefined,
        expect.any(Number),
        true
      );
    });
    expect(mocks.galleryItemPageOffsets).toEqual([60]);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
  });

  it('anchors Preview navigation to the selected paginated Gallery page', async () => {
    const pageZero = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'page-zero',
      starred: false,
    };
    const selected = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'page-one-selected',
      starred: false,
    };
    const neighbor = {
      ...mocks.recentImages[1],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'page-one-neighbor',
      starred: false,
    };
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;

    galleryValues.galleryPage = 1;
    galleryValues.paginationMode = 'paginated';
    galleryValues.recentImages = [];
    galleryValues.selectedImage = selected;
    galleryValues.selectedImageName = selected.imageName;
    mocks.galleryItemPages = [
      {
        items: [pageZero].map((image) => ({
          boardId: image.boardId,
          category: image.imageCategory,
          createdAt: image.queuedAt,
          fullUrl: image.imageUrl,
          height: image.height,
          isIntermediate: false,
          kind: 'image' as const,
          name: image.imageName,
          sourceQueueItemId: image.sourceQueueItemId,
          starred: image.starred,
          thumbnailUrl: image.thumbnailUrl,
          width: image.width,
        })),
        total: 3,
      },
      {
        items: [selected, neighbor].map((image) => ({
          boardId: image.boardId,
          category: image.imageCategory,
          createdAt: image.queuedAt,
          fullUrl: image.imageUrl,
          height: image.height,
          isIntermediate: false,
          kind: 'image' as const,
          name: image.imageName,
          sourceQueueItemId: image.sourceQueueItemId,
          starred: image.starred,
          thumbnailUrl: image.thumbnailUrl,
          width: image.width,
        })),
        total: 3,
      },
    ];

    await render();
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: neighbor.imageName }),
      undefined,
      1,
      true
    );
  });

  it('does not carry the page the preview opened on onto a ranked pick', async () => {
    const selected = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'ranked-selected',
      starred: false,
    };
    const neighbor = {
      ...mocks.recentImages[1],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'ranked-neighbor',
      starred: false,
    };
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;

    // A deep reveal from the image map stamped board page 30 onto the
    // selection; starting the similarity search reset the grid to page 0.
    // Carrying that stale page onto a ranked pick strands it: the item picked
    // out of a ranking is nowhere near board page 30, so clearing the chip
    // would anchor navigation ~1800 rows from both the selection and the grid.
    galleryValues.galleryPage = 0;
    galleryValues.paginationMode = 'infinite';
    galleryValues.recentImages = [];
    galleryValues.semanticImageQuery = { kind: 'text', query: 'sunset' };
    galleryValues.selectedImage = selected;
    galleryValues.selectedImageName = selected.imageName;
    galleryValues.selectedImageQuery = {
      boardId: 'none',
      galleryView: 'images',
      imageOrderDir: 'DESC',
      page: 30,
      paginationMode: 'infinite',
      searchTerm: '',
    };
    mocks.galleryItemPages = [
      {
        items: [selected, neighbor].map((image) => ({
          boardId: image.boardId,
          category: image.imageCategory,
          createdAt: image.queuedAt,
          fullUrl: image.imageUrl,
          height: image.height,
          isIntermediate: false,
          kind: 'image' as const,
          name: image.imageName,
          sourceQueueItemId: image.sourceQueueItemId,
          starred: image.starred,
          thumbnailUrl: image.thumbnailUrl,
          width: image.width,
        })),
        total: 2,
      },
    ];

    await render();
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: neighbor.imageName }),
      undefined,
      0,
      true
    );
  });

  it('stamps the top of the board listing for a ranked pick even when the footer paginates the ranking', async () => {
    const filler = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'ranked-page-zero',
      starred: false,
    };
    const selected = {
      ...mocks.recentImages[0],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'ranked-page-one-selected',
      starred: false,
    };
    const neighbor = {
      ...mocks.recentImages[1],
      boardId: 'none',
      imageCategory: 'general' as const,
      imageName: 'ranked-page-one-neighbor',
      starred: false,
    };
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;
    const toItem = (image: typeof filler) => ({
      boardId: image.boardId,
      category: image.imageCategory,
      createdAt: image.queuedAt,
      fullUrl: image.imageUrl,
      height: image.height,
      isIntermediate: false,
      kind: 'image' as const,
      name: image.imageName,
      sourceQueueItemId: image.sourceQueueItemId,
      starred: image.starred,
      thumbnailUrl: image.thumbnailUrl,
      width: image.width,
    });

    // In paginated mode the footer paginates the RANKING, so the grid's page
    // is a rank page, not a board page — stamping it would send navigation to
    // an unrelated board slice once the chip is cleared. Clearing resets the
    // grid to board page 0, so that is what a ranked pick hands back: neither
    // the grid's 1 nor the stale 30.
    galleryValues.galleryPage = 1;
    galleryValues.paginationMode = 'paginated';
    galleryValues.recentImages = [];
    galleryValues.semanticImageQuery = { kind: 'text', query: 'sunset' };
    galleryValues.selectedImage = selected;
    galleryValues.selectedImageName = selected.imageName;
    galleryValues.selectedImageQuery = {
      boardId: 'none',
      galleryView: 'images',
      imageOrderDir: 'DESC',
      page: 30,
      paginationMode: 'paginated',
      searchTerm: '',
    };
    mocks.galleryItemPages = [
      { items: [filler].map(toItem), total: 3 },
      { items: [selected, neighbor].map(toItem), total: 3 },
    ];

    await render();
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: neighbor.imageName }),
      undefined,
      0,
      true
    );
  });

  it('enables live-follow when stepping onto the active placeholder', async () => {
    mocks.project.queue.items = [queueItem];
    mocks.useActiveProgressTarget.mockReturnValue({ itemIndex: 1, queueItemId: 'queue-item-live' });
    mocks.useProgressImage.mockReturnValue({
      dataUrl: 'data:image/png;base64,',
      height: 64,
      target: { itemIndex: 1, queueItemId: 'queue-item-live' },
      width: 64,
    });

    await render();
    // Descending order: the live placeholder occupies the newest position, so
    // ArrowLeft from the newest image steps onto it.
    await pressArrow('ArrowLeft');

    expect(mocks.commands.account.updateProjectPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.commands.account.updateProjectPreferences).toHaveBeenCalledWith({
      showProgressImagesInViewer: true,
    });
    expect(mocks.commands.gallery.selectItem).not.toHaveBeenCalled();
  });

  it('keeps arrow navigation working while following live', async () => {
    mocks.project.queue.items = [{ ...queueItem, backendItemIds: [1, 2, 3], completedBackendItemIds: [1, 2] }];
    mocks.project.settings.showProgressImagesInViewer = true;
    mocks.project.widgetInstances.gallery.state.values.recentImages = mocks.recentImages.map((image) => ({
      ...image,
      sourceQueueItemId: 'queue-item-live',
    }));
    mocks.useActiveProgressTarget.mockReturnValue({ itemIndex: 3, queueItemId: 'queue-item-live' });
    mocks.useProgressImage.mockReturnValue({
      dataUrl: 'data:image/png;base64,',
      height: 64,
      target: { itemIndex: 3, queueItemId: 'queue-item-live' },
      width: 64,
    });

    await render();
    // While following live the cursor sits on the placeholder; ArrowRight
    // steps back onto the newest completed image.
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledTimes(1);
    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'newest' }),
      undefined,
      expect.any(Number),
      true
    );
  });

  it('renders the live frame with the standard media chrome: footer up, no badge, item border', async () => {
    mocks.project.queue.items = [queueItem];
    mocks.project.settings.showProgressImagesInViewer = true;
    mocks.useActiveProgressTarget.mockReturnValue({ itemIndex: 1, queueItemId: 'queue-item-live' });
    mocks.useProgressImage.mockReturnValue({
      dataUrl: 'data:image/png;base64,',
      height: 64,
      target: { itemIndex: 1, queueItemId: 'queue-item-live' },
      width: 64,
    });

    await render();

    // The footer island is up during the live render, fed by queue data: the
    // slot's requested output size, and working prev/next.
    expect(host?.textContent).toContain('64 × 64');
    expect(host?.querySelector('button[aria-label="Next item in board"]')).not.toBeNull();
    // No progress badge over the frame — the image is styled exactly like a
    // finished item, so completion changes pixels, not chrome.
    expect(host?.textContent).not.toContain('Generating');
    expect(host?.querySelector<HTMLImageElement>('img[src^="data:image/png"]')).not.toBeNull();
  });

  it('uses the active placeholder board while following live, even before an image frame arrives', async () => {
    const liveBoardImage = {
      ...mocks.project.widgetInstances.gallery.state.values.recentImages[0],
      boardId: 'board-live',
      imageName: 'live-board-image',
      imageUrl: '/images/live-board-image/full',
      sourceQueueItemId: 'queue-item-live',
      starred: false,
      thumbnailUrl: '/images/live-board-image/thumbnail',
    };
    mocks.project.widgetInstances.gallery.state.values.recentImages = [...mocks.recentImages, liveBoardImage];
    mocks.project.queue.items = [{ ...queueItem, snapshot: { ...queueItem.snapshot, galleryBoardId: 'board-live' } }];
    mocks.project.settings.showProgressImagesInViewer = true;
    mocks.useActiveProgressTarget.mockReturnValue({ itemIndex: 1, queueItemId: 'queue-item-live' });

    await render();
    await pressArrow('ArrowRight');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: 'board-live', kind: 'image', name: 'live-board-image' }),
      undefined,
      expect.any(Number),
      true
    );
  });

  it('orders local images oldest-first when the gallery is ascending', async () => {
    (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).imageOrderDir = 'ASC';

    await render();
    await pressArrow('ArrowLeft');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'image', name: 'oldest' }),
      undefined,
      expect.any(Number),
      true
    );
  });

  it('does not consume arrow keys in comparison mode', async () => {
    (mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>).compareImage = {
      ...mocks.project.widgetInstances.gallery.state.values.recentImages[1],
    };
    const documentKeydown = vi.fn();
    document.addEventListener('keydown', documentKeydown);

    try {
      await render();
      await pressArrow('ArrowRight');

      expect(mocks.commands.gallery.selectItem).not.toHaveBeenCalled();
      expect(documentKeydown).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', documentKeydown);
    }
  });

  it('renders and navigates same-name image and video items independently in server order', async () => {
    const sameNameImage = createImageItem('shared', '2026-07-30T13:00:00Z');
    const sameNameVideo = createVideoItem('shared', '2026-07-30T12:00:00Z');
    const oldestImage = createImageItem('oldest-mixed', '2026-07-30T11:00:00Z');
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;

    galleryValues.compareImage = {
      ...mocks.recentImages[0],
      imageName: 'comparison.png',
    };
    galleryValues.recentImages = [];
    galleryValues.selectedImage = sameNameVideo;
    galleryValues.selectedImageName = 'video:shared';
    mocks.galleryItemPages = [{ items: [sameNameImage, sameNameVideo, oldestImage], total: 3 }];

    await render();

    const video = host?.querySelector<HTMLVideoElement>('video');
    const filmstripPosters = host?.querySelectorAll<HTMLImageElement>('button img');

    expect(video?.getAttribute('src')).toBe(sameNameVideo.fullUrl);
    expect(video?.getAttribute('poster')).toBe(sameNameVideo.thumbnailUrl);
    expect(filmstripPosters).toHaveLength(3);
    expect(host?.textContent).toContain('2 of 3');
    expect(host?.textContent).toContain('1920 × 1080');
    expect(host?.textContent).toContain('Duration 1:06');
    expect(host?.textContent).toContain('23.976 fps');
    expect(host?.textContent).not.toContain('Drop to compare');

    await pressArrow('ArrowLeft');

    expect(mocks.commands.gallery.selectItem).toHaveBeenCalledWith(sameNameImage, undefined, 0, true);
  });

  it('leaves native video keys untouched and omits image-only hotkey registrations', async () => {
    const videoItem = createVideoItem('native-controls', '2026-07-30T12:00:00Z');
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;

    galleryValues.recentImages = [];
    galleryValues.selectedImage = videoItem;
    galleryValues.selectedImageName = 'video:native-controls';
    mocks.galleryItemPages = [{ items: [videoItem], total: 1 }];

    await render();

    const video = host?.querySelector<HTMLVideoElement>('video');
    expect(video).not.toBeNull();

    for (const key of ['ArrowLeft', 'ArrowRight', 'f', '1']) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
      await act(async () => {
        video?.dispatchEvent(event);
        await Promise.resolve();
      });
      expect(event.defaultPrevented).toBe(false);
    }

    expect(mocks.commands.gallery.selectItem).not.toHaveBeenCalled();
    expect([...registeredHotkeys.keys()]).not.toContain('viewer.swapImages');
    expect([...registeredHotkeys.keys()]).not.toContain('viewer.zoomToActual');
    expect([...registeredHotkeys.keys()]).not.toContain('viewer.zoomToFit');
  });

  it('retains compare and zoom hotkey registrations for images', async () => {
    await render();

    expect([...registeredHotkeys.keys()]).toEqual(
      expect.arrayContaining(['viewer.swapImages', 'viewer.zoomToActual', 'viewer.zoomToFit'])
    );
    expect([...registeredCommands.keys()]).toEqual(
      expect.arrayContaining(['viewer.swapImages', 'viewer.zoomToActual', 'viewer.zoomToFit'])
    );
  });

  it('uses the common mixed deletion context without the legacy image successor callback', async () => {
    const sameNameImage = createImageItem('shared', '2026-07-30T13:00:00Z');
    const sameNameVideo = createVideoItem('shared', '2026-07-30T12:00:00Z');
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;

    galleryValues.recentImages = [];
    galleryValues.selectedImage = sameNameVideo;
    galleryValues.selectedImageName = 'video:shared';
    mocks.galleryItemPages = [{ items: [sameNameImage, sameNameVideo], total: 2 }];

    await render();

    expect(mocks.imageActionOptions?.onImagesDeleted).toBeUndefined();
    const context = mocks.imageActionOptions?.getItemActionContext?.();
    expect(context?.selectedItemKey).toBe('video:shared');
    expect(context?.items).toEqual([sameNameImage, sameNameVideo]);
    await expect(context?.loadOrderedRefs(new AbortController().signal)).resolves.toEqual([
      { kind: 'image', name: 'shared' },
      { kind: 'video', name: 'shared' },
    ]);
  });

  it('prefetches an image neighbor but never assigns a full video URL to Image', async () => {
    const previousImage = createImageItem('prefetch-previous', '2026-07-30T13:00:00Z');
    const selectedImage = createImageItem('prefetch-selected', '2026-07-30T12:00:00Z');
    const nextVideo = createVideoItem('prefetch-next', '2026-07-30T11:00:00Z');
    const galleryValues = mocks.project.widgetInstances.gallery.state.values as Record<string, unknown>;
    const preloadedSources: string[] = [];
    const NativeImage = globalThis.Image;

    class PreloadImage {
      set src(value: string) {
        preloadedSources.push(value);
      }
    }

    Object.defineProperty(globalThis, 'Image', { configurable: true, value: PreloadImage, writable: true });

    try {
      galleryValues.recentImages = [];
      galleryValues.selectedImage = selectedImage;
      galleryValues.selectedImageName = 'image:prefetch-selected';
      mocks.galleryItemPages = [{ items: [previousImage, selectedImage, nextVideo], total: 3 }];

      await render();

      expect(preloadedSources).toContain(previousImage.fullUrl);
      expect(preloadedSources).not.toContain(nextVideo.fullUrl);
    } finally {
      Object.defineProperty(globalThis, 'Image', { configurable: true, value: NativeImage, writable: true });
    }
  });
});
