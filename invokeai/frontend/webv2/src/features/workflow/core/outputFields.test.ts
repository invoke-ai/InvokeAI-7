import { describe, expect, it } from 'vitest';

import { getOutputFieldNamesByScope, getOutputFieldRows } from './outputFields';

describe('output field scopes', () => {
  it('groups visible outputs and keeps hidden scheduler outputs out of the node body', () => {
    const fields = [
      {
        name: 'loop_linkage',
        title: 'Linkage',
        description: '',
        type: { name: 'AnyField', cardinality: 'SINGLE' as const, batch: false },
      },
      {
        name: 'item',
        title: 'Item',
        description: '',
        outputScope: 'iteration' as const,
        type: { name: 'AnyField', cardinality: 'SINGLE' as const, batch: false },
      },
      {
        name: 'output',
        title: 'Output',
        description: '',
        uiHidden: true,
        type: { name: 'AnyField', cardinality: 'SINGLE' as const, batch: false },
      },
      {
        name: 'output_collection',
        title: 'Collection',
        description: '',
        outputScope: 'final' as const,
        type: { name: 'CollectionField', cardinality: 'COLLECTION' as const, batch: false },
      },
    ];

    const names = getOutputFieldNamesByScope(fields);

    expect(names).toEqual({
      all: ['loop_linkage', 'item', 'output_collection'],
      final: ['output_collection'],
      iteration: ['item'],
      unscoped: ['loop_linkage'],
    });
    expect(getOutputFieldRows(names)).toEqual([
      { fieldName: 'loop_linkage', type: 'field' },
      { scope: 'iteration', type: 'header' },
      { fieldName: 'item', type: 'field' },
      { scope: 'final', type: 'header' },
      { fieldName: 'output_collection', type: 'field' },
    ]);
  });
});
