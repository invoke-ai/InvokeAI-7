import type { ImageWithDims } from '@features/generation/contracts';
import type { ModelConfig, ModelTaxonomyType } from '@features/models';
import type { VideoReferenceItem, VideoSourceClip, VideoWidgetValues } from '@features/video/core/types';

import { createListCollection, HStack, NumberInput, Stack, Switch, Text } from '@chakra-ui/react';
import { GenerationSettingsSection } from '@features/generation/components';
import { isMainModelConfig, sanitizeBatchCount, SEED_MAX } from '@features/generation/settings';
import { ensureModelsLoaded, useModelsSelector } from '@features/models';
import { ModelSelect } from '@features/models/react';
import { getVideoDurationSeconds, invertVideoAspectRatioId } from '@features/video/core/dimensions';
import {
  applyReferenceExtendSourceVideo,
  applyReferenceExtendNumFrames,
  canPlaceReferenceExtendAnchor,
  pinReferenceExtendAnchor,
  normalizeVideoWidgetValues,
  resolveVideoMode,
  VIDEO_ASPECT_RATIO_IDS,
} from '@features/video/core/settings';
import {
  getAcceleratorLoraChangeResult,
  getAcceleratorToggleResult,
  getVideoDimensions,
  getVideoModelPolicy,
  getVideoModelSelectionResult,
  isVideoModelSelectable,
} from '@features/video/core/videoPolicies';
import { createDefaultVideoWidgetValues, syncVideoWidgetValuesWithModels } from '@features/video/core/widgetValues';
import { useMountEffect } from '@platform/react/useMountEffect';
import { Field, IconButton, Select } from '@platform/ui';
import { Button } from '@platform/ui/Button';
import { SliderNumberField } from '@platform/ui/SliderNumberField';
import { toaster } from '@platform/ui/toaster';
import { ArrowLeftRightIcon, DicesIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { areVideoValuesEqual } from './videoComparators';
import { VideoComponentsSection } from './VideoComponentsSection';
import { VideoConceptsSection } from './VideoConceptsSection';
import { VideoPromptFields } from './VideoFormFields';
import { VideoFrameImageField } from './VideoFrameImageField';
import { VideoReferenceListField } from './VideoReferenceListField';
import { VideoSourceClipField } from './VideoSourceClipField';
import { useVideoUi, useVideoUiActions } from './VideoUiContext';

/**
 * Every prop identity in this file is stable by construction — module-scope
 * constants for literals, `useCallback`/`useMemo` for anything closing over
 * state, and `memo` on each section — matching the Upscale widget's contract:
 * the widget re-renders on every keystroke that patches project state.
 */

const MAIN_MODEL_TYPES: readonly ModelTaxonomyType[] = ['main'];
const SWITCH_CHECKED_PROPS = { bg: 'accent.solid' };

const ASPECT_RATIO_COLLECTION = createListCollection({
  items: VIDEO_ASPECT_RATIO_IDS.map((id) => ({ label: id, value: id })),
});

const toTargetResolution = (value: string | undefined): VideoWidgetValues['targetResolution'] | null =>
  value === '480p' || value === '720p' || value === '1080p' || value === '768 highres' || value === '768 lowres'
    ? value
    : null;

const DURATION_FORMATTER = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 1,
});

/**
 * A media value the current model cannot consume (persisted from another
 * model's session, or restored by an optimistic rollback) would otherwise
 * block invoke invisibly — its section is policy-hidden. This stub is the
 * visible affordance to clear it.
 */
const StaleMediaStub = ({ label, onClear }: { label: string; onClear: () => void }) => {
  const { t } = useTranslation();

  return (
    <HStack bg="bg.subtle" gap="2" justify="space-between" p="2" rounded="md">
      <Text color="fg.muted" fontSize="2xs" textWrap="pretty">
        {label}
      </Text>
      <Button flexShrink="0" size="2xs" variant="outline" onClick={onClear}>
        {t('widgets.video.clearStaleMedia')}
      </Button>
    </HStack>
  );
};

