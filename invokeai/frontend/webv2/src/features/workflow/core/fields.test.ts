import { describe, expect, it } from 'vitest';

import type { FieldInputTemplate, FieldType } from './types';

import {
  getEffectiveWorkflowFieldDescription,
  getWorkflowFieldInvalidReason,
  isDirectInputField,
  isLoraFieldCollectionEntry,
  isModelFieldType,
  isWorkflowFieldValueValid,
  toLoraFieldCollectionList,
  getRandomWorkflowFieldValue,
  isShuffleableField,
} from './fields';

const single = (name: string): FieldType => ({ batch: false, cardinality: 'SINGLE', name });

const LORA_ENTRY = {
  lora: { base: 'sd-1', hash: 'hash', key: 'lora-key', name: 'LoRA', type: 'lora' },
  weight: 0.75,
};

const input = (overrides: Partial<FieldInputTemplate> = {}): FieldInputTemplate => ({
  default: undefined,
  description: '',
  exclusiveMaximum: null,
  exclusiveMinimum: null,
  fieldKind: 'input',
  input: 'any',
  maximum: null,
  minimum: null,
  multipleOf: null,
  name: 'value',
  options: null,
  required: true,
  title: 'Value',
  type: single('StringField'),
  uiChoiceLabels: null,
  uiComponent: null,
  uiHidden: false,
  uiModelBase: null,
  uiModelFormat: null,
  uiModelType: null,
  uiOrder: null,
  ...overrides,
});

