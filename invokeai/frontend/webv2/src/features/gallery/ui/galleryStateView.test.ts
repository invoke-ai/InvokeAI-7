import type { GalleryImageItem, GalleryItem, GalleryVideoItem } from '@features/gallery/core/items';
import type { GalleryBoard, GeneratedImageContract } from '@features/gallery/core/types';
import type { QueueHistoryItemStatus, QueueItem } from '@features/queue/contracts';

import { describe, expect, it } from 'vitest';

import {
  getBoardCounts,
  getGalleryCurrentItem,
  getGalleryGenerationSequence,
  getGalleryLiveSlots,
  getGallerySelectedBoardId,
  getGallerySemanticImageQuery,
  getGalleryStateView,
} from './galleryStateView';

const boards: GalleryBoard[] = [
  {
    archived: false,
    assetCount: 0,
    assetVideoCount: 0,
    id: 'none',
    imageCount: 1,
    kind: 'uncategorized',
    name: '',
    projectId: null,
    videoCount: 0,
  },
  {
    archived: false,
    assetCount: 0,
    assetVideoCount: 0,
    id: 'board-1',
    imageCount: 2,
    kind: 'board',
    name: 'Board 1',
    projectId: null,
    videoCount: 0,
  },
];

const createImage = (imageName: string): GeneratedImageContract => ({
  height: 768,
  imageName,
  imageUrl: `/api/v1/images/i/${imageName}/full`,
  queuedAt: '2026-06-09T00:00:00.000Z',
  sourceQueueItemId: 'queue-item-1',
  thumbnailUrl: `/api/v1/images/i/${imageName}/thumbnail`,
  width: 512,
});

const createImageItem = (name: string): GalleryImageItem => ({
  boardId: 'none',
  category: 'general',
  createdAt: '2026-06-09T00:00:00.000Z',
  fullUrl: `/api/v1/images/i/${name}/full`,
  height: 768,
  isIntermediate: false,
  kind: 'image',
  name,
  sourceQueueItemId: 'queue-item-1',
  starred: false,
  thumbnailUrl: `/api/v1/images/i/${name}/thumbnail`,
  width: 512,
});

const createVideoItem = (name: string): GalleryVideoItem => ({
  ...createImageItem(name),
  durationSeconds: 3,
  fullUrl: `/api/v1/videos/i/${name}/full`,
  kind: 'video',
  thumbnailUrl: `/api/v1/videos/i/${name}/thumbnail`,
});

const createQueueItem = ({
  backendItemIds,
  batchCount = 1,
  boardId = 'none',
  completedBackendItemIds,
  cancelledBackendItemIds,
  destination = 'gallery',
  status = 'pending',
  localId,
}: {
  backendItemIds?: number[];
  batchCount?: number;
  boardId?: string;
  completedBackendItemIds?: number[];
  cancelledBackendItemIds?: number[];
  destination?: 'gallery' | 'canvas';
  status?: QueueHistoryItemStatus;
  localId?: string;
}): QueueItem => ({
  backendItemIds,
  cancellable: true,
  cancelledBackendItemIds,
  completedBackendItemIds,
  id: localId ?? `queue-item-${status}-${boardId}`,
  snapshot: {
    backendSubmission: {
      batchCount,
      graph: { edges: [], id: 'gallery-placeholder-graph', nodes: {} },
      kind: 'workflow',
    },
    destination,
    filterIntermediateResults: false,
    galleryBoardId: boardId,
    graph: { id: 'gallery-placeholder-graph', label: 'Gallery placeholder' },
    presentation: { batchCount, height: 768, width: 512 },
    sourceId: 'workflow',
    submittedAt: '2026-06-09T00:00:00.000Z',
  },
  status,
});

const getPendingPlaceholders = (queueItems: QueueItem[], values: Record<string, unknown>) =>
  getGalleryStateView(values, boards, [], false, queueItems).pendingPlaceholders;

