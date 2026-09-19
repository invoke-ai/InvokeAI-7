import type { ComponentProps, ReactNode, Ref } from 'react';

import { mergeRefs, ScrollArea } from '@chakra-ui/react';
import { usePreservedScrollOffset } from '@platform/react/usePreservedScrollOffset';
import { useCallback, useRef } from 'react';

import { useScrollAreaPhantomHeal } from './useScrollAreaPhantomHeal';

type ScrollAreaRootProps = ComponentProps<typeof ScrollArea.Root>;
type ScrollAreaContentProps = ComponentProps<typeof ScrollArea.Content>;
type ScrollAreaViewportProps = ComponentProps<typeof ScrollArea.Viewport>;

/**
 * zag pins `min-width: fit-content` *inline* on every scroll-area content box,
 * so the box grows to its content's min-content width. A horizontal strip wants
 * exactly that. In a vertical area it is a trap: one unbreakable string (a long
 * name, an unwrapped identifier) widens the content box past the viewport, the
 * area scrolls sideways — and since a vertical area renders no horizontal
 * scrollbar, the overflow is simply unreachable. Vertical areas override it back
 * to zero, so their content stretches to the viewport and truncation inside is
 * what gives. Only an inline style can beat an inline style.
 */
const VERTICAL_CONTENT_STYLE = { minWidth: 0 } as const;

/**
 * The workbench's standard scroll container: ScrollArea with hover-revealed
 * scrollbars and the content wrapper zag needs for correct thumb sizing.
 * Layout props (h, maxH, flex, ...) go to the root.
 */
export const Scrollable = ({
  children,
  contentProps,
  label,
  orientation = 'vertical',
  viewportProps,
  viewportRef,
  ...rootProps
}: ScrollAreaRootProps & {
  children: ReactNode;
  /** Extra props for the content wrapper, e.g. to let children fill the viewport height. */
  contentProps?: ScrollAreaContentProps;
  /** Accessible name for the scroll viewport. */
  label?: string;
  /** Scroll axis; the scrollbar and content sizing follow it. Defaults to vertical. */
  orientation?: 'horizontal' | 'vertical';
  /** Extra props for the scrolling viewport itself, e.g. scroll/focus handlers. */
  viewportProps?: ScrollAreaViewportProps;
  /**
   * The scrolling element itself — what a virtualizer needs to observe. A
   * callback ref is attached alongside the internal one, for mount-time work
   * such as restoring a remembered offset.
   */
  viewportRef?: Ref<HTMLDivElement | null>;
}) => {
  const fallbackViewportRef = useRef<HTMLDivElement | null>(null);
  // One object ref, shared with the caller when it hands one in, so nothing
  // has to merge or reassign refs during render.
  const resolvedViewportRef = viewportRef && typeof viewportRef !== 'function' ? viewportRef : fallbackViewportRef;
  const viewportCallback = typeof viewportRef === 'function' ? viewportRef : undefined;
  // A callback ref is composed with the object ref the hooks observe; the
  // composition only runs when React attaches the element, never in render.
  const attachViewport = useCallback(
    (element: HTMLDivElement | null) => mergeRefs(fallbackViewportRef, viewportCallback)(element),
    [viewportCallback]
  );

  // The shell keeps widgets mounted across layout switches, and a scroll
  // container that stops being rendered loses its offset outright.
  usePreservedScrollOffset(resolvedViewportRef);

  useScrollAreaPhantomHeal(resolvedViewportRef);

  return (
    <ScrollArea.Root size="xs" variant="hover" {...rootProps}>
      <ScrollArea.Viewport
        aria-label={label}
        h="full"
        role={label ? 'region' : undefined}
        w="full"
        {...viewportProps}
        ref={viewportCallback ? attachViewport : resolvedViewportRef}
      >
        <ScrollArea.Content
          style={orientation === 'horizontal' ? undefined : VERTICAL_CONTENT_STYLE}
          w={orientation === 'horizontal' ? 'max-content' : 'full'}
          {...contentProps}
        >
          {children}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar orientation={orientation}>
        <ScrollArea.Thumb />
      </ScrollArea.Scrollbar>
    </ScrollArea.Root>
  );
};