describe('workflow field validation', () => {
  it('honors an explicitly cleared description before falling back to a template', () => {
    const template = input({ description: 'Inherited description' });
    expect(
      getEffectiveWorkflowFieldDescription(
        { name: 'value', label: '', description: '', descriptionOverride: true },
        template
      )
    ).toBe('');
    expect(getEffectiveWorkflowFieldDescription({ name: 'value', label: '', description: '' }, template)).toBe(
      'Inherited description'
    );
  });
  it('flags missing required direct values and ignores optional fields', () => {
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template: input(), value: undefined })).toBe(
      'Required value.'
    );
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template: input({ required: false }), value: '' })).toBe(
      null
    );
  });

  it('accepts an empty string as a required string value', () => {
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template: input(), value: '' })).toBe(null);
    expect(isWorkflowFieldValueValid(input(), '')).toBe(true);
    expect(isWorkflowFieldValueValid(input({ options: ['a'], type: single('EnumField') }), '')).toBe(false);
  });

  it('treats connected required fields as valid', () => {
    expect(
      getWorkflowFieldInvalidReason({ isConnected: true, template: input({ input: 'connection' }), value: '' })
    ).toBe(null);
  });

  it('flags missing required connections', () => {
    expect(
      getWorkflowFieldInvalidReason({ isConnected: false, template: input({ input: 'connection' }), value: undefined })
    ).toBe('Required connection.');
    expect(
      getWorkflowFieldInvalidReason({ isConnected: false, template: input({ input: 'connection' }), value: 'value' })
    ).toBe('Required connection.');
  });

  it('accepts persisted values for unsupported direct controls', () => {
    const template = input({ type: single('AnyField') });

    expect(getWorkflowFieldInvalidReason({ isConnected: false, template, value: { value: true } })).toBe(null);
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template, value: undefined })).toBe(
      'Required connection.'
    );
  });

  it('validates numeric constraints', () => {
    const template = input({ maximum: 10, minimum: 1, type: single('IntegerField') });

    expect(isWorkflowFieldValueValid(template, 5)).toBe(true);
    expect(isWorkflowFieldValueValid(template, 0)).toBe(false);
    expect(isWorkflowFieldValueValid(template, 5.5)).toBe(false);
  });

  it('allows empty optional direct values but flags populated invalid optional values', () => {
    const template = input({ maximum: 10, minimum: 1, required: false, type: single('IntegerField') });

    expect(getWorkflowFieldInvalidReason({ isConnected: false, template, value: undefined })).toBe(null);
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template, value: 20 })).toBe('Invalid value.');
  });

  it('validates object-backed model and image fields', () => {
    expect(isWorkflowFieldValueValid(input({ type: single('ModelIdentifierField') }), { key: 'model-key' })).toBe(true);
    expect(isWorkflowFieldValueValid(input({ type: single('ModelIdentifierField') }), {})).toBe(false);
    expect(isWorkflowFieldValueValid(input({ type: single('ImageField') }), { image_name: 'image.png' })).toBe(true);
    expect(isWorkflowFieldValueValid(input({ type: single('ImageField') }), { image_name: '' })).toBe(false);
  });

  it('validates video fields like image fields (direct-input media)', () => {
    expect(isWorkflowFieldValueValid(input({ type: single('VideoField') }), { video_name: 'clip.mp4' })).toBe(true);
    expect(isWorkflowFieldValueValid(input({ type: single('VideoField') }), { video_name: '' })).toBe(false);
    expect(isWorkflowFieldValueValid(input({ type: single('VideoField') }), {})).toBe(false);
  });

  it('validates image collections as lists of image refs and keeps video collections on the non-null check', () => {
    const videos = input({ type: { batch: false, cardinality: 'COLLECTION', name: 'VideoField' } });
    const images = input({ type: { batch: false, cardinality: 'COLLECTION', name: 'ImageField' } });

    expect(isWorkflowFieldValueValid(videos, [{ video_name: 'a.mp4' }, { video_name: 'b.mp4' }])).toBe(true);
    expect(isWorkflowFieldValueValid(videos, undefined)).toBe(false);
    expect(isWorkflowFieldValueValid(images, [{ image_name: 'a.png' }])).toBe(true);
    expect(isWorkflowFieldValueValid(images, [])).toBe(true);
    expect(isWorkflowFieldValueValid(images, [{ image_name: '' }])).toBe(false);
    expect(isWorkflowFieldValueValid(images, { image_name: 'a.png' })).toBe(false);
  });

  it('exposes image collections as direct inputs but keeps other collections connection-only', () => {
    expect(isDirectInputField(input({ type: { batch: false, cardinality: 'COLLECTION', name: 'ImageField' } }))).toBe(
      true
    );
    expect(isDirectInputField(input({ type: { batch: false, cardinality: 'COLLECTION', name: 'VideoField' } }))).toBe(
      false
    );
    expect(isDirectInputField(input({ type: { batch: false, cardinality: 'COLLECTION', name: 'StringField' } }))).toBe(
      false
    );
  });

  it('accepts a LoRA collection as a list, a bare entry, or an empty list', () => {
    const loras = input({
      required: false,
      type: { batch: false, cardinality: 'SINGLE_OR_COLLECTION', name: 'LoRAField' },
    });

    expect(isWorkflowFieldValueValid(loras, [])).toBe(true);
    expect(isWorkflowFieldValueValid(loras, [LORA_ENTRY])).toBe(true);
    expect(isWorkflowFieldValueValid(loras, LORA_ENTRY)).toBe(true);
    expect(isWorkflowFieldValueValid(loras, [{ ...LORA_ENTRY, weight: 'heavy' }])).toBe(false);
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template: loras, value: [] })).toBe(null);
  });

  it('rejects a LoRA identifier missing the fields the backend requires, rather than enqueuing a 422', () => {
    const loras = input({
      required: false,
      type: { batch: false, cardinality: 'SINGLE_OR_COLLECTION', name: 'LoRAField' },
    });

    // A key alone would render a nameless row and be rejected at enqueue time.
    expect(isWorkflowFieldValueValid(loras, [{ lora: { key: 'lora-key' }, weight: 0.75 }])).toBe(false);
    expect(isWorkflowFieldValueValid(loras, [{ ...LORA_ENTRY, lora: { ...LORA_ENTRY.lora, hash: '' } }])).toBe(false);
    expect(getWorkflowFieldInvalidReason({ isConnected: false, template: loras, value: [{ weight: 1 }] })).toBe(
      'Invalid value.'
    );
  });

  it('treats empty board values as the Auto sentinel', () => {
    expect(isWorkflowFieldValueValid(input({ type: single('BoardField') }), undefined)).toBe(true);
    expect(isWorkflowFieldValueValid(input({ type: single('BoardField') }), { board_id: 'board-id' })).toBe(true);
    expect(isWorkflowFieldValueValid(input({ type: single('BoardField') }), {})).toBe(false);
  });
});

