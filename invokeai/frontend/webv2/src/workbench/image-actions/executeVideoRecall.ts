import type { GalleryVideoItem } from '@features/gallery';
import type { ModelConfig } from '@features/models';
import type { VideoReferenceItem } from '@features/video';
import type { AccountScope } from '@platform/state/accountLifecycle';
import type { WorkbenchCommands } from '@workbench/workbenchStore';

import { galleryImages, galleryItems, galleryVideos } from '@features/gallery';
import {
  createDefaultVideoWidgetValues,
  createVideoConditioningClip,
  createVideoSourceClip,
  getDefaultReferenceConditioning,
  getVideoModelPolicy,
  isVideoReferenceConditioning,
  normalizeVideoWidgetValues,
  syncVideoWidgetValuesWithModels,
} from '@features/video';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
  registerAccountOwnedResource,
} from '@platform/state/accountLifecycle';

import {
  buildVideoRecallSettings,
  getVideoRecallMessage,
  getVideoRecallTitle,
  type VideoRecallKind,
} from './videoRecall';

const videoMetadataRequests = new Map<string, { owner: AccountScope; promise: Promise<unknown> }>();

registerAccountOwnedResource({
  clear: () => {
    videoMetadataRequests.clear();
  },
  name: 'video-recall-metadata',
});

const toErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const loadVideoMetadata = (videoName: string, owner: AccountScope): Promise<unknown> => {
  const cachedRequest = videoMetadataRequests.get(videoName);

  if (cachedRequest?.owner === owner) {
    return cachedRequest.promise;
  }

  const request = galleryVideos
    .metadata(videoName, owner.signal)
    .then((metadata) => {
      assertAccountScopeCurrent(owner);

      return metadata;
    })
    .catch((error: unknown) => {
      if (videoMetadataRequests.get(videoName)?.promise === request) {
        videoMetadataRequests.delete(videoName);
      }
      throw error;
    });

  videoMetadataRequests.set(videoName, { owner, promise: request });
  return request;
};

export const getCurrentVideoValues = ({
  models,
  videoValues,
}: {
  models: readonly ModelConfig[];
  videoValues: Record<string, unknown>;
}) => {
  const normalized = normalizeVideoWidgetValues(videoValues) ?? createDefaultVideoWidgetValues(models);

  return syncVideoWidgetValuesWithModels(normalized, models);
};

