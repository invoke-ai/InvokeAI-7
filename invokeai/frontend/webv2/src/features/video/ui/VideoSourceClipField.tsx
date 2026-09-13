import type { DragEndEvent } from '@dnd-kit/core';
import type { VideoSourceClip } from '@features/video/core/types';
import type { ChangeEvent } from 'react';

import { Box, HStack, Icon, Input, Spinner, Stack, Text } from '@chakra-ui/react';
import { useDndContext, useDndMonitor, useDroppable } from '@dnd-kit/core';
import { galleryItems, galleryTransfers, type GalleryItem } from '@features/gallery';
import { GalleryPickerPopover } from '@features/gallery/picker';
import { galleryVideoUrls, isGalleryItemDragData } from '@features/gallery/utility';
import { createVideoSourceClip } from '@features/video/core/settings';
import {
  assertAccountScopeCurrent,
  captureAccountScope,
  isAccountScopeCurrent,
} from '@platform/state/accountLifecycle';
import { Field } from '@platform/ui';
import { Button } from '@platform/ui/Button';
import { DropTargetOverlay } from '@platform/ui/DropTargetOverlay';
import { DropZone } from '@platform/ui/DropZone';
import { MiddleTruncate } from '@platform/ui/MiddleTruncate';
import { SliderNumberField } from '@platform/ui/SliderNumberField';
import { ChevronDownIcon, FilmIcon, UploadIcon, XIcon } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PlayClipSpanButton } from './PlayClipSpanButton';
import { TrimBoundThumb } from './TrimBoundThumb';
import { useVideoUiActions } from './VideoUiContext';

/**
 * The clip to extend: gallery drop target, file upload, and the trim bounds —
 * one compact row per bound, the bound's live frame at left and its slider at
 * right (see TrimBoundThumb for the seek technique). The rows are the only
 * preview; the drop zone itself is a slim header with the clip's identity.
 */

const DROP_ID = 'video-source-clip';
const VIDEO_ONLY = ['video'] as const;
const DROP_ZONE_FOCUS_PROPS = {
  outlineColor: 'accent.focusRing',
  outlineOffset: '2px',
  outlineStyle: 'solid',
  outlineWidth: '2px',
};
const DROP_ZONE_DISABLED_PROPS = { cursor: 'not-allowed', opacity: 0.6 };
const DROP_ZONE_HOVER_PROPS = { bg: 'bg.muted', color: 'fg' };

const getSingleVideoDragName = (data: unknown): string | null => {
  if (!isGalleryItemDragData(data) || data.items.length !== 1) {
    return null;
  }

  const item = data.items[0];

  return item?.kind === 'video' ? item.name : null;
};

const areSourceClipsEquivalent = (left: VideoSourceClip | null, right: VideoSourceClip | null): boolean =>
  (left === null && right === null) ||
  (left?.video_name === right?.video_name &&
    left?.startFrame === right?.startFrame &&
    left?.endFrame === right?.endFrame &&
    // The bound thumbnails seek at frame/fps, so a same-name clip hydrated
    // with a different probed rate must re-render.
    left?.fps === right?.fps);

