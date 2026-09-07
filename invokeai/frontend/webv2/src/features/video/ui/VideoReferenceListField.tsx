import type { DragEndEvent } from '@dnd-kit/core';
import type { GalleryItem, GalleryVideoItem } from '@features/gallery';
import type { GalleryPickerSelection } from '@features/gallery/picker';
import type {
  VideoReferenceConditioning,
  VideoReferenceImageDetail,
  VideoReferenceItem,
} from '@features/video/core/types';
import type { ChangeEvent } from 'react';

import { Badge, Box, createListCollection, HStack, Icon, Image, Input, Spinner, Stack, Text } from '@chakra-ui/react';
import { useDndContext, useDndMonitor, useDroppable } from '@dnd-kit/core';
import { galleryItems, galleryTransfers, galleryVideos, toGalleryItemKey } from '@features/gallery';
import { GalleryPickerPopover } from '@features/gallery/picker';
import { galleryImageUrls, galleryVideoUrls, isGalleryItemDragData } from '@features/gallery/utility';
import { resolveMiniMaxH3ReferenceImage } from '@features/video/core/dimensions';
import {
  createVideoSourceClip,
  getDefaultReferenceClip,
  getDefaultReferenceConditioning,
  getDefaultReferenceImageDetail,
  resizeReferenceSampleWindow,
  slideReferenceSampleWindow,
} from '@features/video/core/settings';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { Button, IconButton } from '@platform/ui/Button';
import { DropTargetOverlay } from '@platform/ui/DropTargetOverlay';
import { DropZone } from '@platform/ui/DropZone';
import { Field, FieldLabel } from '@platform/ui/Field';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { Select } from '@platform/ui/Select';
import { SliderNumberField } from '@platform/ui/SliderNumberField';
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, FilmIcon, ImagePlusIcon, UploadIcon, XIcon } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { TrimBoundThumb } from './TrimBoundThumb';
import { useVideoUiActions } from './VideoUiContext';

/**
 * The ordered Ref2VA reference list: numbered cards (order is part of the request — a
 * different order is a different generation), one gallery drop target that accepts a single
 * image or video, per-kind file uploads, a per-video conditioning selector and trim, and a
 * per-image detail selector.
 */

const DROP_ID = 'video-reference-list';
const IMAGE_UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
// One upload button for both media kinds: an uploaded audio file becomes a waveform video,
// so it occupies a VIDEO reference slot and shares that cap -- a separate audio button would
// grey out with this one. The wildcards cover the ordinary case; the explicit extensions
// (mirroring the upload route's accepted lists) are what match a file whose type the OS
// could not map, which the browser then offers as octet-stream.
const MEDIA_UPLOAD_ACCEPT = [
  'video/*',
  'audio/*',
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  '.mpg',
  '.mpeg',
  '.3gp',
  '.wmv',
  '.asf',
  '.mp3',
  '.m4a',
  '.aac',
  '.wav',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.aiff',
  '.aif',
  '.wma',
].join(',');
const DROP_ZONE_FOCUS_PROPS = {
  outlineColor: 'accent.focusRing',
  outlineOffset: '2px',
  outlineStyle: 'solid',
  outlineWidth: '2px',
};
const DROP_ZONE_DISABLED_PROPS = { cursor: 'not-allowed', opacity: 0.6 };
const DROP_ZONE_BUSY_PROPS = { disabled: true };
const ACCEPT_MEDIA = ['image', 'video'] as const;

const getSingleGalleryDragItem = (data: unknown): { kind: 'image' | 'video'; name: string } | null => {
  if (!isGalleryItemDragData(data) || data.items.length !== 1) {
    return null;
  }

  const item = data.items[0];

  return item && (item.kind === 'image' || item.kind === 'video') ? { kind: item.kind, name: item.name } : null;
};

type ReferenceCollections = {
  /** The anchor's options: 'Audio only' is absent, see `anchorReferenceConditioning`. */
  anchorConditioning: ReturnType<typeof createListCollection<{ label: string; value: string }>>;
  conditioning: ReturnType<typeof createListCollection<{ label: string; value: string }>>;
  detail: ReturnType<typeof createListCollection<{ label: string; value: string }>>;
};