describe('LoRA collection values', () => {
  const loras = input({
    required: false,
    type: { batch: false, cardinality: 'SINGLE_OR_COLLECTION', name: 'LoRAField' },
  });

  it('gives the collection loaders an inline widget instead of a connection-only handle', () => {
    expect(isDirectInputField(loras)).toBe(true);
  });

  it('normalizes the `LoRAField | list[LoRAField]` union', () => {
    expect(toLoraFieldCollectionList([LORA_ENTRY])).toEqual([LORA_ENTRY]);
    expect(toLoraFieldCollectionList(LORA_ENTRY)).toEqual([LORA_ENTRY]);
    expect(toLoraFieldCollectionList(undefined)).toEqual([]);
    expect(toLoraFieldCollectionList(null)).toEqual([]);
  });

  it('preserves unreadable items verbatim so an edit cannot silently delete them', () => {
    // Keep unreadable collection entries so editing another row cannot destroy hand-authored data.
    const items = [LORA_ENTRY, { lora: { key: 'ghost' }, weight: 1 }, null, 'lora'];

    expect(toLoraFieldCollectionList(items)).toEqual(items);
    expect(items.filter(isLoraFieldCollectionEntry)).toEqual([LORA_ENTRY]);
  });
});

describe('workflow field type helpers', () => {
  it('matches legacy model field shape classification', () => {
    expect(isModelFieldType(single('ModelIdentifierField'))).toBe(true);
    expect(isModelFieldType(single('UNetField'))).toBe(true);
    expect(isModelFieldType(single('CLIPField'))).toBe(true);
    expect(isModelFieldType(single('ImageField'))).toBe(false);
  });
});

describe('getRandomWorkflowFieldValue', () => {
  it('stays inside the template bounds and snaps to the step', () => {
    const template = input({ maximum: 10, minimum: 2, multipleOf: 2, type: single('IntegerField') });

    expect(getRandomWorkflowFieldValue(template, () => 0)).toBe(2);
    expect(getRandomWorkflowFieldValue(template, () => 0.999)).toBe(10);
    expect(getRandomWorkflowFieldValue(template, () => 0.55)).toBe(6);

    const odd = input({ maximum: 9, minimum: 0, multipleOf: 2, type: single('IntegerField') });

    expect(getRandomWorkflowFieldValue(odd, () => 0.999)).toBe(8);

    const decimal = input({ maximum: 1, minimum: 0, multipleOf: 0.1, type: single('FloatField') });

    expect(getRandomWorkflowFieldValue(decimal, () => 0.3)).toBe(0.3);
  });

  it('respects exclusive bounds for integers and keeps floats unrounded', () => {
    const integer = input({ exclusiveMaximum: 5, exclusiveMinimum: 0, type: single('IntegerField') });

    expect(getRandomWorkflowFieldValue(integer, () => 0)).toBe(1);
    expect(getRandomWorkflowFieldValue(integer, () => 0.999)).toBe(4);

    const float = input({ maximum: 1, minimum: 0, type: single('FloatField') });

    expect(getRandomWorkflowFieldValue(float, () => 0.25)).toBe(0.25);

    const steppedExclusive = input({
      exclusiveMaximum: 1,
      exclusiveMinimum: 0,
      multipleOf: 0.5,
      type: single('FloatField'),
    });

    expect(getRandomWorkflowFieldValue(steppedExclusive, () => 0)).toBe(0.5);
    expect(getRandomWorkflowFieldValue(steppedExclusive, () => 0.999)).toBe(0.5);
  });

  it('keeps legacy numeric templates finite when optional constraints are absent', () => {
    const legacy = input({
      exclusiveMaximum: undefined,
      exclusiveMinimum: undefined,
      maximum: undefined,
      minimum: undefined,
      multipleOf: undefined,
      type: single('IntegerField'),
    });
    const value = getRandomWorkflowFieldValue(legacy, () => 0.5);

    expect(Number.isFinite(value)).toBe(true);
    expect(Number.isInteger(value)).toBe(true);
    expect(isWorkflowFieldValueValid(legacy, value)).toBe(true);
  });

  it('shuffles only direct numeric fields', () => {
    expect(isShuffleableField(input({ type: single('IntegerField') }))).toBe(true);
    expect(isShuffleableField(input({ type: single('FloatField') }))).toBe(true);
    expect(isShuffleableField(input({ input: 'connection', type: single('IntegerField') }))).toBe(false);
    expect(isShuffleableField(input())).toBe(false);
  });
});
