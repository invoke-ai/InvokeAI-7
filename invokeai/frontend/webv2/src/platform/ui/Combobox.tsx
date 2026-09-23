import type {
  ComboboxInputProps,
  ComboboxRootProps,
  ComboboxValueChangeDetails,
  CollectionItem,
} from '@chakra-ui/react';

import { Combobox as ChakraCombobox, createListCollection, Portal } from '@chakra-ui/react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type UIEvent } from 'react';
import { useTranslation } from 'react-i18next';

const COMBOBOX_POSITIONING = { placement: 'bottom-start', sameWidth: true } as const;

const LIST_SCROLL_CSS = {
  scrollbarColor: 'var(--chakra-colors-border-emphasized) transparent',
  scrollbarWidth: 'thin',
} as const;

export interface ComboboxOption extends CollectionItem {
  disabled?: boolean;
  label: string;
  /** Additional fields already searched by the server, such as tags and descriptions. */
  searchText?: string;
  value: string;
}

export interface ComboboxProps extends Omit<
  ComboboxRootProps<ComboboxOption>,
  | 'allowCustomValue'
  | 'collection'
  | 'inputValue'
  | 'multiple'
  | 'onInputValueChange'
  | 'onOpenChange'
  | 'onValueChange'
  | 'open'
  | 'value'
> {
  inputProps?: ComboboxInputProps;
  noResultsText?: string;
  options: readonly ComboboxOption[];
  searchPlaceholder?: string;
  value: string | null;
  onInputValueChange?: (value: string) => void;
  onItemReselect?: (value: string) => void;
  onListScrollToBottom?: () => void;
  onValueChange: (value: string) => void;
}

/** Controlled, single-value searchable picker with workbench-standard portal positioning. */
export const Combobox = ({
  'aria-label': ariaLabel,
  inputProps,
  noResultsText,
  onValueChange,
  onItemReselect,
  options,
  onInputValueChange,
  onListScrollToBottom,
  searchPlaceholder,
  value,
  ...rootProps
}: ComboboxProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const lastNotifiedInputValue = useRef('');
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '';
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selectedValues = useMemo(() => (value ? [value] : []), [value]);
  const filteredOptions = useMemo(
    () =>
      normalizedQuery === ''
        ? options
        : options.filter(
            (option) =>
              option.label.toLocaleLowerCase().includes(normalizedQuery) ||
              option.value.toLocaleLowerCase().includes(normalizedQuery) ||
              option.searchText?.toLocaleLowerCase().includes(normalizedQuery)
          ),
    [normalizedQuery, options]
  );
  const collection = useMemo(
    () =>
      createListCollection({
        items: filteredOptions,
        isItemDisabled: (item) => item.disabled === true,
        itemToString: (item) => item.label,
        itemToValue: (item) => item.value,
      }),
    [filteredOptions]
  );
  const notifyInputValueChange = useCallback(
    (nextValue: string) => {
      if (nextValue === lastNotifiedInputValue.current) {
        return;
      }

      lastNotifiedInputValue.current = nextValue;
      onInputValueChange?.(nextValue);
    },
    [onInputValueChange]
  );
  const handleOpenChange = useCallback(
    (details: { open: boolean }) => {
      setIsOpen(details.open);
      setQuery('');

      if (!details.open) {
        notifyInputValueChange('');
      }
    },
    [notifyInputValueChange]
  );
  const handleInputValueChange = useCallback(
    (details: { inputValue: string; reason?: string }) => {
      if (details.reason === 'input-change' || details.reason === 'clear-trigger') {
        setQuery(details.inputValue);
        notifyInputValueChange(details.inputValue);
      }
    },
    [notifyInputValueChange]
  );
  const handleListScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const list = event.currentTarget;

      if (list.scrollHeight - list.scrollTop - list.clientHeight <= 24) {
        onListScrollToBottom?.();
      }
    },
    [onListScrollToBottom]
  );
  const handleValueChange = useCallback(
    (details: ComboboxValueChangeDetails<ComboboxOption>) => {
      const nextValue = details.value[0];

      if (nextValue !== undefined) {
        onValueChange(nextValue);
      }
    },
    [onValueChange]
  );
  const handleSelect = useCallback(
    ({ itemValue }: { itemValue: string }) => {
      if (itemValue === value) {
        onItemReselect?.(itemValue);
      }
    },
    [onItemReselect, value]
  );

  return (
    <ChakraCombobox.Root
      {...rootProps}
      allowCustomValue={false}
      closeOnSelect
      collection={collection}
      inputBehavior="autohighlight"
      inputValue={isOpen ? query : selectedLabel}
      multiple={false}
      open={isOpen}
      openOnClick
      positioning={COMBOBOX_POSITIONING}
      selectionBehavior="replace"
      value={selectedValues}
      onInputValueChange={handleInputValueChange}
      onOpenChange={handleOpenChange}
      onSelect={onItemReselect ? handleSelect : undefined}
      onValueChange={handleValueChange}
    >
      <ChakraCombobox.Control>
        <ChakraCombobox.Input
          {...inputProps}
          aria-label={inputProps?.['aria-label'] ?? ariaLabel}
          placeholder={searchPlaceholder ?? t('common.searchSchedulers')}
        />
        <ChakraCombobox.IndicatorGroup>
          <ChakraCombobox.Trigger aria-label={t('common.openSelector')}>
            <ChevronDownIcon />
          </ChakraCombobox.Trigger>
        </ChakraCombobox.IndicatorGroup>
      </ChakraCombobox.Control>
      <Portal>
        <ChakraCombobox.Positioner>
          <ChakraCombobox.Content>
            {/* Keep this as Ark's scroll container so keyboard highlight remains visible. */}
            <ChakraCombobox.List
              css={LIST_SCROLL_CSS}
              maxH="16rem"
              overflowY="auto"
              onScroll={onListScrollToBottom ? handleListScroll : undefined}
            >
              {collection.items.map((item) => (
                <ChakraCombobox.Item key={item.value} item={item}>
                  <ChakraCombobox.ItemText>{item.label}</ChakraCombobox.ItemText>
                  <ChakraCombobox.ItemIndicator>
                    <CheckIcon />
                  </ChakraCombobox.ItemIndicator>
                </ChakraCombobox.Item>
              ))}
              <ChakraCombobox.Empty color="fg.muted" fontSize="xs" px="3" py="2">
                {noResultsText ?? t('common.noSchedulersFound')}
              </ChakraCombobox.Empty>
            </ChakraCombobox.List>
          </ChakraCombobox.Content>
        </ChakraCombobox.Positioner>
      </Portal>
    </ChakraCombobox.Root>
  );
};