const ReferenceCard = memo(function ReferenceCard({
  collections,
  disabled,
  index,
  canMoveDown,
  canMoveUp,
  onMove,
  onRemove,
  onUpdate,
  reference,
  targetArea,
}: {
  collections: ReferenceCollections;
  disabled: boolean;
  index: number;
  canMoveDown: boolean;
  canMoveUp: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, reference: VideoReferenceItem) => void;
  reference: VideoReferenceItem;
  /** The generation's pixel area, which is what 'match' detail scales an image to. */
  targetArea: number | null;
}) {
  const { t } = useTranslation();
  const moveUpRef = useRef<HTMLButtonElement>(null);
  const moveDownRef = useRef<HTMLButtonElement>(null);
  const name = reference.kind === 'video' ? reference.clip.video_name : reference.image.image_name;
  const selectValue = useMemo(
    () => [reference.kind === 'video' ? reference.conditioning : reference.detail],
    [reference]
  );
  const selectCollection = useMemo(() => {
    if (reference.kind !== 'video') {
      return collections.detail;
    }

    // The anchor is not offered 'Audio only': it is the reference the extension continues
    // FROM, and an audio-only one contributes no visual rows to continue from.
    return reference.fromSourceVideo === true ? collections.anchorConditioning : collections.conditioning;
  }, [collections, reference]);
  const handleSelect = useCallback(
    (details: { value: string[] }) => {
      const value = details.value[0];

      if (!value) {
        return;
      }
      if (reference.kind === 'video') {
        onUpdate(index, { ...reference, conditioning: value as VideoReferenceConditioning });
      } else {
        onUpdate(index, { ...reference, detail: value as VideoReferenceImageDetail });
      }
    },
    [index, onUpdate, reference]
  );
  // The trim is presented as a sliding sample window — start frame plus length — because
  // what the user is choosing is "how much" (every reference frame costs denoise VRAM) and
  // "from where". Storage stays startFrame/endFrame (the request contract); the window
  // math (constant-length slide that stops at the clip's end, and the extend anchor's
  // pinned-to-the-cutpoint end) lives in core/settings.
  const handleStartFrame = useCallback(
    (rawStart: number) => {
      if (reference.kind === 'video') {
        onUpdate(index, {
          ...reference,
          clip: slideReferenceSampleWindow(reference.clip, rawStart, reference.fromSourceVideo === true),
        });
      }
    },
    [index, onUpdate, reference]
  );
  const handleSampleFrames = useCallback(
    (rawSampleFrames: number) => {
      if (reference.kind === 'video') {
        onUpdate(index, {
          ...reference,
          clip: resizeReferenceSampleWindow(reference.clip, rawSampleFrames, reference.fromSourceVideo === true),
        });
      }
    },
    [index, onUpdate, reference]
  );
  // What this reference will actually cost, at the size the graph will encode it: the two
  // detail settings differ by an order of magnitude in rows, and nothing else in the panel
  // says so before the generation is queued.
  const imageCost = useMemo(
    () =>
      reference.kind === 'image'
        ? resolveMiniMaxH3ReferenceImage(reference.image.width, reference.image.height, reference.detail, targetArea)
        : null,
    [reference, targetArea]
  );
  // The window's length, and the seconds it represents — the label carries the seconds
  // because the control is how a user hits a target sample duration (reference frames cost
  // denoise VRAM every step), while its unit has to stay frames to match the trim contract.
  const sampleFrames = reference.kind === 'video' ? reference.clip.endFrame - reference.clip.startFrame + 1 : 0;
  const sampleSeconds =
    reference.kind === 'video' && Number.isFinite(reference.clip.fps) && reference.clip.fps > 0
      ? (sampleFrames / reference.clip.fps).toFixed(1)
      : null;
  // A move that lands on an end -- the top of the stack, or the slot above the
  // pinned continuity anchor -- disables the very button that was just pressed,
  // and a disabled element cannot hold focus, so a keyboard user is dropped to
  // <body> mid-gesture. Which button that is depends on the anchor rule, so the
  // handoff reacts to what actually came back disabled rather than predicting
  // it. It is armed only when the arrow ALREADY holds focus, because pressing a
  // button does not focus it in every browser (Safari, Firefox on macOS): a
  // pointer press there runs this handler with the caret still in the prompt,
  // and moving focus would haul the user out of what they were typing.
  const pendingFocusRef = useRef<'down' | 'up' | null>(null);
  const handleMoveUp = useCallback(() => {
    const arrow = moveUpRef.current;

    pendingFocusRef.current = arrow !== null && document.activeElement === arrow ? 'up' : null;
    onMove(index, -1);
  }, [index, onMove]);
  const handleMoveDown = useCallback(() => {
    const arrow = moveDownRef.current;

    pendingFocusRef.current = arrow !== null && document.activeElement === arrow ? 'down' : null;
    onMove(index, 1);
  }, [index, onMove]);

  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;

    if (pending === null) {
      return;
    }
    pendingFocusRef.current = null;

    const pressed = pending === 'up' ? moveUpRef.current : moveDownRef.current;
    const sibling = pending === 'up' ? moveDownRef.current : moveUpRef.current;
    // Hand off only the focus this card is responsible for losing. Disabling a
    // focused button blurs it to <body>, so that -- or focus still sitting on
    // the arrow -- is the whole set of states worth repairing. Anywhere else and
    // the user has moved on since, which happens whenever the write did not land
    // in this commit: `setReferences` drops writes from a panel that is no
    // longer live, and `memo` then keeps this card from rendering at all, so the
    // arm survives to a later render that has nothing to do with the gesture.
    const isOursToRestore = document.activeElement === document.body || document.activeElement === pressed;

    if (isOursToRestore && pressed?.disabled === true && sibling !== null && !sibling.disabled) {
      sibling.focus();
    }
  });
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);

  return (
    <Box borderWidth="1px" p="2" rounded="md">
      <HStack align="start" gap="2">
        <Badge fontVariantNumeric="tabular-nums" size="xs" variant="solid">
          {index + 1}
        </Badge>
        {reference.kind === 'image' ? (
          <Box bg="blackAlpha.300" flexShrink={0} h="12" overflow="hidden" rounded="sm" w="16">
            <Image alt="" fit="cover" h="100%" src={galleryImageUrls.thumbnail(name)} w="100%" />
          </Box>
        ) : null}
        <Stack flex="1" gap="1" minW="0">
          <HStack gap="1">
            {reference.kind === 'video' ? <FilmIcon size={12} /> : <ImagePlusIcon size={12} />}
            <MiddleTruncate flex="1" fontSize="xs" text={name} />
            {reference.kind === 'video' && reference.fromSourceVideo === true ? (
              <Badge flexShrink={0} size="xs" variant="outline">
                {t('widgets.video.referenceFromInitialVideo')}
              </Badge>
            ) : null}
          </HStack>
          <Select
            collection={selectCollection}
            disabled={disabled}
            size="xs"
            value={selectValue}
            onValueChange={handleSelect}
          />
          {imageCost ? (
            <Text color="fg.muted" fontSize="2xs" fontVariantNumeric="tabular-nums">
              {t('widgets.video.referenceImageCost', {
                height: imageCost.dimensions.height,
                rows: imageCost.rows.toLocaleString(),
                width: imageCost.dimensions.width,
              })}
            </Text>
          ) : null}
          {/* One row per window edge: the live frame at left, its control at right. The
              seeking thumbs replace the static gallery poster for video references — the
              start-frame thumb is the card's visual identity. The second row's SLIDER is
              the sample length (the quantity that costs VRAM); its THUMB still shows the
              resulting end frame, badged with that frame number since the number field
              beside it shows the length, not the frame. */}
          {reference.kind === 'video' ? (
            <Stack gap="1">
              <HStack gap="2">
                <TrimBoundThumb
                  fps={reference.clip.fps}
                  frame={reference.clip.startFrame}
                  label={t('widgets.video.trimStartShort')}
                  src={galleryVideoUrls.full(name)}
                />
                <Stack flex="1" gap="0.5" minW="0">
                  <FieldLabel>{t('widgets.video.trimStart')}</FieldLabel>
                  <SliderNumberField
                    ariaLabel={t('widgets.video.trimStart')}
                    disabled={disabled}
                    max={Math.max(0, reference.clip.numFrames - 1)}
                    min={0}
                    showStepper
                    step={1}
                    value={reference.clip.startFrame}
                    onChange={handleStartFrame}
                  />
                </Stack>
              </HStack>
              <HStack gap="2">
                <TrimBoundThumb
                  fps={reference.clip.fps}
                  frame={reference.clip.endFrame}
                  label={`${t('widgets.video.trimEndShort')} · ${reference.clip.endFrame}`}
                  src={galleryVideoUrls.full(name)}
                />
                <Stack flex="1" gap="0.5" minW="0">
                  <FieldLabel>
                    {sampleSeconds === null
                      ? t('widgets.video.sampleLength')
                      : t('widgets.video.sampleLengthWithSeconds', { seconds: sampleSeconds })}
                  </FieldLabel>
                  <SliderNumberField
                    ariaLabel={t('widgets.video.sampleLength')}
                    disabled={disabled}
                    // The anchor grows backward from its pinned end, so its ceiling is the
                    // available lead-in; ordinary windows grow forward from their start.
                    max={
                      reference.fromSourceVideo === true
                        ? Math.max(1, reference.clip.endFrame + 1)
                        : Math.max(1, reference.clip.numFrames - reference.clip.startFrame)
                    }
                    min={1}
                    showStepper
                    step={1}
                    value={sampleFrames}
                    onChange={handleSampleFrames}
                  />
                </Stack>
              </HStack>
            </Stack>
          ) : null}
        </Stack>
        <Stack gap="0">
          <IconButton
            ref={moveUpRef}
            aria-label={t('widgets.video.moveReferenceUp')}
            disabled={disabled || !canMoveUp}
            size="2xs"
            variant="ghost"
            onClick={handleMoveUp}
          >
            <ArrowUpIcon size={12} />
          </IconButton>
          <IconButton
            ref={moveDownRef}
            aria-label={t('widgets.video.moveReferenceDown')}
            disabled={disabled || !canMoveDown}
            size="2xs"
            variant="ghost"
            onClick={handleMoveDown}
          >
            <ArrowDownIcon size={12} />
          </IconButton>
          <IconButton
            aria-label={t('widgets.video.removeReference')}
            disabled={disabled}
            size="2xs"
            variant="ghost"
            onClick={handleRemove}
          >
            <XIcon size={12} />
          </IconButton>
        </Stack>
      </HStack>
    </Box>
  );
});

