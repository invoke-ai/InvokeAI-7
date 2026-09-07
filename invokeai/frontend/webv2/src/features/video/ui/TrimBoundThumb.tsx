import { Badge, Box } from '@chakra-ui/react';
import { memo, useEffect, useRef } from 'react';

/**
 * Small always-visible preview of one trim bound. Same seek technique as the
 * workflow editor's frame scrubber: one long-lived muted `<video>` element whose
 * `currentTime` is set to the middle of the frame's display interval
 * (`(frame + 0.5) / fps`), so rounding cannot show the neighbouring frame and
 * browsers display the frame natively without a canvas roundtrip. Remounting per
 * drag tick would spawn a range fetch per movement on multi-MB clips, hence the
 * long-lived element (`key={src}` only).
 *
 * Sized for the trim rows it lives in — a fixed compact tile with the slider to
 * its right — with the badge showing only the bound's name: the paired slider's
 * number input already shows the frame number.
 */

const PREVIEW_VIDEO_STYLE = {
  display: 'block',
  height: '100%',
  objectFit: 'contain',
  width: '100%',
} as const;

export const TrimBoundThumb = memo(function TrimBoundThumb({
  fps,
  frame,
  label,
  src,
}: {
  fps: number;
  frame: number;
  label: string;
  src: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    const time = Math.max(0, (frame + 0.5) / fps);

    if (!element || !Number.isFinite(time)) {
      return;
    }

    const seek = () => {
      element.currentTime = time;
    };

    // Seeking before metadata arrives is ignored by some browsers; wait for it
    // once, then seek directly on every later bound change.
    if (element.readyState >= 1) {
      seek();
    } else {
      element.addEventListener('loadedmetadata', seek, { once: true });

      return () => element.removeEventListener('loadedmetadata', seek);
    }
  }, [fps, frame, src]);

  return (
    <Box bg="blackAlpha.300" flexShrink={0} h="14" overflow="hidden" position="relative" rounded="sm" w="20">
      <video key={src} ref={videoRef} muted preload="metadata" src={src} style={PREVIEW_VIDEO_STYLE} />
      <Badge bottom="0.5" insetInlineStart="0.5" pointerEvents="none" position="absolute" size="xs" variant="solid">
        {label}
      </Badge>
    </Box>
  );
});