describe('gallery state view', () => {
  it('preserves a selected backend board id while boards are still loading', () => {
    const values = { selectedBoardId: 'board-1' };

    expect(getGallerySelectedBoardId(values, [])).toBe('board-1');
    expect(getGalleryStateView(values, [], null, false).selectedBoardId).toBe('board-1');
  });

  it('falls back to uncategorized after loaded boards do not contain the selected board', () => {
    const values = { selectedBoardId: 'missing-board' };

    expect(getGallerySelectedBoardId(values, boards)).toBe('none');
    expect(getGalleryStateView(values, boards, [], false).selectedBoardId).toBe('none');
  });

  /**
   * A project arriving from another install — or one whose pre-migration board was rejected as
   * ambiguous — names a destination that does not exist here. Its own board is a better answer
   * than Uncategorized, which would quietly scatter the project's output.
   */
  it('falls back to the project board before uncategorized', () => {
    const projectBoards = [...boards, { ...boards[1]!, id: 'project-board', name: 'My Project', projectId: 'p1' }];
    const values = { projectBoardId: 'project-board', selectedBoardId: 'missing-board' };

    expect(getGallerySelectedBoardId(values, projectBoards)).toBe('project-board');
    expect(getGalleryStateView(values, projectBoards, [], false).selectedBoardId).toBe('project-board');
  });

  it('keeps a still-resolvable selection rather than reverting to the project board', () => {
    const projectBoards = [...boards, { ...boards[1]!, id: 'project-board', name: 'My Project', projectId: 'p1' }];
    const values = { projectBoardId: 'project-board', selectedBoardId: 'board-1' };

    expect(getGallerySelectedBoardId(values, projectBoards)).toBe('board-1');
  });

  it('falls back to uncategorized when the project board is gone too', () => {
    const values = { projectBoardId: 'deleted-board', selectedBoardId: 'missing-board' };

    expect(getGallerySelectedBoardId(values, boards)).toBe('none');
  });

  /**
   * Never having chosen a destination is not a choice of Uncategorized. A project saved before it
   * owned a board should still work on its own board, where everything else it has made lives.
   */
  it('uses the project board when nothing was ever selected', () => {
    const projectBoards = [...boards, { ...boards[1]!, id: 'project-board', name: 'My Project', projectId: 'p1' }];

    expect(getGallerySelectedBoardId({ projectBoardId: 'project-board' }, projectBoards)).toBe('project-board');
    expect(getGallerySelectedBoardId({}, projectBoards)).toBe('none');
  });

  it('does not render local fallback images while backend images are loading', () => {
    const values = { recentImages: [createImage('local-fallback.png')], selectedBoardId: 'none' };
    const gallery = getGalleryStateView(values, boards, null, true);

    expect((gallery as typeof gallery & { items?: GalleryItem[] }).items).toEqual([]);
    expect(gallery.isLoading).toBe(true);
  });

  it('exposes image, video, and asset counts for board labels', () => {
    expect(getBoardCounts({ ...boards[1], videoCount: 3 })).toEqual({
      assetCount: 0,
      assetVideoCount: 0,
      imageCount: 2,
      videoCount: 3,
    });
  });

  it('parses persisted gallery settings with safe defaults and ignores a persisted starredFirst', () => {
    const gallery = getGalleryStateView({ boardOrderBy: 'board_name', starredFirst: false }, boards, [], false);

    expect(gallery.settings).toEqual({
      boardOrderBy: 'board_name',
      boardOrderDir: 'DESC',
      boardPanelCollapsed: false,
      boardPanelHeightPx: 280,
      boardPanelWidthPx: 240,
      collapsedBoardSections: [],
      imageDensityPercent: 50,
      imageOrderDir: 'DESC',
      paginationMode: 'infinite',
      showArchivedBoards: false,
      showDateBoards: false,
      showImageDimensions: false,
      showOtherProjectBoards: true,
      showPendingItems: true,
      starredFirst: true,
      thumbnailFit: 'square',
    });
  });

  it('exposes comparison state only while an image selection differs from the compare image', () => {
    const selected = createImageItem('selected.png');
    const values = {
      compareImage: createImageItem('compare.png'),
      selectedBoardId: 'none',
      selectedImageName: 'image:selected.png',
    };

    expect(getGalleryStateView(values, boards, [selected], false).isComparisonActive).toBe(true);
    expect(
      getGalleryStateView({ ...values, compareImage: selected }, boards, [selected], false).isComparisonActive
    ).toBe(false);
    expect(getGalleryStateView(values, boards, [], false).isComparisonActive).toBe(false);

    const video = createVideoItem('clip');

    expect(
      getGalleryStateView({ ...values, selectedImageName: 'video:clip' }, boards, [video], false).isComparisonActive
    ).toBe(false);
  });

  it('exposes the selection page only when its stamp names the listing the grid shows', () => {
    const stamped = {
      galleryPage: 0,
      paginationMode: 'paginated',
      selectedBoardId: 'none',
      selectedImageQuery: {
        boardId: 'none',
        galleryView: 'images',
        imageOrderDir: 'DESC',
        page: 2,
        paginationMode: 'paginated',
        searchTerm: '',
      },
    };
    const pageOf = (values: Record<string, unknown>, stamp: Record<string, unknown> = {}) =>
      getGalleryStateView(
        { ...stamped, ...values, selectedImageQuery: { ...stamped.selectedImageQuery, ...stamp } },
        boards,
        [],
        false
      ).revealTargetPage;

    expect(pageOf({})).toBe(2);
    expect(getGalleryStateView(stamped, boards, [], false).page).toBe(0);
    expect(pageOf({ selectedBoardId: 'board-1' })).toBeNull();
    expect(pageOf({ paginationMode: 'infinite' })).toBeNull();
    expect(pageOf({}, { galleryView: 'assets' })).toBeNull();
    expect(pageOf({}, { paginationMode: 'infinite' })).toBeNull();
    expect(pageOf({ imageOrderDir: 'ASC' })).toBeNull();
    expect(pageOf({ searchTerm: 'cats' })).toBeNull();
    expect(pageOf({ semanticImageQuery: { imageName: 'ref.png', kind: 'image' } })).toBeNull();
  });

  it('derives starred-first from the pagination mode: sectioned infinite window, flat paginated pages', () => {
    expect(getGalleryStateView({ paginationMode: 'infinite' }, boards, [], false).settings.starredFirst).toBe(true);
    expect(getGalleryStateView({ paginationMode: 'paginated' }, boards, [], false).settings.starredFirst).toBe(false);
  });

  it('qualifies legacy names and preserves ordered mixed-media selection keys', () => {
    const gallery = getGalleryStateView(
      { selectedImageNames: ['a.png', 'video:shared', 'image:shared', 7] },
      boards,
      [],
      false
    ) as ReturnType<typeof getGalleryStateView> & { selectedItemKeys?: string[] };

    expect(gallery.selectedItemKeys).toEqual(['image:a.png', 'video:shared', 'image:shared']);
    expect(
      (
        getGalleryStateView({ selectedImageName: 'a.png' }, boards, [], false) as ReturnType<
          typeof getGalleryStateView
        > & { selectedItemKeys?: string[] }
      ).selectedItemKeys
    ).toEqual(['image:a.png']);
  });

  it('restores the selection set from a visible primary item after tab switches clear it', () => {
    const image = createImageItem('selected.png');
    const gallery = getGalleryStateView(
      { selectedImageName: 'image:selected.png', selectedImageNames: [] },
      boards,
      [image],
      false
    ) as ReturnType<typeof getGalleryStateView> & {
      selectedItemKey?: string | null;
      selectedItemKeys?: string[];
    };

    expect(gallery.selectedItemKey).toBe('image:selected.png');
    expect(gallery.selectedItemKeys).toEqual(['image:selected.png']);
  });

  it('projects same-name images and videos independently by qualified key', () => {
    const image = createImageItem('shared');
    const video = createVideoItem('shared');
    const gallery = getGalleryStateView(
      {
        compareImage: image,
        selectedImage: video,
        selectedImageName: 'video:shared',
        selectedImageNames: ['image:shared', 'video:shared'],
      },
      boards,
      [image, video],
      false
    ) as ReturnType<typeof getGalleryStateView> & {
      compareImageKey?: string | null;
      items?: GalleryItem[];
      selectedItemKey?: string | null;
      selectedItemKeys?: string[];
    };

    expect(gallery.items?.map((item) => `${item.kind}:${item.name}`)).toEqual(['image:shared', 'video:shared']);
    expect(gallery.selectedItemKey).toBe('video:shared');
    expect(gallery.selectedItemKeys).toEqual(['image:shared', 'video:shared']);
    expect(gallery.compareImageKey).toBe('image:shared');
  });

  it('parses a persisted semantic reference for the gallery view', () => {
    const values = { semanticImageQuery: { kind: 'url', url: 'https://x.test/i.png' } };
    const first = getGallerySemanticImageQuery(values);
    const second = getGallerySemanticImageQuery({ ...values });

    expect(first).toEqual({ kind: 'url', url: 'https://x.test/i.png' });
    expect(second).toEqual(first);
    expect(getGallerySemanticImageQuery({ semanticImageQuery: 'other.png' })).toEqual({
      imageName: 'other.png',
      kind: 'image',
    });
  });

  it('threads the parsed semantic reference into the view and hides pending placeholders while ranked', () => {
    const queueItems = [createQueueItem({ batchCount: 2, boardId: 'board-1', status: 'pending' })];
    const withSemantic = getGalleryStateView(
      { selectedBoardId: 'board-1', semanticImageQuery: 'ref.png' },
      boards,
      [],
      false,
      queueItems
    );

    // Legacy persisted shape: a bare image name.
    expect(withSemantic.semanticImageQuery).toEqual({ imageName: 'ref.png', kind: 'image' });
    // A ranked result has no chronological insertion point for images-to-come.
    expect(withSemantic.pendingPlaceholders).toEqual([]);

    const withoutSemantic = getGalleryStateView({ selectedBoardId: 'board-1' }, boards, [], false, queueItems);

    expect(withoutSemantic.semanticImageQuery).toBe(null);
    expect(withoutSemantic.pendingPlaceholders.length).toBeGreaterThan(0);
  });

  it('creates placeholders for in-flight gallery queue items on the viewed board', () => {
    const queueItems = [
      createQueueItem({ batchCount: 2, boardId: 'board-1', status: 'pending' }),
      createQueueItem({ backendItemIds: [11, 12, 13], boardId: 'board-1', status: 'running' }),
    ];
    const placeholders = getPendingPlaceholders(queueItems, { imageOrderDir: 'ASC', selectedBoardId: 'board-1' });

    expect(placeholders).toHaveLength(5);
    expect(placeholders[0]).toMatchObject({
      height: 768,
      itemIndex: 1,
      queueItemId: 'queue-item-running-board-1',
      width: 512,
    });
  });

  it('skips completed backend item slots when creating placeholders', () => {
    const queueItems = [
      createQueueItem({
        backendItemIds: [11, 12, 13],
        boardId: 'board-1',
        completedBackendItemIds: [11],
        status: 'running',
      }),
    ];

    const placeholders = getPendingPlaceholders(queueItems, { imageOrderDir: 'ASC', selectedBoardId: 'board-1' });

    expect(placeholders.map((placeholder) => placeholder.itemIndex)).toEqual([2, 3]);
  });

  it('resolves the live slot from the exact denoising target instead of the newest submitted batch', () => {
    const newerBatch = createQueueItem({
      backendItemIds: [21, 22],
      boardId: 'board-1',
      localId: 'newer-batch',
      status: 'running',
    });
    const activeEarlierBatch = createQueueItem({
      backendItemIds: [11, 12],
      boardId: 'board-1',
      completedBackendItemIds: [11],
      localId: 'active-earlier-batch',
      status: 'running',
    });

    expect(
      getGalleryGenerationSequence([newerBatch, activeEarlierBatch], {
        itemIndex: 2,
        queueItemId: activeEarlierBatch.id,
      }).liveSlot
    ).toMatchObject({
      boardId: 'board-1',
      itemIndex: 2,
      queueItemId: activeEarlierBatch.id,
    });
  });

  it('flattens pending slots from multiple batches into one global execution order', () => {
    const newerBatch = createQueueItem({
      backendItemIds: [21, 22],
      boardId: 'board-1',
      localId: 'newer-batch',
      status: 'running',
    });
    const earlierBatch = createQueueItem({
      backendItemIds: [11, 12],
      boardId: 'board-1',
      localId: 'earlier-batch',
      status: 'running',
    });

    const sequence = getGalleryGenerationSequence([newerBatch, earlierBatch], null);

    expect(sequence.chronologicalSlots.map((slot) => slot.id)).toEqual([
      'earlier-batch:0',
      'earlier-batch:1',
      'newer-batch:0',
      'newer-batch:1',
    ]);
    expect(sequence.liveSlot).toBeNull();
  });

  it('keeps unsubmitted batches grouped after backend-ranked slots', () => {
    const submittedBatch = createQueueItem({
      backendItemIds: [11],
      boardId: 'board-1',
      localId: 'submitted-batch',
      status: 'running',
    });
    const pendingBatchB = createQueueItem({ batchCount: 2, boardId: 'board-1', localId: 'batch-b' });
    const pendingBatchA = createQueueItem({ batchCount: 2, boardId: 'board-1', localId: 'batch-a' });

    expect(
      getGalleryGenerationSequence([pendingBatchB, submittedBatch, pendingBatchA], null).chronologicalSlots.map(
        (slot) => slot.id
      )
    ).toEqual(['submitted-batch:0', 'batch-a:0', 'batch-a:1', 'batch-b:0', 'batch-b:1']);
  });

  it('reverses the complete flattened sequence for newest-first galleries', () => {
    const newerBatch = createQueueItem({
      backendItemIds: [21, 22],
      boardId: 'board-1',
      localId: 'newer-batch',
      status: 'running',
    });
    const earlierBatch = createQueueItem({
      backendItemIds: [11, 12],
      boardId: 'board-1',
      localId: 'earlier-batch',
      status: 'running',
    });

    const placeholders = getPendingPlaceholders([newerBatch, earlierBatch], {
      imageOrderDir: 'DESC',
      selectedBoardId: 'board-1',
    });

    expect(placeholders.map((slot) => slot.id)).toEqual([
      'newer-batch:1',
      'newer-batch:0',
      'earlier-batch:1',
      'earlier-batch:0',
    ]);
  });

  it('uses one derived current item while live-follow is active', () => {
    const placeholder = {
      backendItemId: null,
      boardId: 'board-1',
      height: 768,
      id: 'queue-item:0',
      itemIndex: 1,
      queueItemId: 'queue-item',
      width: 512,
    };

    expect(
      getGalleryCurrentItem({
        activePlaceholder: placeholder,
        isComparisonActive: false,
        liveFollowEnabled: true,
        selectedItemKey: 'image:saved.png',
      })
    ).toEqual({ kind: 'placeholder', placeholder });
    expect(
      getGalleryCurrentItem({
        activePlaceholder: placeholder,
        isComparisonActive: false,
        liveFollowEnabled: false,
        selectedItemKey: 'image:saved.png',
      })
    ).toEqual({ itemKey: 'image:saved.png', kind: 'item' });
  });

  it('keeps the visible image selected when the active placeholder belongs to another board', () => {
    const image = { ...createImageItem('selected.png'), boardId: 'board-1' } as const;
    const activeItem = createQueueItem({ boardId: 'board-2', localId: 'active-other-board', status: 'running' });
    const gallery = getGalleryStateView(
      { selectedBoardId: 'board-1', selectedImageName: 'image:selected.png' },
      boards,
      [image],
      false,
      [activeItem],
      true,
      { itemIndex: 1, queueItemId: activeItem.id }
    );

    expect(gallery.currentItem).toEqual({ itemKey: 'image:selected.png', kind: 'item' });
  });

  it('skips cancelled backend item slots when creating placeholders', () => {
    const queueItems = [
      createQueueItem({
        backendItemIds: [11, 12, 13],
        boardId: 'board-1',
        cancelledBackendItemIds: [12],
        completedBackendItemIds: [11],
        status: 'running',
      }),
    ];

    const placeholders = getPendingPlaceholders(queueItems, { imageOrderDir: 'ASC', selectedBoardId: 'board-1' });

    expect(placeholders.map((placeholder) => placeholder.itemIndex)).toEqual([3]);
  });

  it('does not create placeholders for other boards, finished items, or canvas runs', () => {
    const queueItems = [
      createQueueItem({ boardId: 'board-2', status: 'pending' }),
      createQueueItem({ boardId: 'board-1', status: 'completed' }),
      createQueueItem({ boardId: 'board-1', destination: 'canvas', status: 'pending' }),
    ];

    expect(getPendingPlaceholders(queueItems, { selectedBoardId: 'board-1' })).toEqual([]);
  });

  it('hides placeholders while searching or browsing assets', () => {
    const queueItems = [createQueueItem({ boardId: 'none', status: 'pending' })];

    expect(getPendingPlaceholders(queueItems, { searchTerm: 'cat', selectedBoardId: 'none' })).toEqual([]);
    expect(getPendingPlaceholders(queueItems, { galleryView: 'assets', selectedBoardId: 'none' })).toEqual([]);
    expect(
      getGalleryStateView({ selectedBoardId: 'none' }, boards, [], false, queueItems).pendingPlaceholders
    ).toHaveLength(1);
  });

  it('hides only pending placeholders when the persisted setting is disabled', () => {
    const queueItems = [createQueueItem({ boardId: 'none', status: 'pending' })];
    const image = createImageItem('completed.png');
    const gallery = getGalleryStateView(
      { selectedBoardId: 'none', showPendingItems: false },
      boards,
      [image],
      false,
      queueItems
    );

    expect(gallery.pendingPlaceholders).toEqual([]);
    expect((gallery as typeof gallery & { items?: GalleryItem[] }).items).toEqual([image]);
    expect(gallery.settings.showPendingItems).toBe(false);
  });

  it('shows placeholders only on the paginated page where new images land', () => {
    const queueItems = [createQueueItem({ boardId: 'none', status: 'pending' })];
    const getPlaceholders = (values: Record<string, unknown>) =>
      getGalleryStateView(
        { paginationMode: 'paginated', selectedBoardId: 'none', ...values },
        boards,
        [],
        false,
        queueItems
      ).pendingPlaceholders;

    // Newest-first: new images land on page 0.
    expect(getPlaceholders({ galleryPage: 0 })).toHaveLength(1);
    expect(getPlaceholders({ galleryPage: 2 })).toHaveLength(0);

    // Oldest-first: they land at row `total`, which needs the known total.
    expect(getPlaceholders({ galleryPage: 2, galleryTotalImages: 150, imageOrderDir: 'ASC' })).toHaveLength(1);
    expect(getPlaceholders({ galleryPage: 0, galleryTotalImages: 150, imageOrderDir: 'ASC' })).toHaveLength(0);
    expect(getPlaceholders({ galleryPage: 0, imageOrderDir: 'ASC' })).toHaveLength(0);

    // An exactly-full last page means the image lands on a page that does not
    // exist yet, which no current page can show.
    expect(getPlaceholders({ galleryPage: 1, galleryTotalImages: 120, imageOrderDir: 'ASC' })).toHaveLength(0);
  });

  it('hides placeholders while an infinite window is anchored mid-board', () => {
    const queueItems = [createQueueItem({ boardId: 'none', status: 'pending' })];

    expect(
      getGalleryStateView({ galleryPage: 11, selectedBoardId: 'none' }, boards, [], false, queueItems)
        .pendingPlaceholders
    ).toHaveLength(0);
  });
});