export const executeVideoRecall = async ({
  commands,
  getVideoValues,
  item,
  kind,
  models,
  owner: callerOwner,
  projectId,
}: {
  commands: Pick<WorkbenchCommands, 'notifications' | 'widgets'>;
  getVideoValues: () => Record<string, unknown>;
  item: GalleryVideoItem;
  kind: VideoRecallKind;
  models: ModelConfig[];
  /** Caller-captured identity lifetime; direct synchronous callers may omit it. */
  owner?: AccountScope;
  projectId?: string;
}): Promise<boolean> => {
  const owner = callerOwner ?? captureAccountScope();

  if (!isAccountScopeCurrent(owner)) {
    return false;
  }

  try {
    const metadata = await loadVideoMetadata(item.name, owner);

    assertAccountScopeCurrent(owner);
    // Snapshot the panel AFTER the fetch: an edit made while the metadata
    // loaded must survive into the base the recall applies on top of.
    const currentValues = getCurrentVideoValues({ models, videoValues: getVideoValues() });
    const result = buildVideoRecallSettings({ currentValues, kind, metadata, models });

    if (!result) {
      commands.notifications.add({
        kind: 'info',
        message: 'This video does not include supported Video metadata.',
        title: 'No recallable video data',
      });
      return false;
    }

    // Resolve media names against the gallery for dimensions/probe data and drop deleted references.
    if (result.fields.includes('media')) {
      let recalledMedia = false;
      const { firstFrameName, lastFrameName, sourceVideoName } = result.mediaNames;
      const frameNames = [firstFrameName, lastFrameName].filter((name): name is string => name !== null);
      const resolvedFrames =
        frameNames.length > 0 ? await galleryImages.resolveMany([...new Set(frameNames)], owner.signal) : [];

      assertAccountScopeCurrent(owner);
      const framesByName = new Map(resolvedFrames.map((frame) => [frame.imageName, frame]));
      const firstFrame = firstFrameName ? framesByName.get(firstFrameName) : undefined;
      const lastFrame = lastFrameName ? framesByName.get(lastFrameName) : undefined;

      if (firstFrame) {
        result.values = {
          ...result.values,
          firstFrameImage: { height: firstFrame.height, image_name: firstFrame.imageName, width: firstFrame.width },
          sourceVideo: null,
        };
        recalledMedia = true;
      }
      if (lastFrame) {
        result.values = {
          ...result.values,
          lastFrameImage: { height: lastFrame.height, image_name: lastFrame.imageName, width: lastFrame.width },
        };
        recalledMedia = true;
      }

      const { conditioningClip } = result.mediaNames;

      if (conditioningClip) {
        try {
          const clipItem = await galleryItems.resolve({ kind: 'video', name: conditioningClip.name }, owner.signal);

          assertAccountScopeCurrent(owner);
          if (clipItem?.kind === 'video') {
            // The recorded role, not the one a fresh drop would default to: the run held that
            // modality clean, and the other role is a different generation entirely.
            result.values = {
              ...result.values,
              conditioningClip: {
                ...createVideoConditioningClip({
                  durationSeconds: clipItem.durationSeconds,
                  fps: clipItem.fps,
                  height: clipItem.height,
                  name: clipItem.name,
                  width: clipItem.width,
                }),
                role: conditioningClip.role,
              },
              firstFrameImage: null,
              lastFrameImage: null,
              references: [],
              sourceVideo: null,
            };
            recalledMedia = true;
          }
        } catch {
          assertAccountScopeCurrent(owner);
          // The clip is gone; the rest of the recall still applies.
        }
      }

      if (sourceVideoName) {
        try {
          const sourceItem = await galleryItems.resolve({ kind: 'video', name: sourceVideoName }, owner.signal);

          assertAccountScopeCurrent(owner);
          if (sourceItem?.kind === 'video') {
            const rebuiltClip = createVideoSourceClip({
              durationSeconds: sourceItem.durationSeconds,
              fps: sourceItem.fps,
              height: sourceItem.height,
              name: sourceItem.name,
              width: sourceItem.width,
            });
            // Restore recorded trim against the fresh estimate; default trim would select different frames.
            const trim = rebuiltClip.numFrames >= 2 ? result.mediaNames.sourceVideoTrim : null;
            const startFrame = trim
              ? Math.min(Math.max(trim.startFrame, 0), rebuiltClip.numFrames - 2)
              : rebuiltClip.startFrame;
            const endFrame = trim
              ? Math.min(Math.max(trim.endFrame, startFrame + 1), rebuiltClip.numFrames - 1)
              : rebuiltClip.endFrame;

            result.values = {
              ...result.values,
              firstFrameImage: null,
              sourceVideo: { ...rebuiltClip, endFrame, startFrame },
            };
            recalledMedia = true;
          }
        } catch {
          assertAccountScopeCurrent(owner);
          // The source clip is gone; the rest of the recall still applies.
        }
      }

      if (result.mediaNames.references.length > 0) {
        // Hydrate references in recorded order, dropping deleted media without reordering survivors.
        const imageNames = result.mediaNames.references
          .filter((reference): reference is typeof reference & { kind: 'image' } => reference.kind === 'image')
          .map((reference) => reference.name);
        const resolvedImages =
          imageNames.length > 0 ? await galleryImages.resolveMany([...new Set(imageNames)], owner.signal) : [];

        assertAccountScopeCurrent(owner);
        const imagesByName = new Map(resolvedImages.map((image) => [image.imageName, image]));
        const references: VideoReferenceItem[] = [];

        for (const recorded of result.mediaNames.references) {
          if (recorded.kind === 'image') {
            const image = imagesByName.get(recorded.name);

            if (image) {
              references.push({
                detail: recorded.detail === 'match' ? 'match' : 'max',
                image: { height: image.height, image_name: image.imageName, width: image.width },
                kind: 'image',
              });
            }
            continue;
          }
          try {
            const item = await galleryItems.resolve({ kind: 'video', name: recorded.name }, owner.signal);

            assertAccountScopeCurrent(owner);
            if (item?.kind !== 'video') {
              continue;
            }
            const clip = createVideoSourceClip({
              durationSeconds: item.durationSeconds,
              fps: item.fps,
              height: item.height,
              name: item.name,
              width: item.width,
            });
            // Restore the recorded trim, clamped to the fresh frame-count estimate.
            const startFrame = recorded.trim ? Math.min(Math.max(recorded.trim.startFrame, 0), clip.numFrames - 1) : 0;
            const endFrame = recorded.trim
              ? Math.min(Math.max(recorded.trim.endFrame, startFrame), clip.numFrames - 1)
              : clip.numFrames - 1;
            // Any valid recorded conditioning wins; otherwise use add-path defaults, including soundtrack
            // conditioning for wrapped audio.
            const conditioning = isVideoReferenceConditioning(recorded.conditioning)
              ? recorded.conditioning
              : getDefaultReferenceConditioning(item.mediaOrigin);

            references.push({ clip: { ...clip, endFrame, startFrame }, conditioning, kind: 'video' });
          } catch {
            assertAccountScopeCurrent(owner);
            // The reference video is gone; the rest of the recall still applies.
          }
        }

        if (references.length > 0) {
          result.values = {
            ...result.values,
            firstFrameImage: null,
            lastFrameImage: null,
            references,
            // A source video recorded alongside references is reference-extend
            // state (hydrated above) — keep it; clear only a leftover.
            sourceVideo: result.mediaNames.sourceVideoName ? result.values.sourceVideo : null,
          };
          recalledMedia = true;
        }
      }

      if (!recalledMedia) {
        result.fields = result.fields.filter((field) => field !== 'media');
      }

      // Reconcile hydrated media with the effective model's modes; deleted frames or unavailable models must not
      // leave an ungeneratable panel.
      const effectiveModel = result.values.model;

      if (effectiveModel) {
        const policy = getVideoModelPolicy(effectiveModel, result.values);
        const modes = policy.modes;
        const referenceExtend = Boolean(policy.references?.extend);
        let { firstFrameImage, lastFrameImage, sourceVideo } = result.values;
        let references = result.values.references;

        if (references.length > 0 && !modes.includes('reference')) {
          // The recalled transformer (or the panel's surviving one) has no reference mode.
          references = [];
        }
        if (references.length > 0) {
          // References replace the frame slots; the source video survives only
          // on a reference-extend panel (the new clip is appended to it).
          firstFrameImage = null;
          lastFrameImage = null;
          if (!referenceExtend) {
            sourceVideo = null;
          }
        }

        if (sourceVideo && !modes.includes('extend') && !(references.length > 0 && referenceExtend)) {
          sourceVideo = null;
        }
        if (firstFrameImage && !modes.includes('first-frame') && !modes.includes('first-last')) {
          firstFrameImage = null;
        }
        if (lastFrameImage) {
          const lastFrameSupported =
            firstFrameImage || sourceVideo ? modes.includes('first-last') : modes.includes('last-frame');

          if (!lastFrameSupported) {
            lastFrameImage = null;
          }
        }

        if (
          firstFrameImage !== result.values.firstFrameImage ||
          lastFrameImage !== result.values.lastFrameImage ||
          sourceVideo !== result.values.sourceVideo ||
          references !== result.values.references
        ) {
          result.values = { ...result.values, firstFrameImage, lastFrameImage, references, sourceVideo };
        }
      }
    }

    if (result.fields.length === 0) {
      commands.notifications.add({
        kind: 'info',
        message: 'This video does not include supported Video metadata.',
        title: 'No recallable video data',
      });
      return false;
    }

    // Commit only prompt keys: resnapshotted values may contain an unrelated model-family transition and would
    // widen the lost-update window for concurrent media recall.
    if (result.fields.every((field) => field === 'prompts')) {
      commands.widgets.patchValues(
        'video',
        {
          negativePrompt: result.values.negativePrompt,
          negativePromptEnabled: result.values.negativePromptEnabled,
          positivePrompt: result.values.positivePrompt,
        },
        projectId
      );
    } else {
      commands.widgets.patchValues('video', { ...result.values }, projectId);
    }
    commands.notifications.add({
      kind: 'success',
      message: getVideoRecallMessage(result.fields),
      title: getVideoRecallTitle(kind),
    });
    return true;
  } catch (error: unknown) {
    if (!isAccountScopeCurrent(owner)) {
      return false;
    }

    commands.notifications.reportError({
      area: 'video-recall',
      message: toErrorMessage(error),
      namespace: 'generation',
      projectId,
    });
    return false;
  }
};
