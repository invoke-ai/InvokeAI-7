/* oxlint-disable react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-array-as-prop */
import type { GalleryItem, GalleryItemRef } from '@features/gallery/core/items';
import type { GalleryBoard } from '@features/gallery/core/types';
import type { GalleryUiAdapter } from '@features/gallery/react';

import { ChakraProvider } from '@chakra-ui/react';
import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import { GalleryUiProvider } from '@features/gallery/react';
import { getGalleryItemDragData, getGalleryItemDragId } from '@features/gallery/ui/galleryDnd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { system } from '@theme/system';
import { widgetCollisionDetection } from '@workbench/widgetDnd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GalleryMediaSlotValue } from './GalleryMediaSlot';

import { GalleryMediaSlot } from './GalleryMediaSlot';

const mocks = vi.hoisted(() => ({
  getGalleryItemByRef: vi.fn(),
  invalidateGallery: vi.fn(),
  uploadGalleryImage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) =>
      values && 'name' in values ? `${key}:${String(values.name)}` : key,
  }),
}));

vi.mock('@features/queue/react', () => ({
  useQueueItemProgress: () => null,
  useQueueItemProgressImage: () => null,
}));

vi.mock('@features/gallery/data/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  galleryBoardsOptions: () => ({
    queryFn: () => Promise.resolve([board]),
    queryKey: ['test-slot-boards'],
    staleTime: Infinity,
  }),
  galleryItemsInfiniteOptions: () => ({
    getNextPageParam: () => undefined,
    initialPageParam: 0,
    queryFn: () => Promise.resolve({ items: [image('a.png')], total: 1 }),
    queryKey: ['test-slot-items'],
    staleTime: Infinity,
  }),
}));

vi.mock('@features/gallery/data/backend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGalleryItemByRef: (...args: unknown[]) => mocks.getGalleryItemByRef(...args),
  uploadGalleryImage: (...args: unknown[]) => mocks.uploadGalleryImage(...args),
}));

vi.mock('@features/gallery/data/queryCache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateGallery: (...args: unknown[]) => mocks.invalidateGallery(...args),
}));

const board: GalleryBoard = {
  archived: false,
  assetCount: 0,
  assetVideoCount: 0,
  id: 'dogs',
  imageCount: 1,
  kind: 'board',
  name: 'Dogs',
  projectId: null,
  videoCount: 0,
};

const image = (name: string): GalleryItem => ({
  boardId: 'dogs',
  category: 'general',
  createdAt: '2026-09-01T00:00:00.000Z',
  fullUrl: `/full/${name}`,
  height: 96,
  isIntermediate: false,
  kind: 'image',
  name,
  starred: false,
  thumbnailUrl: `/thumb/${name}`,
  width: 128,
});

const IMAGE_REF: GalleryItemRef = { kind: 'image', name: 'frame.png' };
const VIDEO_REF: GalleryItemRef = { kind: 'video', name: 'clip.mp4' };

const galleryCommands = { selectBoard: vi.fn(), selectItem: vi.fn(), setView: vi.fn() };
const notifications = { add: vi.fn(), reportError: vi.fn() };
const adapter = {
  gallery: galleryCommands,
  galleryValues: { galleryView: 'images', selectedBoardId: 'dogs' },
  notifications,
  projectName: 'Project',
  widgets: { openGallery: () => true, patchGalleryValues: vi.fn() },
} as unknown as GalleryUiAdapter;

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const onChange = vi.fn();

const interact = (action: () => void): Promise<void> =>
  act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
  });

const DraggableThumb = ({ data, id, left, testId }: { data: unknown; id: string; left: number; testId: string }) => {
  const { listeners, setNodeRef } = useDraggable({ data: data as never, id });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      data-testid={testId}
      style={{ height: 40, left, position: 'fixed', top: 20, width: 40 }}
    />
  );
};

