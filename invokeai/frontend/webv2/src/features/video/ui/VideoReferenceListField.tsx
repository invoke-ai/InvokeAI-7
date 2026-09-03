import type { DragEndEvent } from '@dnd-kit/core';
import type {
  VideoReferenceConditioning,
  VideoReferenceImageDetail,
  VideoReferenceItem,
} from '@features/video/core/types';
import type { ChangeEvent } from 'react';

import { Badge, Box, createListCollection, HStack, Image, Input, Spinner, Stack, Text } from '@chakra-ui/react';
import { useDndContext, useDndMonitor, useDroppable } from '@dnd-kit/core';
import { galleryImages, galleryItems, galleryTransfers, galleryVideos } from '@features/gallery';
import { galleryImageUrls, galleryVideoUrls, isGalleryItemDragData } from '@features/gallery/utility';
import { createVideoSourceClip, getDefaultReferenceConditioning } from '@features/video/core/settings';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { Button, IconButton } from '@platform/ui/Button';
import { DropTargetOverlay } from '@platform/ui/DropTargetOverlay';
import { DropZone } from '@platform/ui/DropZone';
import { Field } from '@platform/ui/Field';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { Select } from '@platform/ui/Select';
import { SliderNumberField } from '@platform/ui/SliderNumberField';
import { ArrowDownIcon, ArrowUpIcon, FilmIcon, ImagePlusIcon, XIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
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
// One picker for both media kinds: an uploaded audio file becomes a waveform video, so it
// occupies a VIDEO reference slot and shares that cap -- a separate audio button would
// carry the same counter and grey out with it. The wildcards cover the ordinary case; the
// explicit extensions (mirroring the upload route's accepted lists) are what match a file
// whose type the OS could not map, which the browser then offers as octet-stream.
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
const DROP_ZONE_HOVER_PROPS = { bg: 'bg.muted', color: 'fg' };

const getSingleGalleryDragItem = (data: unknown): { kind: 'image' | 'video'; name: string } | null => {
  if (!isGalleryItemDragData(data) || data.items.length !== 1) {
    return null;
  }

  const item = data.items[0];

  return item && (item.kind === 'image' || item.kind === 'video') ? { kind: item.kind, name: item.name } : null;
};

type ReferenceCollections = {
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
}) {
  const { t } = useTranslation();
  const name = reference.kind === 'video' ? reference.clip.video_name : reference.image.image_name;
  const selectValue = useMemo(
    () => [reference.kind === 'video' ? reference.conditioning : reference.detail],
    [reference]
  );
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
  const handleStartFrame = useCallback(
    (startFrame: number) => {
      if (reference.kind === 'video') {
        onUpdate(index, {
          ...reference,
          clip: { ...reference.clip, endFrame: Math.max(startFrame, reference.clip.endFrame), startFrame },
        });
      }
    },
    [index, onUpdate, reference]
  );
  const handleEndFrame = useCallback(
    (endFrame: number) => {
      if (reference.kind === 'video') {
        onUpdate(index, {
          ...reference,
          clip: { ...reference.clip, endFrame, startFrame: Math.min(reference.clip.startFrame, endFrame) },
        });
      }
    },
    [index, onUpdate, reference]
  );
  const handleMoveUp = useCallback(() => onMove(index, -1), [index, onMove]);
  const handleMoveDown = useCallback(() => onMove(index, 1), [index, onMove]);
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
            collection={reference.kind === 'video' ? collections.conditioning : collections.detail}
            disabled={disabled}
            size="xs"
            value={selectValue}
            onValueChange={handleSelect}
          />
          {/* One row per trim bound: the bound's live frame at left, its slider at
              right. The seeking thumbs replace the static gallery poster for video
              references — the start-frame thumb is the card's visual identity. */}
          {reference.kind === 'video' ? (
            <Stack gap="1">
              <HStack gap="2">
                <TrimBoundThumb
                  fps={reference.clip.fps}
                  frame={reference.clip.startFrame}
                  label={t('widgets.video.trimStartShort')}
                  src={galleryVideoUrls.full(name)}
                />
                <Box flex="1" minW="0">
                  <SliderNumberField
                    ariaLabel={t('widgets.video.trimStart')}
                    disabled={disabled}
                    max={Math.max(0, reference.clip.numFrames - 1)}
                    min={0}
                    step={1}
                    value={reference.clip.startFrame}
                    onChange={handleStartFrame}
                  />
                </Box>
              </HStack>
              <HStack gap="2">
                <TrimBoundThumb
                  fps={reference.clip.fps}
                  frame={reference.clip.endFrame}
                  label={t('widgets.video.trimEndShort')}
                  src={galleryVideoUrls.full(name)}
                />
                <Box flex="1" minW="0">
                  <SliderNumberField
                    ariaLabel={t('widgets.video.trimEnd')}
                    disabled={disabled}
                    max={Math.max(0, reference.clip.numFrames - 1)}
                    min={0}
                    step={1}
                    value={reference.clip.endFrame}
                    onChange={handleEndFrame}
                  />
                </Box>
              </HStack>
            </Stack>
          ) : null}
        </Stack>
        <Stack gap="0">
          <IconButton
            aria-label={t('widgets.video.moveReferenceUp')}
            disabled={disabled || !canMoveUp}
            size="2xs"
            variant="ghost"
            onClick={handleMoveUp}
          >
            <ArrowUpIcon size={12} />
          </IconButton>
          <IconButton
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

  const conditioningCollection = useMemo(
    () =>
      createListCollection({
        items: [
          { label: t('widgets.video.referenceConditioningVideoAudio'), value: 'video_audio' },
          { label: t('widgets.video.referenceConditioningVideo'), value: 'video' },
          { label: t('widgets.video.referenceConditioningAudio'), value: 'audio' },
        ],
      }),
    [t]
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
    () => ({ conditioning: conditioningCollection, detail: detailCollection }),
    [conditioningCollection, detailCollection]
  );
  const handlePickImage = useCallback(() => imageInputRef.current?.click(), []);
  const handlePickVideo = useCallback(() => videoInputRef.current?.click(), []);

  const addImageReference = useCallback(
    async (imageName: string) => {
      setErrorMessage(null);
      setIsLoading(true);

      try {
        const [resolved] = await galleryImages.resolveMany([imageName]);

        if (resolved) {
          // Re-check the cap against the LIVE list: the render-time gate was
          // evaluated before the await, and another writer (a second drop, or
          // the Initial Video placing its anchor) can fill the slots meanwhile.
          // An over-cap write would survive to normalization, whose overflow
          // rule then has to delete SOMETHING the user placed.
          let declined = false;

          onChange((current) => {
            if (current.filter((entry) => entry.kind === 'image').length >= maxImages) {
              declined = true;

              return current;
            }

            return [
              ...current,
              {
                detail: 'max',
                image: { height: resolved.height, image_name: resolved.imageName, width: resolved.width },
                kind: 'image',
              },
            ];
          });
          if (declined) {
            setErrorMessage(t('widgets.video.referenceImageCapRace', { max: maxImages }));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        reportError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [maxImages, onChange, reportError, t]
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
          const clip = createVideoSourceClip({
            durationSeconds: item.durationSeconds,
            fps: item.fps,
            height: item.height,
            name: item.name,
            width: item.width,
          });

          // Same live cap re-check as the image path -- the Initial Video's
          // anchor is the writer that most easily fills the slots mid-await.
          let declined = false;

          onChange((current) => {
            if (current.filter((entry) => entry.kind === 'video').length >= maxVideos) {
              declined = true;

              return current;
            }

            return [
              ...current,
              {
                // References are truncated to the generated duration, not joined: default to
                // the whole clip rather than the extend-mode 2-frame-tail trim.
                clip: { ...clip, endFrame: Math.max(0, clip.numFrames - 1), startFrame: 0 },
                conditioning: getDefaultReferenceConditioning(metadata),
                kind: 'video',
              },
            ];
          });
          if (declined) {
            setErrorMessage(t('widgets.video.referenceVideoCapRace', { max: maxVideos }));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setErrorMessage(message);
        reportError(message);
      } finally {
        setIsLoading(false);
      }
    },
    [maxVideos, onChange, reportError, t]
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
        void addImageReference(item.name);
      }
    },
    [addImageReference, addVideoReference, canAddImage, canAddVideo, isInert]
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
          await addImageReference(uploaded.imageName);
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
          key={`${reference.kind === 'video' ? reference.clip.video_name : reference.image.image_name}-${index}`}
          collections={collections}
          disabled={isInert}
          index={index}
          canMoveDown={index < references.length - 1 && index + 1 !== anchorIndex}
          canMoveUp={index > 0 && index !== anchorIndex}
          reference={reference}
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
          {...(isOver && acceptsActiveDrag ? DROP_ZONE_HOVER_PROPS : {})}
          _focusVisible={DROP_ZONE_FOCUS_PROPS}
          position="relative"
        >
          <HStack gap="2" justify="center" p="2">
            {isLoading ? <Spinner size="xs" /> : null}
            <Button disabled={isInert || !canAddImage} size="xs" variant="outline" onClick={handlePickImage}>
              <ImagePlusIcon size={12} />
              {t('widgets.video.addImageReference', { count: imageCount, max: maxImages })}
            </Button>
            <Button disabled={isInert || !canAddVideo} size="xs" variant="outline" onClick={handlePickVideo}>
              <FilmIcon size={12} />
              {t('widgets.video.addVideoReference', { count: videoCount, max: maxVideos })}
            </Button>
          </HStack>
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
