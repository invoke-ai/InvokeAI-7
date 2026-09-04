import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { Box, chakra, HStack, Text } from '@chakra-ui/react';
import { Fragment, useCallback } from 'react';

const TAB_HOVER_PROPS = { bg: 'bg.muted', color: 'fg' };

/** The strip's fixed height; collapsed blocks and drag snaps size against it. */
export const SEGMENT_TABS_HEIGHT_PX = 40;

export interface SegmentTab<T extends string = string> {
  id: T;
  label: string;
}

/** Roving focus for a horizontal tablist: arrows cycle, Home/End jump. */
const focusSibling = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') {
    return;
  }
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const current = tabs.indexOf(document.activeElement as HTMLElement);
  if (current === -1) {
    return;
  }
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  tabs[next]?.focus();
};

/**
 * The workbench's segment-style tab strip: a row of pill tabs over a panel the
 * caller owns. Ids follow one convention — tab `${idBase}-tab-${id}`, panel
 * `${idBase}-panel` — so the caller's `role="tabpanel"` region wires itself
 * with `id={segmentTabsPanelId(idBase)}` and
 * `aria-labelledby={segmentTabsTabId(idBase, activeId)}`. Clicking the active
 * tab calls `onSelect` again, which lets a collapsible block treat it as a
 * toggle; `showActivePanel={false}` keeps the active tab selected and focusable
 * while dropping the shown look (a collapsed block). `trailing` renders after
 * the tablist, outside it, for chevrons and action buttons.
 */
export const SegmentTabs = <T extends string>({
  activeId,
  ariaLabel,
  idBase,
  onSelect,
  showActivePanel = true,
  tabs,
  trailing,
}: {
  activeId: T;
  ariaLabel: string;
  idBase: string;
  onSelect: (id: T) => void;
  showActivePanel?: boolean;
  tabs: readonly SegmentTab<T>[];
  trailing?: ReactNode;
}) => (
  <HStack align="center" flexShrink={0} gap="0.5" h={`${SEGMENT_TABS_HEIGHT_PX}px`} minW="0" px="1.5">
    <HStack
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      flex="1"
      gap="0.5"
      minW="0"
      overflow="hidden"
      role="tablist"
      onKeyDown={focusSibling}
    >
      {tabs.map((tab, index) => (
        <Fragment key={tab.id}>
          {index > 0 ? (
            <Box
              aria-hidden
              bg="border.emphasized"
              flexShrink={0}
              h="3.5"
              opacity={tab.id === activeId || tabs[index - 1]!.id === activeId ? 0 : 1}
              rounded="full"
              transition="opacity var(--wb-motion-duration-fast)"
              w="1px"
            />
          ) : null}
          <SegmentTabButton
            id={tab.id}
            idBase={idBase}
            isSelected={tab.id === activeId}
            isShown={tab.id === activeId && showActivePanel}
            label={tab.label}
            onSelect={onSelect}
          />
        </Fragment>
      ))}
    </HStack>
    {trailing}
  </HStack>
);

export const segmentTabsPanelId = (idBase: string): string => `${idBase}-panel`;
export const segmentTabsTabId = (idBase: string, tabId: string): string => `${idBase}-tab-${tabId}`;

const SegmentTabButton = <T extends string>({
  id,
  idBase,
  isSelected,
  isShown,
  label,
  onSelect,
}: {
  id: T;
  idBase: string;
  isSelected: boolean;
  /** Selected AND its panel is visible; a collapsed block keeps selection without the shown look. */
  isShown: boolean;
  label: string;
  onSelect: (id: T) => void;
}) => {
  const select = useCallback(() => onSelect(id), [id, onSelect]);

  return (
    <chakra.button
      aria-controls={isShown ? segmentTabsPanelId(idBase) : undefined}
      aria-selected={isSelected}
      bg={isShown ? 'bg.emphasized' : 'transparent'}
      color={isShown ? 'fg' : 'fg.muted'}
      cursor="pointer"
      fontSize="xs"
      fontWeight="600"
      h="7"
      id={segmentTabsTabId(idBase, id)}
      minW="10"
      overflow="hidden"
      px="2.5"
      role="tab"
      rounded="md"
      tabIndex={isSelected ? 0 : -1}
      type="button"
      _hover={isShown ? undefined : TAB_HOVER_PROPS}
      onClick={select}
    >
      <Text as="span" truncate>
        {label}
      </Text>
    </chakra.button>
  );
};
