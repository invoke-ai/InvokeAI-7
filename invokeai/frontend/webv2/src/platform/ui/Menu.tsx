import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { Box, HStack, Icon, Kbd, Menu, Text, useMenuContext } from '@chakra-ui/react';

import { Tooltip } from './Tooltip';
import { useRegisterWidgetOverlay } from './widgetOverlays';

type MenuContentProps = ComponentProps<typeof Menu.Content>;

/**
 * Menu.Content that closes with the tree that opened it. The workbench popover
 * chrome (surface, stroke, radius, shadow) is applied globally by the `menu`
 * slot-recipe override in `theme/recipes.ts`; this wrapper is the single
 * import point for menu-wide behavior.
 */
export const MenuContent = (props: MenuContentProps) => {
  const menu = useMenuContext();
  const stale = useRegisterWidgetOverlay(menu.open, menu.setOpen);
  return stale ? null : <Menu.Content {...props} />;
};

export interface MenuActionItemProps {
  value: string;
  label: string;
  icon?: LucideIcon;
  /** CSS color for the icon (e.g. a swatch); the theme tone otherwise. */
  iconColor?: string;
  tone?: 'danger';
  disabled?: boolean;
  /** Trailing keycap strings, already formatted for the platform. */
  hintParts?: readonly string[];
  onSelect: () => void;
}

/** The shared icon+label menu item; `tone: 'danger'` colors the whole row, icon included. */
export const MenuActionItem = ({
  disabled,
  hintParts,
  icon,
  iconColor,
  label,
  onSelect,
  tone,
  value,
}: MenuActionItemProps) => (
  <Menu.Item data-danger={tone === 'danger' ? '' : undefined} disabled={disabled} value={value} onSelect={onSelect}>
    <HStack gap="2" minW="0" w="full">
      {icon ? (
        <Icon
          as={icon}
          boxSize="3.5"
          color={tone === 'danger' ? undefined : (iconColor ?? 'fg.subtle')}
          fill={iconColor ?? 'none'}
          flexShrink={0}
        />
      ) : null}
      <Text flex="1" fontSize="xs">
        {label}
      </Text>
      {hintParts && hintParts.length > 0 ? (
        <HStack flexShrink={0} gap="0.5">
          {hintParts.map((part) => (
            <Kbd key={part} size="sm" textTransform="lowercase">
              {part}
            </Kbd>
          ))}
        </HStack>
      ) : null}
    </HStack>
  </Menu.Item>
);

const ICON_ITEM_TOOLTIP_CONTENT_PROPS = { fontSize: '2xs' } as const;
const ICON_ITEM_TOOLTIP_POSITIONING_PROPS = { placement: 'top' } as const;

export interface MenuIconItemProps {
  value: string;
  /** The accessible name; also the hover tooltip, since the item shows only its icon. */
  label: string;
  icon: LucideIcon;
  /** Lucide icons are stroke-only, so `'currentColor'` is how an on state reads. */
  iconFill?: string;
  tone?: 'danger';
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * An icon-only item for a menu's quick row. The tooltip wraps the icon, never
 * the item: a tooltip trigger merged onto the item replaces the id zag selects
 * by, so clicks and Enter would close the menu without firing `onSelect`.
 */
export const MenuIconItem = ({ disabled, icon, iconFill, label, onSelect, tone, value }: MenuIconItemProps) => (
  <Menu.Item
    aria-label={label}
    data-danger={tone === 'danger' ? '' : undefined}
    disabled={disabled}
    flex="1"
    justifyContent="center"
    value={value}
    onSelect={onSelect}
  >
    <Tooltip
      showArrow
      content={label}
      contentProps={ICON_ITEM_TOOLTIP_CONTENT_PROPS}
      openDelay={300}
      positioning={ICON_ITEM_TOOLTIP_POSITIONING_PROPS}
    >
      <Box alignItems="center" display="flex" h="full" justifyContent="center" w="full">
        <Icon as={icon} boxSize="4" color={tone === 'danger' ? undefined : 'fg'} fill={iconFill ?? 'none'} />
      </Box>
    </Tooltip>
  </Menu.Item>
);
