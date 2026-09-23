import type { GalleryImage, GalleryItem } from '@features/gallery';
import type { ImageActions } from '@workbench/image-actions';

import { HStack, Icon, Popover, Portal, Text } from '@chakra-ui/react';
import { formatGalleryVideoDuration } from '@features/gallery/contracts';
import { useAuthSession } from '@features/identity';
import { IconButton } from '@platform/ui/Button';
import { PopoverContent } from '@platform/ui/Popover';
import { Tooltip, useTooltipTriggerIds } from '@platform/ui/Tooltip';
import { InfoIcon } from 'lucide-react';
import { useCallback, useMemo, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import type { PreviewItemPosition } from './previewHeaderStore';

import { PreviewDetails } from './PreviewMetadataPanel';

type InteractOutsideHandler = NonNullable<ComponentProps<typeof Popover.Root>['onInteractOutside']>;

/**
 * Bound Details to the media stage so long metadata scrolls without covering the filmstrip; images offer parsed
 * details alongside raw payload tabs.
 */
export const PreviewDetailsPopover = ({
  actions,
  image,
  isOpen,
  item,
  onOpenChange,
  position,
  stageElement,
}: {
  actions: ImageActions;
  image: GalleryImage | null;
  isOpen: boolean;
  item: GalleryItem;
  onOpenChange: (open: boolean) => void;
  position: PreviewItemPosition | null;
  stageElement: HTMLElement | null;
}) => {
  const { i18n, t } = useTranslation();
  const accountEpoch = useAuthSession().accountEpoch;
  const ids = useTooltipTriggerIds();
  const positioning = useMemo(
    () => ({
      boundary: () => stageElement ?? document.body,
      flip: false,
      overflowPadding: 8,
      placement: 'bottom-end' as const,
    }),
    [stageElement]
  );
  const handleOpenChange = useCallback(({ open }: { open: boolean }) => onOpenChange(open), [onOpenChange]);
  // Keep Details open while stage/filmstrip selection changes and preserve Preview keyboard navigation.
  const handleInteractOutside = useCallback<InteractOutsideHandler>(
    (event) => {
      const widget = stageElement?.closest('[role="region"]');
      const target = event.detail.originalEvent.target;

      if (widget && target instanceof Node && widget.contains(target)) {
        event.preventDefault();
      }
    },
    [stageElement]
  );
  const positionLabel =
    position === null
      ? null
      : position.isLoadingBoard
        ? t('widgets.preview.loadingBoard')
        : position.selectedIndex === -1
          ? t('widgets.preview.itemCount', { count: position.boardItemCount })
          : t('common.countOfTotal', { count: position.selectedIndex + 1, total: position.boardItemCount });
  const fps =
    item.kind === 'video' && item.fps !== undefined
      ? new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 3 }).format(item.fps)
      : null;
  const mediaLabel = [
    `${item.width} × ${item.height}`,
    ...(item.kind === 'video'
      ? [t('widgets.preview.videoDuration', { duration: formatGalleryVideoDuration(item.durationSeconds) })]
      : []),
    ...(fps === null ? [] : [t('widgets.preview.framesPerSecond', { count: fps })]),
  ].join(' · ');

  return (
    <Popover.Root
      autoFocus={false}
      ids={ids}
      lazyMount
      open={isOpen}
      positioning={positioning}
      unmountOnExit
      onInteractOutside={handleInteractOutside}
      onOpenChange={handleOpenChange}
    >
      <Tooltip content={t('widgets.preview.details')} ids={ids}>
        <Popover.Trigger asChild>
          <IconButton
            aria-label={t('widgets.preview.details')}
            aria-pressed={isOpen}
            color={isOpen ? undefined : 'fg.muted'}
            size="2xs"
            variant={isOpen ? 'solid' : 'ghost'}
          >
            <Icon as={InfoIcon} boxSize="3.5" />
          </IconButton>
        </Popover.Trigger>
      </Tooltip>
      <Portal>
        <Popover.Positioner>
          <PopoverContent
            data-preview-details
            display="flex"
            flexDirection="column"
            maxH="var(--available-height)"
            showArrow={false}
            w="24rem"
          >
            <Popover.Body display="flex" flexDirection="column" gap="2" minH="0" p="2.5">
              <HStack gap="1" minW="0">
                {positionLabel === null ? null : (
                  <>
                    <Text color="fg.muted" flexShrink={0} fontSize="2xs" fontVariantNumeric="tabular-nums">
                      {positionLabel}
                    </Text>
                    <Text color="fg.subtle" flexShrink={0} fontSize="2xs">
                      ·
                    </Text>
                  </>
                )}
                <Text color="fg.muted" fontSize="2xs" fontVariantNumeric="tabular-nums" truncate>
                  {mediaLabel}
                </Text>
              </HStack>
              <PreviewDetails accountEpoch={accountEpoch} actions={actions} image={image} item={item} />
            </Popover.Body>
          </PopoverContent>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
};
