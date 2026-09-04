import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { HStack, Icon, Kbd, Menu, Text } from '@chakra-ui/react';

type MenuContentProps = ComponentProps<typeof Menu.Content>;

/**
 * Menu.Content passthrough. The workbench popover chrome (surface, stroke,
 * radius, shadow) is applied globally by the `menu` slot-recipe override in
 * `theme/recipes.ts`; this wrapper only exists as the single import point
 * for future menu-wide behavior.
 */
export const MenuContent = (props: MenuContentProps) => <Menu.Content {...props} />;

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
  <Menu.Item color={tone === 'danger' ? 'fg.error' : undefined} disabled={disabled} value={value} onSelect={onSelect}>
    <HStack gap="2" minW="0" w="full">
      {icon ? (
        <Icon
          as={icon}
          boxSize="3.5"
          color={tone === 'danger' ? 'fg.error' : (iconColor ?? 'fg.subtle')}
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
