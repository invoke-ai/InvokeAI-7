import type { FieldOutputTemplate } from './types';

export interface OutputFieldNamesByScope {
  all: string[];
  unscoped: string[];
  iteration: string[];
  final: string[];
}

export type OutputFieldRow = { type: 'field'; fieldName: string } | { type: 'header'; scope: 'iteration' | 'final' };

export const getOutputFieldNamesByScope = (fields: FieldOutputTemplate[]): OutputFieldNamesByScope => {
  const all = fields.filter((field) => !field.uiHidden).map((field) => field.name);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));

  return {
    all,
    final: all.filter((name) => fieldsByName.get(name)?.outputScope === 'final'),
    iteration: all.filter((name) => fieldsByName.get(name)?.outputScope === 'iteration'),
    unscoped: all.filter((name) => !fieldsByName.get(name)?.outputScope),
  };
};

export const getOutputFieldRows = (fieldNames: OutputFieldNamesByScope): OutputFieldRow[] => {
  if (fieldNames.iteration.length === 0 && fieldNames.final.length === 0) {
    return fieldNames.all.map((fieldName) => ({ fieldName, type: 'field' as const }));
  }

  const rows: OutputFieldRow[] = fieldNames.unscoped.map((fieldName) => ({ fieldName, type: 'field' as const }));

  if (fieldNames.iteration.length > 0) {
    rows.push({ scope: 'iteration', type: 'header' });
    rows.push(...fieldNames.iteration.map((fieldName) => ({ fieldName, type: 'field' as const })));
  }

  if (fieldNames.final.length > 0) {
    rows.push({ scope: 'final', type: 'header' });
    rows.push(...fieldNames.final.map((fieldName) => ({ fieldName, type: 'field' as const })));
  }

  return rows;
};
