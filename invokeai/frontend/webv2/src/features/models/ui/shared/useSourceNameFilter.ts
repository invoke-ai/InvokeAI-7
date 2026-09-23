import { useDeferredValue, useMemo, useState } from 'react';

/** Last path/URL segment: install sources display and filter by file name. */
export const sourceFileName = (source: string): string => source.split(/[\\/]/).at(-1) ?? source;

/** Pass a module-stable sourceOf so deferred filename filtering stays keyed on items. */
export const useSourceNameFilter = <Item>(items: readonly Item[], sourceOf: (item: Item) => string) => {
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);

  const filteredItems = useMemo(() => {
    const term = deferredFilter.trim().toLowerCase();

    if (!term) {
      return items;
    }

    return items.filter((item) => sourceFileName(sourceOf(item)).toLowerCase().includes(term));
  }, [deferredFilter, items, sourceOf]);

  return { filter, filteredItems, setFilter };
};