const renderSlot = async (props: Partial<Parameters<typeof GalleryMediaSlot>[0]> = {}) => {
  const Harness = () => {
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

    return (
      <ChakraProvider value={system}>
        <QueryClientProvider client={queryClient!}>
          <GalleryUiProvider adapter={adapter}>
            <DndContext collisionDetection={widgetCollisionDetection} sensors={sensors}>
              <DraggableThumb
                data={getGalleryItemDragData([IMAGE_REF])}
                id={getGalleryItemDragId(IMAGE_REF, 'preview-frame')}
                left={10}
                testId="image-thumb"
              />
              <DraggableThumb
                data={getGalleryItemDragData([VIDEO_REF])}
                id={getGalleryItemDragId(VIDEO_REF, 'preview-frame')}
                left={60}
                testId="video-thumb"
              />
              <DraggableThumb
                data={getGalleryItemDragData([IMAGE_REF, { kind: 'image', name: 'second.png' }])}
                id="multi-image-drag"
                left={110}
                testId="multi-thumb"
              />
              <div data-testid="slot" style={{ left: 200, position: 'fixed', top: 200, width: 320 }}>
                <GalleryMediaSlot
                  accept={['image']}
                  dropId="test-slot"
                  uploadBoardId="none"
                  value={null}
                  onChange={onChange}
                  {...props}
                />
              </div>
            </DndContext>
          </GalleryUiProvider>
        </QueryClientProvider>
      </ChakraProvider>
    );
  };

  await interact(() => root?.render(<Harness />));
};

const trigger = () => host?.querySelector<HTMLButtonElement>('button[aria-label^="widgets.gallery.picker."]');
const actionButton = (key: string) =>
  [...(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) => button.textContent?.includes(key));
const alertText = () => host?.querySelector('[role="alert"]')?.textContent ?? null;

const pointer = (type: string, target: EventTarget, clientX: number, clientY: number): void => {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, clientX, clientY, isPrimary: true, pointerId: 1 })
  );
};

const dragOntoSlot = async (testId: string) => {
  const thumb = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
  const rect = thumb.getBoundingClientRect();
  const slotRect = document.querySelector<HTMLElement>('[data-testid="slot"] button')!.getBoundingClientRect();
  const x = slotRect.left + slotRect.width / 2;
  const y = slotRect.top + slotRect.height / 2;

  await interact(() => pointer('pointerdown', thumb, rect.left + 20, rect.top + 20));
  await interact(() => pointer('pointermove', thumb.ownerDocument, rect.left + 50, rect.top + 50));
  await interact(() => pointer('pointermove', thumb.ownerDocument, x, y));
  await interact(() => pointer('pointerup', thumb.ownerDocument, x, y));
};

const changeFile = async (file: File) => {
  const input = host?.querySelector<HTMLInputElement>('input[type="file"]');

  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await interact(() => input?.dispatchEvent(new Event('change', { bubbles: true })));
};

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await interact(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  queryClient?.clear();
});

