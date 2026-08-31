import type { WidgetViewProps } from '@workbench/widgetContracts';

import { Box, HStack, Icon } from '@chakra-ui/react';
import { useProgressImage } from '@features/queue/react';
import { IconButton, ToggleIconButton, Tooltip } from '@platform/ui';
import { InvokeMarkIcon } from '@platform/ui/InvokeMark';
import { useInvocationState } from '@workbench/shell/topbar/useInvocationState';
import { getProjectWidgetValues } from '@workbench/widgetState';
import { useActiveProjectSelector, useWorkbenchCommands } from '@workbench/WorkbenchContext';
import { GalleryThumbnailsIcon, HourglassIcon } from 'lucide-react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { PreviewActionStrip } from './PreviewActionStrip';
import { usePreviewHeaderContext } from './previewHeaderStore';
import { getPreviewFilmstripVisible } from './previewSettings';

/**
 * The preview widget's header actions: the image action strip for the current
 * selection (published by the view via `previewHeaderStore`) plus the
 * in-progress diffusion toggle. Actions live here — in the frame's standard
 * header slot — like every other widget, not in the widget body.
 *
 * Floated, the widget also carries an Invoke control: a floating preview is
 * typically parked over a maximized work surface, or on a second display, with
 * the topbar's Invoke button out of easy reach — so the window that shows the
 * result offers the one action that produces the next one. Docked, the topbar
 * is right there and a second Invoke button would only compete with it.
 */
export const PreviewHeaderActions = ({ region, runtime }: WidgetViewProps) => {
  const { t } = useTranslation();
  const showProgressImagesInViewer = useActiveProjectSelector((project) => project.settings.showProgressImagesInViewer);
  const hasProgressImage = useProgressImage() !== null;
  const { actionItem, actions, copyCurrentVideoFrame, isVideoFrameCopyAvailable, openItemMenu, openVideoDetails } =
    usePreviewHeaderContext();
  const isFilmstripVisible = useActiveProjectSelector((project) =>
    getPreviewFilmstripVisible(getProjectWidgetValues(project, 'preview'))
  );
  const { account, widgets } = useWorkbenchCommands();
  const label = showProgressImagesInViewer
    ? t('widgets.preview.hideInProgressDiffusion')
    : t('widgets.preview.showInProgressDiffusion');
  const filmstripLabel = isFilmstripVisible ? t('widgets.preview.hideFilmstrip') : t('widgets.preview.showFilmstrip');
  const toggleProgressImages = useCallback(
    () => account.updateProjectPreferences({ showProgressImagesInViewer: !showProgressImagesInViewer }),
    [account, showProgressImagesInViewer]
  );
  const toggleFilmstrip = useCallback(
    () => widgets.patchValues('preview', { filmstripVisible: !isFilmstripVisible }),
    [isFilmstripVisible, widgets]
  );

  return (
    <HStack gap="1">
      {actionItem && actions ? (
        <>
          <PreviewActionStrip
            actions={actions}
            density={region === 'center' ? 'full' : 'compact'}
            isVideoFrameCopyAvailable={isVideoFrameCopyAvailable}
            item={actionItem}
            onCopyCurrentFrame={copyCurrentVideoFrame ?? undefined}
            onOpenDetails={openVideoDetails ?? undefined}
            onOpenMenu={openItemMenu}
          />
          <Box bg="border.subtle" flexShrink={0} h="4" w="1px" />
        </>
      ) : null}
      {/* Both toggles go through `ToggleIconButton` so they read as one control
          type: the filled variant carries "on", `aria-pressed` carries it for
          assistive tech, and the label doubles as the tooltip. */}
      {region === 'floating' ? <FloatingInvokeButton runtime={runtime} /> : null}
      <ToggleIconButton
        checked={isFilmstripVisible}
        icon={GalleryThumbnailsIcon}
        label={filmstripLabel}
        onCheckedChange={toggleFilmstrip}
      />
      <ToggleIconButton
        checked={showProgressImagesInViewer}
        icon={HourglassIcon}
        label={label}
        // Dimmed while there is nothing in flight to show. Spread after the
        // primitive's own props, so it survives.
        opacity={hasProgressImage || showProgressImagesInViewer ? 1 : 0.7}
        onCheckedChange={toggleProgressImages}
      />
    </HStack>
  );
};

/**
 * The floating window's Invoke control. It reads the same invocation state as
 * the topbar button, so it dims and names the blocking reason under exactly
 * the conditions the topbar does, instead of silently doing nothing when the
 * route is invalid or the backend is disconnected. Submission goes through the
 * registered `app.invoke` command — the topbar button's and the hotkey's path
 * — so the validation and disconnect guards are not duplicated here.
 *
 * Split out so the hook's subscriptions (models, dynamic prompt expansion)
 * only run while the widget floats.
 */
const FloatingInvokeButton = ({ runtime }: Pick<WidgetViewProps, 'runtime'>) => {
  const { t } = useTranslation();
  const { blockingReasons, isPreparing, isValid } = useInvocationState();
  const canInvoke = isValid && !isPreparing;
  const label = canInvoke
    ? t('widgets.preview.invoke')
    : isPreparing
      ? t('topbar.invoke.preparing')
      : t('topbar.invoke.unavailable', { reason: blockingReasons[0] ?? t('topbar.invoke.unrunnable') });
  const invoke = useCallback(() => void runtime.commands.execute('app.invoke'), [runtime]);

  return (
    <Tooltip content={label}>
      <IconButton
        aria-disabled={!canInvoke}
        aria-label={label}
        color="brand.fg"
        cursor={canInvoke ? undefined : 'not-allowed'}
        opacity={canInvoke ? undefined : 0.55}
        size="2xs"
        variant="ghost"
        onClick={canInvoke ? invoke : undefined}
      >
        <Icon as={InvokeMarkIcon} boxSize="3.5" />
      </IconButton>
    </Tooltip>
  );
};
