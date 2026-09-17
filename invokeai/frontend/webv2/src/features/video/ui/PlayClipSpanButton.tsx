import type { VideoSourceClip } from '@features/video/core/types';

import { galleryItems } from '@features/gallery';
import { videoClipSpanSeconds } from '@features/video/core/settings';
import { captureAccountScope, isAccountScopeCurrent } from '@platform/state/accountLifecycle';
import { IconButton } from '@platform/ui/Button';
import { PauseIcon, PlayIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { useVideoUiActions } from './VideoUiContext';

/**
 * Plays a clip's trimmed window in the Preview widget, looping it — and, while that loop
 * is the one running, offers to stop it.
 *
 * The trim rows show two still frames, which answer where the window starts and ends but
 * not what is inside it — and for an audio reference, whose frames are a drawing of the
 * sound, nothing at all. This is the panel's only way to hear or watch the selection
 * before a generation is spent on it.
 *
 * The button is a pause control only for its own loop: the player reports under the token
 * of the request it honoured, so a sibling card playing the same clip, or a native play of
 * something else, leaves this one offering play. Pausing leaves the window armed in the
 * player (the native play control resumes the selection), but the NEXT press here is a
 * fresh request rather than a resume — the trim can have moved in between, and the press
 * has to play what the rows now show, from its start.
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
  const { playVideoSpanInPreview, reportError, videoSpanPlayback } = useVideoUiActions();
  const [isResolving, setIsResolving] = useState(false);
  // The token of this button's last request; what the player's report is matched against.
  const [requestToken, setRequestToken] = useState<number | null>(null);
  const playback = useSyncExternalStore(
    videoSpanPlayback.subscribe,
    videoSpanPlayback.getState,
    videoSpanPlayback.getState
  );
  const isPlaying = playback !== null && playback.token === requestToken && playback.isPlaying;
  const span = useMemo(() => videoClipSpanSeconds(clip), [clip]);
  const videoName = clip.video_name;
  const handlePress = useCallback(() => {
    // `aria-disabled` rather than `disabled` while the lookup is in flight: disabling a
    // focused button blurs it to <body>, dropping a keyboard user out of the card mid-
    // gesture — the same hazard the reference list's move arrows carry a focus handoff
    // for. So the press has to be refused here instead of by the DOM.
    if (!span || isResolving) {
      return;
    }

    if (isPlaying) {
      playback.pause();
      return;
    }

    const owner = captureAccountScope();

    setIsResolving(true);
    galleryItems
      .resolve({ kind: 'video', name: videoName }, owner.signal)
      .then((item) => {
        if (item.kind === 'video' && isAccountScopeCurrent(owner)) {
          const token = playVideoSpanInPreview({ ...span, item });

          // A refusal (Preview could not be raised) asked nothing of the player, so the
          // loop this button last started — paused, still armed — stays its own to stop.
          if (token !== null) {
            setRequestToken(token);
          }
        }
      })
      .catch((error: unknown) => {
        if (isAccountScopeCurrent(owner)) {
          reportError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => setIsResolving(false));
  }, [isPlaying, isResolving, playVideoSpanInPreview, playback, reportError, span, videoName]);

  if (!span) {
    return null;
  }

  const label = isPlaying ? t('widgets.video.pauseSelection') : t('widgets.video.playSelection');

  return (
    <IconButton
      aria-busy={isResolving}
      aria-disabled={isResolving}
      aria-label={label}
      opacity={isResolving ? 0.5 : undefined}
      size="2xs"
      title={label}
      variant="ghost"
      onClick={handlePress}
    >
      {isPlaying ? <PauseIcon size={12} /> : <PlayIcon size={12} />}
    </IconButton>
  );
});