const VideoModelReconciler = ({
  rawValues,
  values,
}: {
  rawValues: Record<string, unknown>;
  values: VideoWidgetValues;
}) => {
  const { patchValues } = useVideoUiActions();

  useMountEffect(() => {
    const normalized = normalizeVideoWidgetValues(rawValues);

    if (normalized && areVideoValuesEqual(normalized, values)) {
      return;
    }

    // When the store fails normalization wholesale (first open: the topbar
    // Iterations field may already have patched `batchCount` into an
    // otherwise-empty widget store), seeding the defaults must not wipe that
    // one pre-open edit.
    const batchCount = normalized ? values.batchCount : sanitizeBatchCount(rawValues.batchCount ?? values.batchCount);

    patchValues({ ...values, batchCount }, 'system');
  });

  return null;
};

export const VideoWidgetView = () => {
  const { t } = useTranslation();
  const selection = useVideoUi();
  const models = useModelsSelector((snapshot) => snapshot.models);
  const modelsStatus = useModelsSelector((snapshot) => snapshot.status);
  const { patchValues, projectId, rawValues } = selection;
  // Normalizing and reconciling against the model list is the widget's most
  // expensive derivation; it must not run on unrelated re-renders, and a fresh
  // `values` identity would re-render every section below.
  const values = useMemo(() => {
    const normalized =
      normalizeVideoWidgetValues(rawValues) ?? createDefaultVideoWidgetValues(modelsStatus === 'loaded' ? models : []);

    return modelsStatus === 'loaded' ? syncVideoWidgetValuesWithModels(normalized, models) : normalized;
  }, [models, modelsStatus, rawValues]);
  const modelsFingerprint = useMemo(
    () =>
      models
        .map(
          (model) =>
            `${model.key}:${model.hash}:${model.name}:${model.base}:${model.type}:${model.format}:${model.variant ?? ''}`
        )
        .join('|'),
    [models]
  );
  const policy = useMemo(() => getVideoModelPolicy(values.model ?? undefined, values), [values]);
  const dimensions = useMemo(() => getVideoDimensions(values.model ?? undefined, values), [values]);
  const durationSeconds = getVideoDurationSeconds(
    values.numFrames,
    // In extend mode the extension inherits the SOURCE clip's frame rate.
    policy.fps.editable ? (values.sourceVideo?.fps ?? values.fps) : policy.fps.defaultValue
  );

  const patch = useCallback((next: Partial<VideoWidgetValues>) => patchValues(next), [patchValues]);

  // Always the newest normalized list. The reference field's add handlers
  // `await` a gallery resolve before writing, and the Initial Video field and
  // the Frames slider write references too — so an updater that resolved
  // against a captured array would clobber whichever of those landed during
  // the await, silently deleting the anchor or restoring a window the frame
  // count had already re-derived.
  // Synced in an effect rather than during render: this file's react-compiler
  // rule forbids touching a ref while rendering, and a gallery resolve lands
  // whole frames later, long after the commit.
  // Keyed by PROJECT, and carrying a LIVENESS bit. The widget is reconciled,
  // never remounted, across a project switch (the <Activity> key is the panel
  // instance), while `patch` stays bound to the project its render belonged
  // to — so a bare latest-list ref tracks whichever project is ACTIVE, and a
  // gallery resolve landing after a switch would write the new project's
  // reference list into the old project, wholesale. And a hidden <Activity>
  // destroys effects while promise continuations keep running: the ref then
  // freezes with the projectId still matching, so a same-project guard would
  // happily replay a list the store has since rewritten (a gallery deletion
  // sweep, say) — resurrecting swept references. `live` is true exactly while
  // the sync effect is mounted, which is the only time the ref's contents can
  // be trusted; a write finding it false or mismatched is dropped.
  //
  // "Fresh" here means effect-fresh, not instantaneous: two resolves landing
  // in the same microtask drain still read the same pre-commit list. That
  // window is inherent to reading through React state at all.
  const referencesRef = useRef({ live: true, projectId, references: values.references });

  useEffect(() => {
    referencesRef.current = { live: true, projectId, references: values.references };

    return () => {
      referencesRef.current = { ...referencesRef.current, live: false };
    };
  }, [projectId, values.references]);

  // Chakra's `Field.Root` hands its single `ids.control` to EVERY control
  // inside it, and this Field holds three. Without an id of its own the
  // switch's hidden input collides with the seed NumberInput, so the
  // `<label>` Switch.Root renders points at the seed field: clicking the
  // toggle focused the seed input and never toggled anything.
  const seedSwitchId = useId();
  const seedSwitchIds = useMemo(() => ({ hiddenInput: `${seedSwitchId}-randomize-seed` }), [seedSwitchId]);

  useMountEffect(() => {
    void ensureModelsLoaded();
  });

  const selectMainModel = useCallback(
    (model: ModelConfig | null) => {
      if (!isMainModelConfig(model) || !isVideoModelSelectable(model)) {
        return;
      }

      const result = getVideoModelSelectionResult({ currentSettings: values, model, models });

      patch({ ...result.settings, model });

      if (result.clearedLabels.length > 0) {
        toaster.create({
          description: t('widgets.video.settingsAdjustedDescription', {
            labels: result.clearedLabels.join(', '),
          }),
          title: t('widgets.video.settingsAdjusted'),
          type: 'info',
        });
      }
    },
    [models, patch, t, values]
  );

  const toggleAccelerator = useCallback(
    (details: { checked: boolean }) => {
      if (!values.model) {
        return;
      }

      const result = getAcceleratorToggleResult(values, values.model, models, details.checked);

      if (result.missingLoras) {
        toaster.create({
          description: t('widgets.video.acceleratorMissingDescription', {
            label: policy.ui.accelerator?.label ?? '',
          }),
          title: t('widgets.video.acceleratorMissing'),
          type: 'warning',
        });
        return;
      }

      patch({ ...result.settings });
    },
    [models, patch, policy.ui.accelerator?.label, t, values]
  );

  // One setter per field, created once per `patch` identity: inline
  // `onChange={(x) => patch({ x })}` props would defeat every `memo` below.
  const set = useMemo(
    () => ({
      aspectRatio: ({ value }: { value: string[] }) => {
        const aspectRatioId = value[0];

        if (aspectRatioId && (VIDEO_ASPECT_RATIO_IDS as readonly string[]).includes(aspectRatioId)) {
          patch({ aspectRatioId: aspectRatioId as VideoWidgetValues['aspectRatioId'] });
        }
      },
      cfgScale: (cfgScale: number) => patch({ cfgScale }),
      cfgScaleLowNoise: (cfgScaleLowNoise: number) => patch({ cfgScaleLowNoise }),
      fps: (fps: number) => patch({ fps }),
      randomizeSeed: (details: { checked: boolean }) => patch({ shouldRandomizeSeed: details.checked }),
      seed: ({ valueAsNumber }: NumberInput.ValueChangeDetails) =>
        Number.isFinite(valueAsNumber) && patch({ seed: valueAsNumber }),
      shuffleSeed: () => patch({ seed: Math.floor(Math.random() * SEED_MAX) }),
      steps: (steps: number) => patch({ steps }),
      targetResolution: ({ value }: { value: string[] }) => {
        const targetResolution = toTargetResolution(value[0]);

        if (targetResolution) {
          patch({ targetResolution });
        }
      },
    }),
    [patch]
  );

  const swapAspectRatio = useCallback(
    () => patch({ aspectRatioId: invertVideoAspectRatioId(values.aspectRatioId) }),
    [patch, values.aspectRatioId]
  );

  // The mutual exclusion lives in the setters: a first frame and an initial
  // video are different ways to claim the same conditioning slot, so setting
  // one clears the other. A last frame combines with either — with a first
  // frame it interpolates (FLF2V); with a source video it is the destination
  // the extension should land on. On a reference-extend panel the initial
  // video and the references coexist — the setter keeps the linked tail
  // reference in step with the clip and its cutpoints.
  const referenceExtend = Boolean(policy.references?.extend);
  const maxVideoReferences = policy.references?.maxVideos ?? 3;
  const setFirstFrame = useCallback(
    (firstFrameImage: ImageWithDims | null) =>
      patch({ firstFrameImage, ...(firstFrameImage ? { sourceVideo: null } : {}) }),
    [patch]
  );
  const setLastFrame = useCallback((lastFrameImage: ImageWithDims | null) => patch({ lastFrameImage }), [patch]);
  // Not part of `set`: that object is memoized on `patch` alone so the field
  // setters keep the children's `memo` intact, and this one has to track the
  // reference list. The linked tail reference's window is budgeted against the
  // generated frame count — the backend discards an ill-fitting window at its
  // SEAM end — so the count and the window move together. The re-derive is
  // idempotent: this fires once per keystroke of the Frames input, unclamped,
  // so typing "345" arrives as 3, then 34, then 345.
  const setNumFrames = useCallback(
    (numFrames: number) =>
      patch(
        referenceExtend && referencesRef.current.live && referencesRef.current.projectId === projectId
          ? { numFrames, references: applyReferenceExtendNumFrames(referencesRef.current.references, numFrames) }
          : { numFrames }
      ),
    // Reads the list through the ref so the Frames control keeps a stable
    // prop identity: depending on `values.references` re-created this on every
    // panel patch, re-rendering the slider against the file's stable-identity
    // contract. Safe because the re-derive is idempotent in `numFrames`. The
    // project guard is unreachable for this synchronous caller; it keeps the
    // ref's contract uniform.
    [patch, projectId, referenceExtend]
  );
  const setSourceVideo = useCallback(
    (sourceVideo: VideoSourceClip | null) => {
      if (referenceExtend) {
        // Same guard as `setReferences`: the clip field's adopt and upload
        // paths call this after an await, and a captured list would clobber a
        // reference added meanwhile. Dropped when the project moved on or the
        // sync effect is unmounted — the ref is effect-fresh, not live, and
        // only vouches for its contents while mounted.
        if (!referencesRef.current.live || referencesRef.current.projectId !== projectId) {
          return;
        }
        const current = referencesRef.current.references;
        const references = applyReferenceExtendSourceVideo(current, sourceVideo, maxVideoReferences, values.numFrames);

        // Unchanged identity with a clip set means the video cap is full and
        // no same-clip entry could be adopted. REFUSE the whole drop: patching
        // the clip anyway produced an extension with no continuity anchor at
        // all, behind nothing but a toast -- and the cap gate then froze the
        // clip's trim sliders. (The gate cannot pre-empt this case: it can
        // only ask about the clip currently set, and this drop is a different
        // one.) Clearing is never refused -- removing the linked entry cannot
        // overflow anything.
        if (sourceVideo && references === current) {
          toaster.create({
            description: t('widgets.video.referenceExtendCapFullDescription'),
            title: t('widgets.video.referenceExtendCapFull'),
            type: 'warning',
          });

          return;
        }
        patch({ references, sourceVideo, ...(sourceVideo ? { firstFrameImage: null } : {}) });
        return;
      }
      patch({ sourceVideo, ...(sourceVideo ? { firstFrameImage: null } : {}) });
    },
    [maxVideoReferences, patch, projectId, referenceExtend, t, values.numFrames]
  );
  // The single choke point for every list edit the reference field makes — add,
  // remove, retrim, reorder — so pinning the continuity anchor here covers all
  // of them. Request order is rotary order and the generation continues from
  // the LAST reference, so the anchor's position is derived, not user-set.
  const setReferences = useCallback(
    (update: (current: VideoReferenceItem[]) => VideoReferenceItem[]) => {
      // A pending edit is DROPPED when the ref cannot vouch for the list:
      // the project moved on (this callback's `patch` still targets the one
      // it rendered for), or the sync effect is unmounted (a hidden panel's
      // continuations would replay a frozen list over whatever the store has
      // done since). Losing one add beats overwriting a list the user can see.
      if (!referencesRef.current.live || referencesRef.current.projectId !== projectId) {
        return;
      }
      const updated = update(referencesRef.current.references);

      // Identity return means the updater declined (an apply-time cap check)
      // or had nothing to do: patching anyway would still fire this spread's
      // firstFrameImage/lastFrameImage clearing — a refused add erasing frame
      // slots it never touched — and dirty the project with a no-op write.
      if (updated === referencesRef.current.references) {
        return;
      }
      const next = referenceExtend ? pinReferenceExtendAnchor(updated) : updated;

      patch({
        references: next,
        ...(next.length > 0
          ? { firstFrameImage: null, lastFrameImage: null, ...(referenceExtend ? {} : { sourceVideo: null }) }
          : {}),
      });
    },
    [patch, projectId, referenceExtend]
  );
  const clearReferences = useCallback(() => patch({ references: [] }), [patch]);
  const setLoras = useCallback(
    (loras: VideoWidgetValues['loras']) => {
      // While the fast path is on it follows the list: a different complete
      // accelerator set in it re-anchors the toggle onto that set at its own
      // step count, and losing the last one turns the toggle off and restores
      // the model's own sampling defaults (the accelerator wrote steps/CFG).
      // Either way the user's list edit stands, and either way they are told —
      // a silent 6-step run with no distillation LoRA behind it just looks
      // like a broken model. An off accelerator is never armed from here.
      if (!values.model) {
        patch({ loras });
        return;
      }

      const result = getAcceleratorLoraChangeResult(values, values.model, models, loras);

      patch({ ...result.settings });

      if (result.outcome === 'switched') {
        toaster.create({
          description: t('widgets.video.acceleratorSwitchedDescription', {
            name: result.acceleratorLoras?.map((lora) => lora.name).join(', ') ?? '',
            steps: result.settings.steps,
          }),
          title: t('widgets.video.acceleratorSwitched', { label: policy.ui.accelerator?.label ?? '' }),
          type: 'info',
        });
      } else if (result.outcome === 'disabled') {
        toaster.create({
          description: t('widgets.video.acceleratorBrokenDescription'),
          title: t('widgets.video.acceleratorBroken'),
          type: 'info',
        });
      }
    },
    [models, patch, policy.ui.accelerator?.label, t, values]
  );
  const clearFirstFrame = useCallback(() => patch({ firstFrameImage: null }), [patch]);
  const clearLastFrame = useCallback(() => patch({ lastFrameImage: null }), [patch]);
  const clearSourceVideo = useCallback(() => patch({ sourceVideo: null }), [patch]);

  const targetResolutionCollection = useMemo(
    () => createListCollection({ items: policy.targetResolutions.map((option) => ({ ...option, value: option.id })) }),
    [policy.targetResolutions]
  );
  const aspectRatioValue = useMemo(() => [values.aspectRatioId], [values.aspectRatioId]);
  const targetResolutionValue = useMemo(() => [values.targetResolution], [values.targetResolution]);

  const framesSlider = useMemo(
    () =>
      policy.frames.kind === 'grid'
        ? { max: policy.frames.max, min: policy.frames.min, step: policy.frames.step }
        : {
            max: policy.frames.choices[policy.frames.choices.length - 1] ?? 0,
            min: policy.frames.choices[0] ?? 0,
            step:
              policy.frames.choices.length > 1 ? (policy.frames.choices[1] ?? 0) - (policy.frames.choices[0] ?? 0) : 1,
          },
    [policy.frames]
  );

  const mode = resolveVideoMode(values);
  const supportsFirstFrame = policy.modes.includes('first-frame') || policy.modes.includes('first-last');
  const supportsLastFrame = policy.modes.includes('first-last') || policy.modes.includes('last-frame');
  const supportsExtend = policy.modes.includes('extend');
  const supportsReferences = policy.modes.includes('reference');
  const supportsInitialVideo = supportsExtend || referenceExtend;
  // Setting an Initial Video on a reference-extend panel has to place a linked
  // tail reference, which needs a free video slot -- unless an existing entry
  // can be adopted, which consumes none. Deferring to the same predicate the
  // setter's refusal uses keeps the two from drifting: gating on the flag alone
  // disabled the field after a recall, which restores references UNFLAGGED
  // beside the source video, and `disabled` reaches the clip's trim sliders too
  // -- so the cutpoint could not be moved on a clip that was legitimately set.
  const initialVideoCapBlocked =
    referenceExtend &&
    !canPlaceReferenceExtendAnchor(values.references, values.sourceVideo?.video_name, maxVideoReferences);
  const hasConditioningMedia = Boolean(values.firstFrameImage || values.lastFrameImage || values.sourceVideo);
  const derivedSourceText = dimensions ? t(`widgets.video.dimensionSource.${dimensions.source}`) : undefined;
  const derivedSizeText = dimensions
    ? `${t('widgets.video.derivedSize', { height: dimensions.height, width: dimensions.width })}${
        derivedSourceText ? ` — ${derivedSourceText}` : ''
      }`
    : t('widgets.video.derivedSizeUnavailable');
  const fpsLockedForExtend = policy.ui.fpsVisible && mode === 'extend';
  const durationText =
    durationSeconds === null
      ? undefined
      : t('widgets.video.framesDuration', { seconds: DURATION_FORMATTER.format(durationSeconds) });

  return (
    <Stack gap="1" minW="0" p="1">
      <VideoModelReconciler
        key={`${projectId}:${modelsStatus}:${modelsFingerprint}`}
        rawValues={rawValues}
        values={values}
      />

      {/* Tier-1, like Generate's model card: which model you are running is the
          choice every field below is conditioned on, so it sits above the
          prompt rather than inside a collapsed section. */}
      {/* `px` matches the inset the prompt block and every section body carry,
          so the picker lines up with the fields below it — Generate's card can
          skip it only because its neighbours sit flush too. */}
      <Stack gap="1" px="2" py="1">
        <Field
          error={values.model ? undefined : t('widgets.video.modelRequired')}
          hint="model"
          label={t('widgets.video.mainModel')}
        >
          <ModelSelect
            filter={isVideoModelSelectable}
            invalid={!values.model}
            modelTypes={MAIN_MODEL_TYPES}
            placeholder={t('widgets.video.selectModel')}
            size="xs"
            value={values.model?.key ?? null}
            onChange={selectMainModel}
          />
        </Field>
      </Stack>

      <VideoPromptFields
        loras={values.loras}
        model={values.model}
        negativeHelpText={policy.prompt.negativeHelpText}
        negativePrompt={values.negativePrompt}
        negativePromptEnabled={values.negativePromptEnabled}
        negativePromptHeightPx={values.negativePromptHeightPx}
        negativeVisible={policy.prompt.negativeVisible}
        positivePrompt={values.positivePrompt}
        positivePromptHeightPx={values.positivePromptHeightPx}
        projectId={projectId}
        showSyntaxHighlighting={selection.showPromptSyntaxHighlighting}
        onPatchValues={patch}
      />

      {supportsFirstFrame || supportsLastFrame ? (
        <GenerationSettingsSection label={t('widgets.video.initialFrames')} sectionId="video-frames" defaultOpen>
          <Stack gap="3" p="2">
            {supportsFirstFrame ? (
              <Field
                helpText={values.sourceVideo ? undefined : t('widgets.video.firstFrameHelp')}
                label={t('widgets.video.firstFrame')}
              >
                <VideoFrameImageField
                  disabled={Boolean(values.sourceVideo)}
                  disabledReason={values.sourceVideo ? t('widgets.video.firstFrameBlocked') : undefined}
                  dropId="video-first-frame"
                  dropLabel={t('widgets.video.dropFirstFrame')}
                  image={values.firstFrameImage}
                  onChange={setFirstFrame}
                />
              </Field>
            ) : null}
            {supportsLastFrame ? (
              <Field
                helpText={
                  values.sourceVideo ? t('widgets.video.lastFrameExtendHelp') : t('widgets.video.lastFrameHelp')
                }
                label={t('widgets.video.lastFrame')}
              >
                <VideoFrameImageField
                  dropId="video-last-frame"
                  dropLabel={t('widgets.video.dropLastFrame')}
                  image={values.lastFrameImage}
                  onChange={setLastFrame}
                />
              </Field>
            ) : null}
          </Stack>
        </GenerationSettingsSection>
      ) : null}

      {!supportsFirstFrame && values.firstFrameImage ? (
        <StaleMediaStub label={t('widgets.video.staleFirstFrame')} onClear={clearFirstFrame} />
      ) : null}
      {!supportsLastFrame && values.lastFrameImage ? (
        <StaleMediaStub label={t('widgets.video.staleLastFrame')} onClear={clearLastFrame} />
      ) : null}
      {!supportsInitialVideo && values.sourceVideo ? (
        <StaleMediaStub label={t('widgets.video.staleSourceVideo')} onClear={clearSourceVideo} />
      ) : null}
      {!supportsReferences && values.references.length > 0 ? (
        <StaleMediaStub label={t('widgets.video.staleReferences')} onClear={clearReferences} />
      ) : null}

      {supportsReferences ? (
        <GenerationSettingsSection label={t('widgets.video.references')} sectionId="video-references" defaultOpen>
          <Stack gap="3" p="2">
            <VideoReferenceListField
              maxImages={policy.references?.maxImages ?? 9}
              maxVideos={policy.references?.maxVideos ?? 3}
              references={values.references}
              targetArea={dimensions ? dimensions.width * dimensions.height : null}
              onChange={setReferences}
            />
          </Stack>
        </GenerationSettingsSection>
      ) : null}

      {supportsInitialVideo ? (
        <GenerationSettingsSection label={t('widgets.video.initialVideo')} sectionId="video-source" defaultOpen>
          <Stack gap="3" p="2">
            {referenceExtend ? (
              <Text color="fg.muted" fontSize="2xs" textWrap="pretty">
                {t('widgets.video.referenceExtendHelp')}
              </Text>
            ) : null}
            <VideoSourceClipField
              disabled={Boolean(values.firstFrameImage) || initialVideoCapBlocked}
              disabledReason={
                values.firstFrameImage
                  ? t('widgets.video.initialVideoBlocked')
                  : initialVideoCapBlocked
                    ? t('widgets.video.initialVideoCapBlocked')
                    : undefined
              }
              sourceVideo={values.sourceVideo}
              onChange={setSourceVideo}
            />
          </Stack>
        </GenerationSettingsSection>
      ) : null}

      <GenerationSettingsSection label={t('widgets.video.dimensions')} sectionId="video-dimensions" defaultOpen>
        <Stack gap="3" p="2">
          <Field helpText={derivedSizeText} label={t('widgets.video.aspectRatio')}>
            <HStack gap="1">
              <Select
                collection={ASPECT_RATIO_COLLECTION}
                disabled={hasConditioningMedia}
                flex="1"
                size="xs"
                value={aspectRatioValue}
                onValueChange={set.aspectRatio}
              />
              <IconButton
                aria-label={t('widgets.video.swapAspectRatio')}
                disabled={hasConditioningMedia}
                size="xs"
                variant="ghost"
                onClick={swapAspectRatio}
              >
                <ArrowLeftRightIcon />
              </IconButton>
            </HStack>
          </Field>
          <Field label={t('widgets.video.targetResolution')}>
            <Select
              collection={targetResolutionCollection}
              size="xs"
              value={targetResolutionValue}
              onValueChange={set.targetResolution}
            />
          </Field>
          <Field helpText={durationText} label={t('widgets.video.frames')}>
            <SliderNumberField
              ariaLabel={t('widgets.video.frames')}
              max={framesSlider.max}
              min={framesSlider.min}
              step={framesSlider.step}
              value={values.numFrames}
              onChange={setNumFrames}
            />
          </Field>
          {policy.ui.fpsVisible ? (
            <Field
              helpText={fpsLockedForExtend ? t('widgets.video.fpsExtendLocked') : undefined}
              label={t('widgets.video.fps')}
            >
              <SliderNumberField
                ariaLabel={t('widgets.video.fps')}
                disabled={fpsLockedForExtend}
                max={60}
                min={policy.fps.min}
                numberInputMax={policy.fps.max}
                step={1}
                value={values.fps}
                onChange={set.fps}
              />
            </Field>
          ) : (
            <Text color="fg.muted" fontSize="2xs">
              {t('widgets.video.fixedFps', { fps: policy.fps.defaultValue })}
            </Text>
          )}
        </Stack>
      </GenerationSettingsSection>

      {/* Sampling and variation — how the model renders, not which model it is. */}
      <GenerationSettingsSection label={t('widgets.video.render')} sectionId="video-render" defaultOpen>
        <Stack gap="3" p="2">
          {policy.ui.accelerator && values.model ? (
            <Field
              helpText={t('widgets.video.acceleratorHelp', {
                label: policy.ui.accelerator.label,
                steps: policy.ui.acceleratorSteps ?? policy.ui.accelerator.steps,
              })}
              label={t('widgets.video.accelerator', { label: policy.ui.accelerator.label })}
            >
              <Switch.Root checked={values.acceleratorEnabled} size="sm" onCheckedChange={toggleAccelerator}>
                <Switch.HiddenInput />
                <Switch.Control _checked={SWITCH_CHECKED_PROPS}>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Root>
            </Field>
          ) : null}
          <Field hint="steps" label={t('widgets.video.steps')}>
            <SliderNumberField
              ariaLabel={t('widgets.video.steps')}
              max={100}
              min={policy.minSteps}
              numberInputMax={500}
              step={1}
              value={values.steps}
              onChange={set.steps}
            />
          </Field>
          {policy.ui.cfgVisible ? (
            <Field hint="cfgScale" label={t('widgets.video.cfg')}>
              <SliderNumberField
                ariaLabel={t('widgets.video.cfg')}
                max={15}
                min={1}
                numberInputMax={100}
                step={0.1}
                value={values.cfgScale}
                onChange={set.cfgScale}
              />
            </Field>
          ) : null}
          {policy.ui.cfgLowNoiseVisible ? (
            <Field helpText={t('widgets.video.cfgLowNoiseHelp')} label={t('widgets.video.cfgLowNoise')}>
              <SliderNumberField
                ariaLabel={t('widgets.video.cfgLowNoise')}
                max={15}
                min={0}
                numberInputMax={100}
                step={0.1}
                value={values.cfgScaleLowNoise ?? values.cfgScale}
                onChange={set.cfgScaleLowNoise}
              />
            </Field>
          ) : null}
          <Field hint="seed" label={t('widgets.video.seed')}>
            <HStack gap="2">
              <NumberInput.Root
                disabled={values.shouldRandomizeSeed}
                flex="1"
                max={SEED_MAX}
                min={0}
                size="xs"
                step={1}
                value={String(values.seed)}
                onValueChange={set.seed}
              >
                <NumberInput.Input aria-label={t('widgets.video.seed')} />
              </NumberInput.Root>
              <IconButton
                aria-label={t('widgets.video.shuffleSeed')}
                disabled={values.shouldRandomizeSeed}
                size="xs"
                variant="ghost"
                onClick={set.shuffleSeed}
              >
                <DicesIcon />
              </IconButton>
              <HStack gap="1">
                <Switch.Root
                  checked={values.shouldRandomizeSeed}
                  ids={seedSwitchIds}
                  size="sm"
                  onCheckedChange={set.randomizeSeed}
                >
                  <Switch.HiddenInput />
                  <Switch.Control _checked={SWITCH_CHECKED_PROPS}>
                    <Switch.Thumb />
                  </Switch.Control>
                  {/* Inside Switch.Root, so the words are part of the control
                      (they were an inert sibling <Text> before). */}
                  <Switch.Label color="fg.muted" fontSize="2xs">
                    {t('widgets.video.randomizeSeed')}
                  </Switch.Label>
                </Switch.Root>
              </HStack>
            </HStack>
          </Field>
        </Stack>
      </GenerationSettingsSection>

      <VideoConceptsSection loras={values.loras} model={values.model} onChangeLoras={setLoras} />
      <VideoComponentsSection values={values} onPatch={patch} />
    </Stack>
  );
};