export const VideoSourceClipField = memo(
  function VideoSourceClipField({
    disabled = false,
    disabledReason,
    onChange,
    sourceVideo,
  }: {
    disabled?: boolean;
    /** Shown in place of the field's affordances while disabled (mutual exclusion). */
    disabledReason?: string;
    onChange: (clip: VideoSourceClip | null) => void;
    sourceVideo: VideoSourceClip | null;
  }) {
    const { t } = useTranslation();
    const { getUploadBoardId, reportError, touchGalleryImages } = useVideoUiActions();
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const isInert = disabled || isLoading;

    const { active } = useDndContext();
    const acceptsActiveDrag = !isInert && getSingleVideoDragName(active?.data.current) !== null;
    const { isOver, setNodeRef } = useDroppable({ disabled: !acceptsActiveDrag, id: DROP_ID });

    const adoptVideo = useCallback(
      async (videoName: string) => {
        setErrorMessage(null);
        setIsLoading(true);

        try {
          const item = await galleryItems.resolve({ kind: 'video', name: videoName });

          if (item?.kind === 'video') {
            onChange(
              createVideoSourceClip({
                durationSeconds: item.durationSeconds,
                fps: item.fps,
                height: item.height,
                name: item.name,
                width: item.width,
              })
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setErrorMessage(message);
          reportError(message);
        } finally {
          setIsLoading(false);
        }
      },
      [onChange, reportError]
    );

    const handleDragEnd = useCallback(
      (event: DragEndEvent) => {
        const videoName = getSingleVideoDragName(event.active.data.current);

        if (!isInert && event.over?.id === DROP_ID && videoName) {
          void adoptVideo(videoName);
        }
      },
      [adoptVideo, isInert]
    );

    useDndMonitor({ onDragEnd: handleDragEnd });

    const uploadFile = useCallback(
      async (file: File) => {
        setErrorMessage(null);

        // `accept` is advisory; an unknown type (empty string) is the server's call.
        if (file.type && !file.type.startsWith('video/')) {
          setErrorMessage(t('widgets.video.unsupportedVideoFile'));
          reportError(t('widgets.video.unsupportedVideoFile'));
          return;
        }

        const owner = captureAccountScope();
        setIsLoading(true);

        try {
          const uploaded = await galleryTransfers.uploadVideo(file, getUploadBoardId(), { signal: owner.signal });

          assertAccountScopeCurrent(owner);
          onChange(
            createVideoSourceClip({
              durationSeconds: uploaded.durationSeconds,
              fps: uploaded.fps,
              height: uploaded.height,
              name: uploaded.name,
              width: uploaded.width,
            })
          );
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
      [getUploadBoardId, onChange, reportError, t, touchGalleryImages]
    );

    const handleFileChange = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];

        if (file) {
          void uploadFile(file);
        }
        event.currentTarget.value = '';
      },
      [uploadFile]
    );
    const handlePickFile = useCallback(() => {
      if (!isInert) {
        fileInputRef.current?.click();
      }
    }, [isInert]);
    const handleClear = useCallback(() => onChange(null), [onChange]);
    const handlePick = useCallback(
      (item: GalleryItem) => {
        if (item.kind === 'video') {
          setErrorMessage(null);
          onChange(createVideoSourceClip(item));
        }
      },
      [onChange]
    );

    const maxFrameIndex = sourceVideo ? Math.max(0, sourceVideo.numFrames - 1) : 0;
    // The crossfade join needs a 2-frame tail from the trimmed source, so the
    // setters keep at least two frames between the bounds.
    const setStartFrame = useCallback(
      (rawStart: number) => {
        if (!sourceVideo) {
          return;
        }

        const startFrame = Math.min(Math.max(0, rawStart), Math.max(0, maxFrameIndex - 1));

        onChange({ ...sourceVideo, endFrame: Math.max(startFrame + 1, sourceVideo.endFrame), startFrame });
      },
      [maxFrameIndex, onChange, sourceVideo]
    );
    const setEndFrame = useCallback(
      (rawEnd: number) => {
        if (!sourceVideo) {
          return;
        }

        const endFrame = Math.max(1, Math.min(rawEnd, maxFrameIndex));

        onChange({ ...sourceVideo, endFrame, startFrame: Math.min(sourceVideo.startFrame, endFrame - 1) });
      },
      [maxFrameIndex, onChange, sourceVideo]
    );

    const previewSrc = sourceVideo ? galleryVideoUrls.full(sourceVideo.video_name) : null;

    return (
      <Stack gap="2">
        <GalleryPickerPopover
          accept={VIDEO_ONLY}
          label={t(sourceVideo ? 'widgets.gallery.picker.replaceVideo' : 'widgets.gallery.picker.chooseVideo')}
          onPick={handlePick}
        >
          <DropZone
            ref={setNodeRef}
            as="button"
            aria-busy={isLoading}
            aria-disabled={disabled}
            aria-label={t(sourceVideo ? 'widgets.gallery.picker.replaceVideo' : 'widgets.gallery.picker.chooseVideo')}
            cursor={disabled ? 'not-allowed' : undefined}
            disabled={isInert}
            isDisabled={isInert}
            isOver={isOver}
            minH="24"
            overflow="hidden"
            position="relative"
            textAlign="start"
            w="full"
            _focusVisible={DROP_ZONE_FOCUS_PROPS}
            _disabled={DROP_ZONE_DISABLED_PROPS}
            _hover={isInert ? undefined : DROP_ZONE_HOVER_PROPS}
            opacity={disabled ? 0.6 : undefined}
          >
            {sourceVideo && previewSrc ? (
              <HStack gap="2" minW="0" p="2">
                <FilmIcon aria-hidden="true" size={14} />
                <MiddleTruncate color="fg" flex="1" fontSize="xs" fontWeight="semibold" text={sourceVideo.video_name} />
                <Text color="fg.muted" flexShrink="0" fontSize="2xs" fontVariantNumeric="tabular-nums">
                  {sourceVideo.width} × {sourceVideo.height} · {sourceVideo.fps} fps
                </Text>
              </HStack>
            ) : (
              <Stack align="center" color="fg.muted" gap="1.5" justify="center" minH="24" px="4">
                {isLoading ? (
                  <Spinner size="sm" />
                ) : (
                  <HStack color="fg" fontSize="xs" fontWeight="600" gap="1.5">
                    <Icon as={FilmIcon} boxSize="4" />
                    {t('widgets.gallery.picker.chooseVideo')}
                    <Icon as={ChevronDownIcon} boxSize="3" color="fg.subtle" />
                  </HStack>
                )}
                <Text color="fg.subtle" fontSize="2xs" textAlign="center">
                  {disabled && disabledReason
                    ? disabledReason
                    : isLoading
                      ? t('widgets.video.uploadingClip')
                      : t('widgets.gallery.picker.dropHint')}
                </Text>
              </Stack>
            )}
            <DropTargetOverlay
              isActive={acceptsActiveDrag}
              isOver={isOver}
              label={t('widgets.video.dropInitialVideo')}
            />
          </DropZone>
        </GalleryPickerPopover>
        {disabled ? null : (
          <HStack justify="end">
            <Button disabled={isLoading} size="xs" variant="ghost" onClick={handlePickFile}>
              <Icon as={UploadIcon} boxSize="3" />
              {t('widgets.gallery.picker.upload')}
            </Button>
          </HStack>
        )}
        {sourceVideo && previewSrc ? (
          <Stack gap="2">
            {/* The empty-state slot shows the reason when no clip is set; with
                one set, the frozen trim sliders were the only symptom. */}
            {disabled && disabledReason ? (
              <Text color="fg.muted" fontSize="2xs" textWrap="pretty">
                {disabledReason}
              </Text>
            ) : null}
            <Field helpText={t('widgets.video.trimHelp')} label={t('widgets.video.trim')}>
              {/* The play button leads both bound rows rather than sitting in one of
                  them: it plays the range they bracket, not either edge. */}
              <HStack align="center" gap="2" w="full">
                <PlayClipSpanButton clip={sourceVideo} />
                <Stack flex="1" gap="1" minW="0">
                  <HStack gap="2">
                    <TrimBoundThumb
                      fps={sourceVideo.fps}
                      frame={sourceVideo.startFrame}
                      label={t('widgets.video.trimStartShort')}
                      src={previewSrc}
                    />
                    <Box flex="1" minW="0">
                      <SliderNumberField
                        ariaLabel={t('widgets.video.trimStart')}
                        disabled={disabled}
                        max={maxFrameIndex}
                        min={0}
                        showStepper
                        step={1}
                        value={sourceVideo.startFrame}
                        onChange={setStartFrame}
                      />
                    </Box>
                  </HStack>
                  <HStack gap="2">
                    <TrimBoundThumb
                      fps={sourceVideo.fps}
                      frame={sourceVideo.endFrame}
                      label={t('widgets.video.trimEndShort')}
                      src={previewSrc}
                    />
                    <Box flex="1" minW="0">
                      <SliderNumberField
                        ariaLabel={t('widgets.video.trimEnd')}
                        disabled={disabled}
                        max={maxFrameIndex}
                        min={0}
                        showStepper
                        step={1}
                        value={sourceVideo.endFrame}
                        onChange={setEndFrame}
                      />
                    </Box>
                  </HStack>
                </Stack>
              </HStack>
            </Field>
            <HStack justify="end">
              <Button disabled={isLoading} size="xs" variant="ghost" onClick={handleClear}>
                <XIcon aria-hidden="true" size="12" />
                {t('widgets.video.removeClip')}
              </Button>
            </HStack>
          </Stack>
        ) : null}
        {errorMessage ? (
          <Text aria-live="polite" color="fg.error" fontSize="2xs" role="alert" textWrap="pretty">
            {errorMessage}
          </Text>
        ) : null}
        <Input
          ref={fileInputRef}
          accept="video/*"
          aria-hidden="true"
          display="none"
          tabIndex={-1}
          type="file"
          onChange={handleFileChange}
        />
      </Stack>
    );
  },
  (previous, next) =>
    previous.onChange === next.onChange &&
    previous.disabled === next.disabled &&
    previous.disabledReason === next.disabledReason &&
    areSourceClipsEquivalent(previous.sourceVideo, next.sourceVideo)
);
