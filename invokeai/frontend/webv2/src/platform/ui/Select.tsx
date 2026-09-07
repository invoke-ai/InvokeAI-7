import type {
  CollectionItem,
  SelectContentProps,
  SelectIndicatorGroupProps,
  SelectPositionerProps,
  SelectRootProps,
  SelectTriggerProps,
  SelectValueTextProps,
} from '@chakra-ui/react';
import type { Key, ReactNode } from 'react';

import { Portal, Select as ChakraSelect, useFieldContext } from '@chakra-ui/react';
import { useCallback, useRef } from 'react';

import { Scrollable } from './Scrollable';

const getDefaultItemKey = <T extends CollectionItem>(item: T, index: number): Key => {
  const keyedItem = item as { id?: Key; value?: Key };

  return keyedItem.value ?? keyedItem.id ?? index;
};

const renderDefaultItem = <T extends CollectionItem>(item: T): ReactNode => {
  const labelledItem = item as { label?: ReactNode; value?: ReactNode };

  return labelledItem.label ?? labelledItem.value;
};

/** Consecutive same-group runs, keeping the collection's flat order and indices. */
const partitionByGroup = <T,>(
  items: readonly T[],
  groupBy: (item: T) => string
): { group: string; items: T[]; startIndex: number }[] => {
  const runs: { group: string; items: T[]; startIndex: number }[] = [];
  items.forEach((item, index) => {
    const group = groupBy(item);
    const last = runs[runs.length - 1];
    if (last && last.group === group) {
      last.items.push(item);
    } else {
      runs.push({ group, items: [item], startIndex: index });
    }
  });
  return runs;
};

export interface SelectProps<T extends CollectionItem> extends Omit<SelectRootProps<T>, 'children'> {
  contentProps?: SelectContentProps;
  /**
   * Caps the open menu's height and scrolls the items inside a Scrollable.
   * The machine's own content-element scrolling is replaced by a
   * `scrollToIndexFn` targeting the Scrollable viewport, so keyboard
   * highlight, typeahead, and the open-reveal keep working.
   */
  itemsMaxH?: string;
  /**
   * Renders labelled item groups: consecutive items with the same group key
   * share one header. Items must already be ordered by group.
   */
  groupBy?: (item: T) => string;
  /** The visible header for a group key; defaults to the key itself. */
  renderGroupLabel?: (group: string) => ReactNode;
  getItemKey?: (item: T, index: number) => Key;
  indicatorGroupProps?: SelectIndicatorGroupProps;
  itemIndicator?: boolean;
  portalled?: boolean;
  positionerProps?: SelectPositionerProps;
  renderItem?: (item: T) => ReactNode;
  triggerProps?: SelectTriggerProps;
  valueText?: ReactNode;
  valueTextProps?: SelectValueTextProps;
}

/** Workbench Select: Chakra's custom Select with the standard trigger, portal, and item markup pre-wired. */
export const Select = <T extends CollectionItem>({
  'aria-label': ariaLabel,
  collection,
  contentProps,
  getItemKey = getDefaultItemKey,
  groupBy,
  indicatorGroupProps,
  itemsMaxH,
  itemIndicator = true,
  portalled = true,
  positionerProps,
  renderGroupLabel,
  renderItem = renderDefaultItem,
  triggerProps,
  valueText,
  valueTextProps,
  ...rootProps
}: SelectProps<T>) => {
  // Inside a Field the machine adopts the field's label id, so rendering our
  // own Label part there would duplicate that id; the field's visible label
  // already names the trigger.
  const field = useFieldContext();
  const itemsRef = useRef<HTMLDivElement>(null);
  const scrollToIndexFn = useCallback(({ index }: { index: number }) => {
    const options = itemsRef.current?.querySelectorAll('[role="option"]');
    options?.[index]?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <ChakraSelect.Root collection={collection} scrollToIndexFn={itemsMaxH ? scrollToIndexFn : undefined} {...rootProps}>
      {/* A real (visually hidden) Label part: the machine's trigger always points
        its aria-labelledby at this id, so a bare aria-label must materialize it —
        left on the Root it lands on a div, which ARIA prohibits. */}
      {ariaLabel && !field ? <ChakraSelect.Label srOnly>{ariaLabel}</ChakraSelect.Label> : null}
      <ChakraSelect.HiddenSelect />
      <ChakraSelect.Control>
        <ChakraSelect.Trigger {...triggerProps}>
          <ChakraSelect.ValueText {...valueTextProps}>{valueText}</ChakraSelect.ValueText>
        </ChakraSelect.Trigger>
        <ChakraSelect.IndicatorGroup {...indicatorGroupProps}>
          <ChakraSelect.Indicator />
        </ChakraSelect.IndicatorGroup>
      </ChakraSelect.Control>
      <Portal disabled={!portalled}>
        <ChakraSelect.Positioner {...positionerProps}>
          <ChakraSelect.Content {...contentProps}>
            <SelectItems ref={itemsRef} maxH={itemsMaxH}>
              {groupBy
                ? partitionByGroup(collection.items, groupBy).map(({ group, items, startIndex }) => (
                    <ChakraSelect.ItemGroup key={group}>
                      <ChakraSelect.ItemGroupLabel>
                        {renderGroupLabel ? renderGroupLabel(group) : group}
                      </ChakraSelect.ItemGroupLabel>
                      {items.map((item, offset) => (
                        <ChakraSelect.Item key={getItemKey(item, startIndex + offset)} item={item}>
                          <ChakraSelect.ItemText>{renderItem(item)}</ChakraSelect.ItemText>
                          {itemIndicator ? <ChakraSelect.ItemIndicator /> : null}
                        </ChakraSelect.Item>
                      ))}
                    </ChakraSelect.ItemGroup>
                  ))
                : collection.items.map((item, index) => (
                    <ChakraSelect.Item key={getItemKey(item, index)} item={item}>
                      <ChakraSelect.ItemText>{renderItem(item)}</ChakraSelect.ItemText>
                      {itemIndicator ? <ChakraSelect.ItemIndicator /> : null}
                    </ChakraSelect.Item>
                  ))}
            </SelectItems>
          </ChakraSelect.Content>
        </ChakraSelect.Positioner>
      </Portal>
    </ChakraSelect.Root>
  );
};

/** Items pass through untouched unless a max height asks for a scroll viewport. */
const SelectItems = ({
  children,
  maxH,
  ref,
}: {
  children: ReactNode;
  maxH?: string;
  ref: React.RefObject<HTMLDivElement | null>;
}) =>
  maxH ? (
    <Scrollable ref={ref} maxH={maxH}>
      {children}
    </Scrollable>
  ) : (
    children
  );
