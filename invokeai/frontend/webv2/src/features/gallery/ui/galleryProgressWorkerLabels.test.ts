import { describe, expect, it } from 'vitest';

import { getGalleryWorkerLabels } from './galleryProgressWorkerLabels';

const local = (id: string) => ({ id: `${id}:1`, queueItemId: id, itemIndex: 1 });
const remote = (id: string, slot: number) => ({
  id: `${id}::irw-remote:${slot}:1`,
  queueItemId: `${id}::irw-remote:${slot}`,
  itemIndex: 1,
});

describe('Gallery worker badges', () => {
  it('leaves stock local Gallery tiles unlabelled when there is no remote work', () => {
    expect([...getGalleryWorkerLabels([local('one'), local('two')])]).toEqual([]);
  });

  it('labels only the actual distributed generation, independently of current worker settings', () => {
    const sessions = [local('one'), remote('one', 1), remote('one', 3), local('two')];
    expect([...getGalleryWorkerLabels(sessions)]).toEqual([
      ['one::irw-remote:1:1', 'R1'],
      ['one::irw-remote:3:1', 'R3'],
    ]);
  });

  it('keeps an orphaned remote labelled when its local item has already settled', () => {
    expect([...getGalleryWorkerLabels([remote('one', 2)])]).toEqual([['one::irw-remote:2:1', 'R2']]);
  });
});
