import type { GenerateWidgetValues } from '@features/generation/contracts';
import type { QueueGenerationMeta } from '@features/queue/contracts';
import type { VideoWidgetValues } from '@features/video';
import type { ImageRecallCapabilities, ImageRecallKind } from '@workbench/image-actions';

/**
 * Snapshot/session-based recall for queue items, mirroring the image-metadata
 * recall semantics: partial kinds merge the recalled fields into the CURRENT
 * generate form values; `all`/`remix` replace them with the submission
 * snapshot. Items this client submitted carry the full snapshot; foreign items
 * still expose prompts + the actual executed seed via the session meta.
 */

export const getQueueRecallCapabilities = (
  snapshot: GenerateWidgetValues | null,
  meta: QueueGenerationMeta
): ImageRecallCapabilities => ({
  all: snapshot !== null,
  clipSkip: snapshot !== null,
  dimensions: snapshot !== null,
  prompts: snapshot !== null || meta.positivePrompt !== undefined,
  remix: snapshot !== null,
  seed: meta.seed !== undefined || (snapshot !== null && !snapshot.shouldRandomizeSeed),
});

export const buildQueueRecallValues = (
  kind: ImageRecallKind,
  {
    current,
    meta,
    snapshot,
  }: {
    current: GenerateWidgetValues | null;
    meta: QueueGenerationMeta;
    snapshot: GenerateWidgetValues | null;
  }
): GenerateWidgetValues | null => {
  if (kind === 'all') {
    return snapshot;
  }

  if (kind === 'remix') {
    return snapshot ? { ...snapshot, shouldRandomizeSeed: true } : null;
  }

  if (!current) {
    return null;
  }

  if (kind === 'prompts') {
    const positivePrompt = snapshot?.positivePrompt ?? meta.positivePrompt;

    if (positivePrompt === undefined) {
      return null;
    }

    const negativePrompt = snapshot?.negativePrompt ?? meta.negativePrompt;

    return {
      ...current,
      positivePrompt,
      // The two sources disagree about what they hold, so the template has to
      // follow whichever one the prompt came from. A snapshot stores the text as
      // authored, alongside the template that shaped it — recalling the text and
      // dropping the template would quietly generate something else. The session
      // metadata has no snapshot and carries the merged prompt outright, so
      // there the current template has to go or it would wrap it a second time.
      //
      // Coalesced because queue history is persisted: a snapshot written before
      // templates existed has no such field, and must not recall `undefined`.
      promptTemplate: snapshot ? (snapshot.promptTemplate ?? null) : null,
      ...(negativePrompt !== undefined
        ? { negativePrompt, negativePromptEnabled: snapshot?.negativePromptEnabled ?? negativePrompt.length > 0 }
        : {}),
    };
  }

  if (kind === 'seed') {
    // The session's seed is what actually ran (randomized submissions store a
    // placeholder in the snapshot), so it wins.
    const seed = meta.seed ?? (snapshot && !snapshot.shouldRandomizeSeed ? snapshot.seed : undefined);

    return seed === undefined ? null : { ...current, seed, shouldRandomizeSeed: false };
  }

  if (kind === 'dimensions') {
    return snapshot
      ? {
          ...current,
          aspectRatioId: snapshot.aspectRatioId,
          aspectRatioIsLocked: snapshot.aspectRatioIsLocked,
          aspectRatioValue: snapshot.aspectRatioValue,
          height: snapshot.height,
          width: snapshot.width,
        }
      : null;
  }

  return snapshot ? { ...current, clipSkip: snapshot.clipSkip } : null;
};

/**
 * The Video-panel equivalent of {@link buildQueueRecallValues}, for a queue item
 * this client submitted from Video. Video's prompt is its own widget value, so a
 * video item's prompt must not be recalled into Generate's — the two panels hold
 * independent text.
 *
 * Only the verbs a video item can actually offer are handled. Its `snapshot` in
 * {@link getQueueRecallCapabilities} is always null (that lookup is Generate-
 * shaped), so `all`/`remix`/`dimensions`/`clipSkip` are disabled for video items
 * and never reach here; prompts and seed come from the session meta, which is
 * recorded identically for video and image batches.
 *
 * Returns a PATCH, not a whole values object: the panel's other settings belong
 * to whatever the user has configured now, and a wholesale write would drag a
 * model-family transition along with it.
 */
export const buildVideoQueueRecallPatch = (
  kind: ImageRecallKind,
  meta: QueueGenerationMeta
): Partial<VideoWidgetValues> | null => {
  if (kind === 'prompts') {
    if (meta.positivePrompt === undefined) {
      return null;
    }

    return {
      positivePrompt: meta.positivePrompt,
      // Session meta cannot distinguish "no negative recorded" from "negative
      // disabled, submitted as ''", so an absent or empty negative leaves the
      // toggle exactly as the user has it rather than flipping it off. This
      // matches the gallery-side video recall for Wan. MiniMax H3 differs:
      // it never wires a negative into its metadata, so gallery recall sees
      // nothing, while the batch still records the field and we recall it —
      // harmless, since H3's panel hides the negative and the value restored
      // is the one the panel already held.
      ...(meta.negativePrompt !== undefined && meta.negativePrompt.length > 0
        ? { negativePrompt: meta.negativePrompt, negativePromptEnabled: true }
        : {}),
    };
  }

  if (kind === 'seed') {
    return meta.seed === undefined ? null : { seed: meta.seed, shouldRandomizeSeed: false };
  }

  return null;
};

/**
 * Which panel a queue-item recall targets, and what to write there. A
 * discriminated union rather than a caller-side `if`: the two panels take
 * different payloads (Video a partial patch, Generate a whole values object),
 * so a caller that forgets a branch fails to compile instead of silently
 * recalling into the wrong panel — which is exactly the bug this replaced.
 */
export type QueueRecallPlan =
  | { target: 'generate'; values: GenerateWidgetValues }
  | { target: 'video'; patch: Partial<VideoWidgetValues> };

export const planQueueRecall = (
  kind: ImageRecallKind,
  {
    current,
    isVideoItem,
    meta,
    snapshot,
  }: {
    current: GenerateWidgetValues | null;
    /**
     * Whether this item was submitted from Video BY THIS CLIENT. False also
     * means "unknown" — a foreign item's `field_values` cannot distinguish a
     * video batch from an image one, so the Generate-shaped default stands.
     */
    isVideoItem: boolean;
    meta: QueueGenerationMeta;
    snapshot: GenerateWidgetValues | null;
  }
): QueueRecallPlan | null => {
  if (isVideoItem) {
    const patch = buildVideoQueueRecallPatch(kind, meta);

    return patch ? { patch, target: 'video' } : null;
  }

  const values = buildQueueRecallValues(kind, { current, meta, snapshot });

  return values ? { target: 'generate', values } : null;
};
