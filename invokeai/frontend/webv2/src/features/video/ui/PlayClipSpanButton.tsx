import type { VideoSourceClip } from '@features/video/core/types';

import { galleryItems } from '@features/gallery';
import { videoClipSpanSeconds } from '@features/video/core/settings';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { IconButton } from '@platform/ui/Button';
import { PlayIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useVideoUiActions } from './VideoUiContext';

/**
 * Plays a clip's trimmed window in the Preview widget, looping it.
 *
 * The trim rows show two still frames, which answer where the window starts and ends but
 * not what is inside it — and for an audio reference, whose frames are a drawing of the
 * sound, nothing at all. This is the panel's only way to hear or watch the selection
 * before a generation is spent on it.
 *
 * Never gated on the panel's edit-disabled state: playing changes nothing, and a clip the
 * user can see is one they should be able to audition. The gallery record is resolved on
 * press rather than held on the reference, because the panel stores a clip (name,
 * dimensions, frame rate) while Preview needs the item itself — one small request against
 * something the user already has open, paid for by the press rather than by every card on
 * mount.
 */

export const PlayClipSpanButton = memo(function PlayClipSpanButton({ clip }: { clip: VideoSourceClip }) {
  const { t } = useTranslation();
  const { playVideoSpanInPreview, reportError } = useVideoUiActions();
  const [isResolving, setIsResolving] = useState(false);
  const span = useMemo(() => videoClipSpanSeconds(clip), [clip]);
  const videoName = clip.video_name;
  const handlePlay = useCallback(() => {
    // `aria-disabled` rather than `disabled` while the lookup is in flight: disabling a
    // focused button blurs it to <body>, dropping a keyboard user out of the card mid-
    // gesture — the same hazard the reference list's move arrows carry a focus handoff
    // for. So the press has to be refused here instead of by the DOM.
    if (!span || isResolving) {
      return;
    }

    const owner = captureAccountScope();

    setIsResolving(true);
    galleryItems
      .resolve({ kind: 'video', name: videoName }, owner.signal)
      .then((item) => {
        if (item.kind === 'video' && isAccountScopeCurrent(owner)) {
          playVideoSpanInPreview({ ...span, item });
        }
      })
      .catch((error: unknown) => {
        if (isAccountScopeCurrent(owner)) {
          reportError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => setIsResolving(false));
  }, [isResolving, playVideoSpanInPreview, reportError, span, videoName]);

  if (!span) {
    return null;
  }

  return (
    <IconButton
      aria-busy={isResolving}
      aria-disabled={isResolving}
      aria-label={t('widgets.video.playSelection')}
      opacity={isResolving ? 0.5 : undefined}
      size="2xs"
      title={t('widgets.video.playSelection')}
      variant="ghost"
      onClick={handlePlay}
    >
      <PlayIcon size={12} />
    </IconButton>
  );
});