export const VideoReferenceListField = memo(function VideoReferenceListField({
  disabled = false,
  maxImages,
  maxVideos,
  onChange,
  references,
  targetArea,
}: {
  disabled?: boolean;
  maxImages: number;
  maxVideos: number;
  /**
   * Accepts an UPDATER, not a snapshot. The add handlers `await` a gallery
   * resolve before writing, and the Initial Video field and Frames slider both
   * write references too -- a captured array would clobber whichever of those
   * landed during the await.
   */
  onChange: (update: (current: VideoReferenceItem[]) => VideoReferenceItem[]) => void;
  references: VideoReferenceItem[];
  /** The generation's pixel area, which sizes a 'match'-detail image reference. */
  targetArea: number | null;
}) {
  const { t } = useTranslation();
  const { getUploadBoardId, reportError, touchGalleryImages } = useVideoUiActions();
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The continuity anchor is pinned last, so any move that would displace it is
  // reverted the moment it is written -- the button fired a patch and the list
  // came back unchanged. Present those as disabled rather than inert.
  const anchorIndex = references.findIndex(
    (reference) => reference.kind === 'video' && reference.fromSourceVideo === true
  );
  const videoCount = references.filter((reference) => reference.kind === 'video').length;
  const imageCount = references.length - videoCount;
  const canAddVideo = videoCount < maxVideos;
  const canAddImage = imageCount < maxImages;
  const isInert = disabled || isLoading;

  const { active } = useDndContext();
  const activeDragItem = getSingleGalleryDragItem(active?.data.current);
  const acceptsActiveDrag =
    !isInert && activeDragItem !== null && (activeDragItem.kind === 'video' ? canAddVideo : canAddImage);
  const { isOver, setNodeRef } = useDroppable({ disabled: !acceptsActiveDrag, id: DROP_ID });

  const conditioningItems = useMemo(
    () => [
      { label: t('widgets.video.referenceConditioningVideoAudio'), value: 'video_audio' },
      { label: t('widgets.video.referenceConditioningVideo'), value: 'video' },
      { label: t('widgets.video.referenceConditioningAudio'), value: 'audio' },
    ],
    [t]
  );
  const conditioningCollection = useMemo(() => createListCollection({ items: conditioningItems }), [conditioningItems]);
  const anchorConditioningCollection = useMemo(
    () => createListCollection({ items: conditioningItems.filter((item) => item.value !== 'audio') }),
    [conditioningItems]
  );
  const detailCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: t('widgets.video.referenceDetailMax'), value: 'max' },
          { label: t('widgets.video.referenceDetailMatch'), value: 'match' },
        ],
      }),
    [t]
  );
  const collections = useMemo(
    () => ({
      anchorConditioning: anchorConditioningCollection,
      conditioning: conditioningCollection,
      detail: detailCollection,
    }),
    [anchorConditioningCollection, conditioningCollection, detailCollection]
  );
  const handlePickImage = useCallback(() => imageInputRef.current?.click(), []);
  const handlePickVideo = useCallback(() => videoInputRef.current?.click(), []);

  const addImageReference = useCallback(
    (image: { height: number; name: string; width: number }) => {
      setErrorMessage(null);

      // Re-check the cap against the LIVE list: the render-time gate can be
      // stale by the time a drop resolves or an upload lands, and another
      // writer (a second drop, the Initial Video placing its anchor) can fill
      // the slots meanwhile. An over-cap write would survive to normalization,
      // whose overflow rule then has to delete SOMETHING the user placed.
      let declined = false;

      onChange((current) => {
        if (current.filter((entry) => entry.kind === 'image').length >= maxImages) {
          declined = true;

          return current;
        }

        return [
          ...current,
          {
            // Read off the LIVE list, beside the cap re-check: which default applies
            // depends on whether an image reference is already placed, and another
            // writer can have placed one while this add was in flight.
            detail: getDefaultReferenceImageDetail(current),
            image: { height: image.height, image_name: image.name, width: image.width },
            kind: 'image',
          },
        ];
      });
      if (declined) {
        setErrorMessage(t('widgets.video.referenceImageCapRace', { max: maxImages }));
      }
    },
    [maxImages, onChange, t]
  );

  const adoptImageByName = useCallback(
    async (imageName: string) => {
      setIsLoading(true);

      try {
        const item = await galleryItems.resolve({ kind: 'image', name: imageName });

        if (item?.kind === 'image') {
          addImageReference(item);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        reportError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [addImageReference, reportError]
  );

  const addVideoItem = useCallback(
    // The conditioning is passed in rather than derived here: only a caller holding the
    // clip's metadata can tell a wrapped audio upload from footage. Callers without it get
    // the ordinary video default -- and the entry back, so a late answer can correct it.
    (item: GalleryVideoItem, conditioning: VideoReferenceConditioning = 'video_audio') => {
      const clip = createVideoSourceClip(item);
      // Built outside the updater so the caller holds the same object the list does: it is
      // the only durable handle on this entry once reordering moves it.
      const entry: Extract<VideoReferenceItem, { kind: 'video' }> = {
        // The window depends on the conditioning -- a short sample of footage, the whole
        // clip of a soundtrack. (Neither is the extend-mode 2-frame-tail trim: references
        // are truncated to the generated duration, not joined.)
        clip: getDefaultReferenceClip(clip, conditioning),
        conditioning,
        kind: 'video',
      };
      // Same live cap re-check as the image path -- the Initial Video's
      // anchor is the writer that most easily fills the slots mid-await.
      let declined = false;

      setErrorMessage(null);
      onChange((current) => {
        if (current.filter((existing) => existing.kind === 'video').length >= maxVideos) {
          declined = true;

          return current;
        }

        return [...current, entry];
      });
      if (declined) {
        setErrorMessage(t('widgets.video.referenceVideoCapRace', { max: maxVideos }));

        return null;
      }

      return entry;
    },
    [maxVideos, onChange, t]
  );

  const addVideoReference = useCallback(
    async (videoName: string) => {
      setErrorMessage(null);
      setIsLoading(true);

      try {
        // Fetched alongside the resolve, not after it: the metadata only picks the
        // card's starting conditioning, and it must not add a round trip to the add.
        // A missing or unreadable record is not a failure -- it just means the
        // ordinary video default.
        const [item, metadata] = await Promise.all([
          galleryItems.resolve({ kind: 'video', name: videoName }),
          galleryVideos.metadata(videoName).catch(() => null),
        ]);

        if (item?.kind === 'video') {
          addVideoItem(item, getDefaultReferenceConditioning(metadata));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        reportError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [addVideoItem, reportError]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const item = getSingleGalleryDragItem(event.active.data.current);

      if (isInert || event.over?.id !== DROP_ID || !item) {
        return;
      }
      if (item.kind === 'video' && canAddVideo) {
        void addVideoReference(item.name);
      } else if (item.kind === 'image' && canAddImage) {
        void adoptImageByName(item.name);
      }
    },
    [adoptImageByName, addVideoReference, canAddImage, canAddVideo, isInert]
  );

  useDndMonitor({ onDragEnd: handleDragEnd });

  const uploadFile = useCallback(
    async (file: File, kind: 'image' | 'video') => {
      setErrorMessage(null);
      const owner = captureAccountScope();
      setIsLoading(true);

      try {
        if (kind === 'video') {
          const uploaded = await galleryTransfers.uploadVideo(file, getUploadBoardId(), { signal: owner.signal });

          assertAccountScopeCurrent(owner);
          await addVideoReference(uploaded.name);
        } else {
          const uploaded = await galleryTransfers.upload(file, getUploadBoardId(), { signal: owner.signal });

          assertAccountScopeCurrent(owner);
          addImageReference({ height: uploaded.height, name: uploaded.imageName, width: uploaded.width });
        }
        touchGalleryImages();
      } catch (error) {
        if (!isAccountScopeCurrent(owner)) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        reportError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [addImageReference, addVideoReference, getUploadBoardId, reportError, touchGalleryImages]
  );

  const handleImageFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];

      if (file) {
        void uploadFile(file, 'image');
      }
      event.currentTarget.value = '';
    },
    [uploadFile]
  );
  const handleVideoFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];

      if (file) {
        void uploadFile(file, 'video');
      }
      event.currentTarget.value = '';
    },
    [uploadFile]
  );

  const pickerSelection = useMemo<GalleryPickerSelection>(
    () => ({
      addedKeys: new Set(
        references.map((reference) =>
          reference.kind === 'video'
            ? toGalleryItemKey({ kind: 'video', name: reference.clip.video_name })
            : toGalleryItemKey({ kind: 'image', name: reference.image.image_name })
        )
      ),
      mode: 'multiple',
      remaining: { image: Math.max(0, maxImages - imageCount), video: Math.max(0, maxVideos - videoCount) },
    }),
    [imageCount, maxImages, maxVideos, references, videoCount]
  );
  const addPickedVideo = useCallback(
    (item: GalleryVideoItem) => {
      // The card goes in SYNCHRONOUSLY and is corrected afterwards, rather than waiting on
      // the metadata the way the drop and upload paths do. The picker stays open and judges
      // each click against the reference list as it stands -- an add that had not landed yet
      // would leave the tile pickable (a second click would duplicate it), leave the
      // remaining count stale, and let two picks land in whichever order their fetches
      // finished, which for references is a different generation.
      const entry = addVideoItem(item);

      if (!entry) {
        return;
      }

      // The metadata is the only thing that tells a wrapped audio upload from footage. An
      // unreadable record is not a failure -- the ordinary video default just stands.
      void galleryVideos
        .metadata(item.name)
        .then((metadata) => {
          const conditioning = getDefaultReferenceConditioning(metadata);

          if (conditioning === entry.conditioning) {
            return;
          }
          // The window is re-derived with the conditioning, not carried over: this path adds
          // BEFORE it knows the answer, so the card is holding the footage default, and
          // leaving it would give a picked soundtrack a shorter window than the same clip
          // dropped or uploaded. Safe to recompute -- the identity match below already
          // establishes that the window is still the one this code chose.
          //
          // Matched by identity, not index: a card the user has since edited is a different
          // object and keeps their choice, and a removed one is simply no longer there.
          onChange((current) =>
            current.map((existing) =>
              existing === entry
                ? { ...entry, clip: getDefaultReferenceClip(entry.clip, conditioning), conditioning }
                : existing
            )
          );
        })
        .catch(() => undefined);
    },
    [addVideoItem, onChange]
  );
  const handlePick = useCallback(
    (item: GalleryItem) => {
      if (item.kind === 'video') {
        addPickedVideo(item);
      } else {
        addImageReference(item);
      }
    },
    [addImageReference, addPickedVideo]
  );

  const updateReference = useCallback(
    (index: number, reference: VideoReferenceItem) => {
      onChange((current) => current.map((entry, entryIndex) => (entryIndex === index ? reference : entry)));
    },
    [onChange]
  );
  const removeReference = useCallback(
    (index: number) => {
      onChange((current) => current.filter((_, entryIndex) => entryIndex !== index));
    },
    [onChange]
  );
  // Identity for the list, and it must NOT contain the index: an index-bearing key
  // changes for every card a reorder touches, so React unmounts and remounts them --
  // reloading a video reference's seeking trim thumbnails and throwing away keyboard
  // focus on the arrow just pressed. Media can legitimately appear twice (the same
  // clip sampled over two different windows), so a bare name is not unique either; it
  // is disambiguated by how many entries of the same kind and name precede it.
  //
  // That makes a card stable against every move EXCEPT a swap with its own twin,
  // where the two occurrence numbers trade places and React swaps the props between
  // the instances instead of moving one. Rendering stays correct; the cards simply do
  // not travel. Giving twins independent identity needs a per-entry uid minted on add
  // and carried through normalization, which the persisted reference shape has no
  // room for today.
  const referenceKeys = useMemo(() => {
    const seen = new Map<string, number>();

    return references.map((reference) => {
      const name = reference.kind === 'video' ? reference.clip.video_name : reference.image.image_name;
      // Kind is part of the identity, matching `toGalleryItemKey`: an image and a
      // video are different references even where a backend gives them one name.
      const identity = `${reference.kind}:${name}`;
      const occurrence = seen.get(identity) ?? 0;

      seen.set(identity, occurrence + 1);

      return `${identity}-${occurrence}`;
    });
  }, [references]);

  const moveReference = useCallback(
    (index: number, direction: -1 | 1) => {
      onChange((current) => {
        const target = index + direction;

        if (target < 0 || target >= current.length) {
          return current;
        }
        const next = [...current];
        const [entry] = next.splice(index, 1);

        if (!entry) {
          return current;
        }
        next.splice(target, 0, entry);

        return next;
      });
    },
    [onChange]
  );

  return (
    <Stack gap="2">
      {references.map((reference, index) => (
        <ReferenceCard
          key={referenceKeys[index]}
          collections={collections}
          disabled={isInert}
          index={index}
          canMoveDown={index < references.length - 1 && index + 1 !== anchorIndex}
          canMoveUp={index > 0 && index !== anchorIndex}
          reference={reference}
          targetArea={targetArea}
          onMove={moveReference}
          onRemove={removeReference}
          onUpdate={updateReference}
        />
      ))}

      <Field helpText={t('widgets.video.referencesHelp')} label={t('widgets.video.addReference')}>
        <DropZone
          ref={setNodeRef}
          {...(isInert ? DROP_ZONE_DISABLED_PROPS : {})}
          {...(isLoading ? DROP_ZONE_BUSY_PROPS : {})}
          isDisabled={isInert}
          isOver={isOver && acceptsActiveDrag}
          _focusVisible={DROP_ZONE_FOCUS_PROPS}
          position="relative"
        >
          <Stack gap="1.5" p="2">
            <GalleryPickerPopover
              accept={ACCEPT_MEDIA}
              label={t('widgets.video.chooseReference')}
              selection={pickerSelection}
              onPick={handlePick}
            >
              <Button disabled={isInert || (!canAddImage && !canAddVideo)} size="xs" variant="outline" w="full">
                {isLoading ? <Spinner size="xs" /> : <Icon as={ImagePlusIcon} boxSize="3.5" />}
                {t('widgets.video.chooseReference')}
                <Icon as={ChevronDownIcon} boxSize="3" color="fg.subtle" />
              </Button>
            </GalleryPickerPopover>
            <HStack gap="1" justify="center">
              <Button disabled={isInert || !canAddImage} size="xs" variant="ghost" onClick={handlePickImage}>
                <UploadIcon size={12} />
                {t('widgets.video.uploadImageReference')}
              </Button>
              <Button disabled={isInert || !canAddVideo} size="xs" variant="ghost" onClick={handlePickVideo}>
                <UploadIcon size={12} />
                {t('widgets.video.uploadVideoReference')}
              </Button>
            </HStack>
          </Stack>
          <DropTargetOverlay isActive={acceptsActiveDrag} isOver={isOver} label={t('widgets.video.dropReference')} />
        </DropZone>
      </Field>
      {errorMessage ? (
        <Text color="fg.error" fontSize="xs">
          {errorMessage}
        </Text>
      ) : null}
      <Input accept={IMAGE_UPLOAD_ACCEPT} hidden ref={imageInputRef} type="file" onChange={handleImageFileChange} />
      {/* Audio files upload too: the server wraps them into waveform videos, which is
          how audio-only reference clips enter the pipeline. */}
      <Input accept={MEDIA_UPLOAD_ACCEPT} hidden ref={videoInputRef} type="file" onChange={handleVideoFileChange} />
    </Stack>
  );
});