describe('getGalleryLiveSlots', () => {
  const slot = (queueItemId: string, itemIndex: number, backendItemId: number | null) => ({
    backendItemId,
    boardId: 'none',
    height: 512,
    id: `${queueItemId}:${itemIndex - 1}`,
    itemIndex,
    queueItemId,
    width: 512,
  });

  it('returns nothing when no session is live', () => {
    expect(getGalleryLiveSlots([slot('queue-1', 1, 10)], [])).toEqual([]);
  });

  it('returns one slot per live target', () => {
    const slots = [slot('queue-1', 1, 10), slot('queue-1', 2, 11), slot('queue-1', 3, 12)];

    expect(
      getGalleryLiveSlots(slots, [
        { itemIndex: 1, queueItemId: 'queue-1' },
        { itemIndex: 3, queueItemId: 'queue-1' },
      ])
    ).toEqual([slots[0], slots[2]]);
  });

  it('orders tiles chronologically, not by the order sessions started reporting', () => {
    // Tiles must keep a stable position, so ordering follows the chronological slot
    // list (sorted by backend item id) rather than the target list.
    const slots = [slot('queue-1', 1, 10), slot('queue-1', 2, 11)];

    expect(
      getGalleryLiveSlots(slots, [
        { itemIndex: 2, queueItemId: 'queue-1' },
        { itemIndex: 1, queueItemId: 'queue-1' },
      ])
    ).toEqual([slots[0], slots[1]]);
  });

  it('ignores targets with no matching slot', () => {
    expect(getGalleryLiveSlots([slot('queue-1', 1, 10)], [{ itemIndex: 4, queueItemId: 'queue-9' }])).toEqual([]);
  });
});
