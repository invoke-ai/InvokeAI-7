import type { GalleryVideoItem } from '@features/gallery';
import type { ModelConfig } from '@features/models';
import type { WorkbenchCommands } from '@workbench/workbenchStore';

import { accountLifecycle } from '@platform/state/accountLifecycle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const galleryApi = vi.hoisted(() => ({
  galleryImages: { metadata: vi.fn(), resolveMany: vi.fn() },
  galleryItems: { resolve: vi.fn() },
  galleryVideos: { metadata: vi.fn() },
}));

vi.mock('@features/gallery', () => galleryApi);

import { createDefaultVideoWidgetValues } from '@features/video';

import { executeVideoRecall } from './executeVideoRecall';

const wanModel = {
  base: 'wan',
  file_size: 1,
  format: 'diffusers',
  hash: 'wan-hash',
  key: 'wan-t2v',
  name: 'Wan 2.2 t2v_a14b',
  path: '/models/wan',
  source: 'local',
  source_type: 'path',
  type: 'main',
  variant: 't2v_a14b',
} as ModelConfig;

const item: GalleryVideoItem = {
  boardId: 'none',
  category: 'general',
  createdAt: '2026-08-26T00:00:00.000Z',
  durationSeconds: 5,
  fullUrl: '/clip.mp4',
  height: 720,
  isIntermediate: false,
  kind: 'video',
  name: 'clip.mp4',
  starred: false,
  thumbnailUrl: '/clip-thumb.jpg',
  width: 1280,
};

const metadata = {
  cfg_scale: 5,
  generation_mode: 'wan_t2v',
  height: 720,
  model: { base: 'wan', key: wanModel.key, name: wanModel.name, type: 'main' },
  negative_prompt: 'blurry',
  num_frames: 81,
  positive_prompt: 'a fox running',
  seed: 4321,
  steps: 40,
  width: 1280,
};

const createCommands = () => {
  const patchValues = vi.fn();
  const commands = {
    notifications: { add: vi.fn(), reportError: vi.fn() } as unknown as WorkbenchCommands['notifications'],
    widgets: { patchValues } as unknown as WorkbenchCommands['widgets'],
  };

  return { commands, patchValues };
};

describe('executeVideoRecall', () => {
  beforeEach(() => {
    accountLifecycle.activate('test-account');
    galleryApi.galleryVideos.metadata.mockReset();
    galleryApi.galleryImages.resolveMany.mockReset();
    galleryApi.galleryItems.resolve.mockReset();
  });

  it('writes only the prompt keys for a prompts-only recall', async () => {
    galleryApi.galleryVideos.metadata.mockResolvedValue(metadata);
    const { commands, patchValues } = createCommands();
    // A panel whose recorded main is NOT installed: `getCurrentVideoValues`
    // re-snaps it onto another family, so a whole-values write here would push
    // that transition into the store behind a "prompts" toast.
    const videoValues = { ...createDefaultVideoWidgetValues([wanModel]), numFrames: 41, steps: 4 };

    const didRecall = await executeVideoRecall({
      commands,
      getVideoValues: () => videoValues as unknown as Record<string, unknown>,
      item,
      kind: 'prompts',
      models: [],
    });

    expect(didRecall).toBe(true);
    expect(patchValues).toHaveBeenCalledTimes(1);
    expect(patchValues).toHaveBeenCalledWith(
      'video',
      { negativePrompt: 'blurry', negativePromptEnabled: true, positivePrompt: 'a fox running' },
      undefined
    );
  });

  it('writes the whole values object when the recall carries more than prompts', async () => {
    galleryApi.galleryVideos.metadata.mockResolvedValue(metadata);
    const { commands, patchValues } = createCommands();
    const videoValues = createDefaultVideoWidgetValues([wanModel]);

    const didRecall = await executeVideoRecall({
      commands,
      getVideoValues: () => videoValues as unknown as Record<string, unknown>,
      item,
      kind: 'all',
      models: [wanModel],
    });

    expect(didRecall).toBe(true);
    expect(patchValues).toHaveBeenCalledTimes(1);
    // Prompts ride along with everything else — they are ordinary video values.
    expect(patchValues.mock.calls[0]?.[1]).toMatchObject({
      negativePrompt: 'blurry',
      positivePrompt: 'a fox running',
      seed: 4321,
    });
  });
});