describe('GalleryMediaSlot', () => {
  it('opens the picker from the slot and hands back the picked item', async () => {
    await renderSlot();

    expect(trigger()?.getAttribute('aria-label')).toBe('widgets.gallery.picker.chooseImage');
    await interact(() => trigger()?.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');

    expect(dialog?.getAttribute('aria-label')).toBe('widgets.gallery.picker.chooseImage');
    await vi.waitFor(() => expect(dialog?.querySelector('input:not([type="file"])')).not.toBeNull(), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(dialog?.querySelector('[data-item-key="image:a.png"]')).not.toBeNull());
    await interact(() => dialog?.querySelector<HTMLElement>('[data-item-key="image:a.png"]')?.click());

    expect(onChange).toHaveBeenCalledExactlyOnceWith(image('a.png'));
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
  });

  it('adopts a single image dropped from the gallery, resolving it first', async () => {
    let resolveItem: ((item: GalleryItem) => void) | undefined;

    mocks.getGalleryItemByRef.mockReturnValue(
      new Promise<GalleryItem>((resolve) => {
        resolveItem = resolve;
      })
    );
    await renderSlot();
    await dragOntoSlot('image-thumb');

    expect(mocks.getGalleryItemByRef).toHaveBeenCalledExactlyOnceWith(IMAGE_REF, expect.any(AbortSignal));
    expect(trigger()?.getAttribute('aria-busy')).toBe('true');

    await interact(() => resolveItem?.(image('frame.png')));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(image('frame.png'));
    expect(trigger()?.getAttribute('aria-busy')).toBeNull();
  });

  it('reports a failed resolve inline', async () => {
    mocks.getGalleryItemByRef.mockRejectedValue(new Error('image vanished'));
    await renderSlot();
    await dragOntoSlot('image-thumb');

    expect(onChange).not.toHaveBeenCalled();
    expect(alertText()).toBe('image vanished');
    expect(notifications.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'image vanished' }));
  });

  it('ignores multi-item and wrong-kind drags', async () => {
    await renderSlot();
    await dragOntoSlot('multi-thumb');
    await dragOntoSlot('video-thumb');

    expect(mocks.getGalleryItemByRef).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uploads into the given board and adopts the result', async () => {
    mocks.uploadGalleryImage.mockResolvedValue({
      boardId: 'none',
      createdAt: '2026-09-09T00:00:00.000Z',
      height: 96,
      imageCategory: 'user',
      imageName: 'fresh.png',
      imageUrl: '/full/fresh.png',
      queuedAt: '2026-09-09T00:00:00.000Z',
      sourceQueueItemId: 'queue-1',
      starred: false,
      thumbnailUrl: '/thumb/fresh.png',
      width: 128,
    });
    await renderSlot();

    expect(host?.querySelector<HTMLInputElement>('input[type="file"]')?.multiple).toBe(false);
    await changeFile(new File(['image'], 'fresh.png', { type: 'image/png' }));

    expect(mocks.uploadGalleryImage).toHaveBeenCalledExactlyOnceWith(expect.any(File), 'none', expect.anything());
    expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'image', name: 'fresh.png' }));
    expect(alertText()).toBeNull();
  });

  it('refuses a file of a kind the slot cannot take and reports an upload that yields nothing', async () => {
    mocks.uploadGalleryImage.mockRejectedValue(new Error('storage offline'));
    await renderSlot();

    await changeFile(new File(['video'], 'clip.mp4', { type: 'video/mp4' }));

    expect(mocks.uploadGalleryImage).not.toHaveBeenCalled();
    expect(alertText()).toBe('widgets.gallery.picker.unsupportedVideo');

    await changeFile(new File(['image'], 'photo.png', { type: 'image/png' }));

    expect(mocks.uploadGalleryImage).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(alertText()).toBe('widgets.gallery.picker.uploadFailed');
  });

  it('hands an uploaded file to the consumer instead of the gallery and shows a custom thumbnail', async () => {
    const onUploadFile = vi.fn();
    const value: GalleryMediaSlotValue = { kind: 'image', name: 'stored preview' };

    await renderSlot({ onUploadFile, thumbnail: <span data-testid="custom-thumb" />, value });

    expect(host?.querySelector('[data-testid="custom-thumb"]')).not.toBeNull();
    expect(host?.querySelector('img')).toBeNull();

    const file = new File(['image'], 'local.png', { type: 'image/png' });
    await changeFile(file);

    expect(onUploadFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(mocks.uploadGalleryImage).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the current value with a replace hint and clears it', async () => {
    const value: GalleryMediaSlotValue = { height: 96, kind: 'image', name: 'chosen.png', width: 128 };

    await renderSlot({ value });

    expect(trigger()?.getAttribute('aria-label')).toBe('widgets.gallery.picker.replaceImage');
    expect(host?.textContent).toContain('chosen.png');
    expect(host?.textContent).toContain('128 × 96');

    await interact(() => actionButton('widgets.gallery.picker.removeImage')?.click());

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('stands down while disabled, showing the reason', async () => {
    await renderSlot({ disabled: true, disabledReason: 'Frames come from the video' });

    expect(trigger()?.disabled).toBe(true);
    expect(host?.textContent).toContain('Frames come from the video');
    expect(actionButton('widgets.gallery.picker.upload')).toBeUndefined();

    await dragOntoSlot('image-thumb');

    expect(mocks.getGalleryItemByRef).not.toHaveBeenCalled();
  });
});
