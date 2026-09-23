import { describe, expect, it } from 'vitest';

import { parseFieldType, parseOpenApiToTemplates } from './templates';

const openApiFixture = {
  components: {
    schemas: {
      AddInvocation: {
        category: 'math',
        class: 'invocation',
        classification: 'stable',
        description: 'Adds two numbers',
        node_pack: 'invokeai',
        output: { $ref: '#/components/schemas/IntegerOutput' },
        properties: {
          a: {
            default: 0,
            field_kind: 'input',
            input: 'any',
            orig_required: false,
            title: 'A',
            type: 'integer',
            ui_hidden: false,
          },
          b: {
            default: 0,
            field_kind: 'input',
            input: 'any',
            minimum: 0,
            orig_required: false,
            title: 'B',
            type: 'integer',
            ui_component: 'video-frame-index',
            ui_hidden: false,
            ui_model_format: ['diffusers'],
          },
          id: { field_kind: 'internal', title: 'Id', type: 'string' },
          is_intermediate: { default: false, field_kind: 'internal', type: 'boolean' },
          type: { const: 'add', default: 'add', title: 'type' },
          use_cache: { default: true, field_kind: 'internal', type: 'boolean' },
        },
        tags: ['math'],
        title: 'Add Integers',
        type: 'object',
        version: '1.0.1',
      },
      DenoiseInvocation: {
        class: 'invocation',
        output: { $ref: '#/components/schemas/LatentsOutput' },
        properties: {
          latents: {
            anyOf: [{ $ref: '#/components/schemas/LatentsField' }, { type: 'null' }],
            field_kind: 'input',
            input: 'connection',
            orig_required: true,
            title: 'Latents',
          },
          prompts: {
            anyOf: [{ items: { type: 'string' }, type: 'array' }, { type: 'string' }],
            field_kind: 'input',
            orig_required: true,
            title: 'Prompts',
          },
          scheduler: {
            default: 'euler',
            enum: ['euler', 'ddim'],
            field_kind: 'input',
            orig_required: false,
            title: 'Scheduler',
            type: 'string',
          },
          type: { const: 'denoise', default: 'denoise', title: 'type' },
          use_cache: { default: true, field_kind: 'internal', type: 'boolean' },
        },
        title: 'DenoiseInvocation',
        type: 'object',
      },
      GraphInvocation: {
        class: 'invocation',
        output: { $ref: '#/components/schemas/IntegerOutput' },
        properties: {
          type: { const: 'graph', default: 'graph', title: 'type' },
        },
        title: 'Graph',
        type: 'object',
      },
      IntegerOutput: {
        class: 'output',
        properties: {
          type: { const: 'integer_output', default: 'integer_output' },
          value: { field_kind: 'output', title: 'Value', type: 'integer' },
        },
        type: 'object',
      },
      LoRACollectionLoaderInvocation: {
        class: 'invocation',
        output: { $ref: '#/components/schemas/IntegerOutput' },
        properties: {
          loras: {
            anyOf: [
              { $ref: '#/components/schemas/LoRAField' },
              { items: { $ref: '#/components/schemas/LoRAField' }, type: 'array' },
              { type: 'null' },
            ],
            default: null,
            field_kind: 'input',
            input: 'any',
            orig_required: false,
            title: 'LoRAs',
            ui_model_base: ['sd-1', 'sd-2'],
            ui_model_type: ['lora'],
          },
          type: { const: 'lora_collection_loader', default: 'lora_collection_loader', title: 'type' },
        },
        title: 'Apply LoRA Collection - SD1.5',
        type: 'object',
      },
      SaveVideoInvocation: {
        class: 'invocation',
        output: { $ref: '#/components/schemas/IntegerOutput' },
        properties: {
          board: {
            anyOf: [{ $ref: '#/components/schemas/BoardField' }, { type: 'null' }],
            field_kind: 'internal',
            input: 'direct',
            orig_required: false,
            title: 'Board',
          },
          id: { field_kind: 'node_attribute', title: 'Id', type: 'string' },
          is_intermediate: { default: false, field_kind: 'node_attribute', type: 'boolean' },
          latents: {
            anyOf: [{ $ref: '#/components/schemas/LatentsField' }, { type: 'null' }],
            field_kind: 'input',
            input: 'connection',
            orig_required: true,
            title: 'Latents',
          },
          metadata: {
            anyOf: [{ $ref: '#/components/schemas/MetadataField' }, { type: 'null' }],
            field_kind: 'internal',
            input: 'connection',
            orig_required: false,
            title: 'Metadata',
          },
          type: { const: 'save_video', default: 'save_video', title: 'type' },
          use_cache: { default: true, field_kind: 'node_attribute', type: 'boolean' },
        },
        title: 'Save Video',
        type: 'object',
      },
      LatentsOutput: {
        class: 'output',
        properties: {
          latents: {
            allOf: [{ $ref: '#/components/schemas/LatentsField' }],
            field_kind: 'output',
            title: 'Latents',
          },
          type: { const: 'latents_output', default: 'latents_output' },
        },
        type: 'object',
      },
    },
  },
};

describe('parseOpenApiToTemplates', () => {
  const templates = parseOpenApiToTemplates(openApiFixture);

  it('parses invocation schemas into templates, skipping the denylist', () => {
    expect(Object.keys(templates).sort()).toEqual(['add', 'denoise', 'lora_collection_loader', 'save_video']);

    const add = templates.add;

    expect(add?.title).toBe('Add Integers');
    expect(add?.version).toBe('1.0.1');
    expect(add?.category).toBe('math');
    expect(add?.outputType).toBe('integer_output');
  });

  it('parses input templates with constraints and skips reserved fields', () => {
    const add = templates.add;

    expect(Object.keys(add?.inputs ?? {}).sort()).toEqual(['a', 'b']);
    expect(add?.inputs.b?.minimum).toBe(0);
    expect(add?.inputs.a?.type).toEqual({ batch: false, cardinality: 'SINGLE', name: 'IntegerField' });
    // Unknown ui_component values collapse to null; known ones pass through.
    expect(add?.inputs.a?.uiComponent).toBeNull();
    expect(add?.inputs.b?.uiComponent).toBe('video-frame-index');
    // ui_model_format passes through so model pickers can filter by install format.
    expect(add?.inputs.a?.uiModelFormat).toBeNull();
    expect(add?.inputs.b?.uiModelFormat).toEqual(['diffusers']);
  });

  it('parses ref, nullable-anyOf, single-or-collection, and enum field types', () => {
    const denoise = templates.denoise;

    expect(denoise?.inputs.latents?.type).toEqual({ batch: false, cardinality: 'SINGLE', name: 'LatentsField' });
    expect(denoise?.inputs.latents?.input).toBe('connection');
    expect(denoise?.inputs.latents?.required).toBe(true);
    expect(denoise?.inputs.prompts?.type).toEqual({
      batch: false,
      cardinality: 'SINGLE_OR_COLLECTION',
      name: 'StringField',
    });
    expect(denoise?.inputs.scheduler?.type.name).toBe('EnumField');
    expect(denoise?.inputs.scheduler?.options).toEqual(['euler', 'ddim']);
  });

  it('parses the LoRA collection loader input as an inline-editable model collection', () => {
    // `LoRAField | list[LoRAField] | None`: the null variant drops out, leaving the union the
    // widget edits as a list. `default: null` must not become the field's value.
    const loras = templates.lora_collection_loader?.inputs.loras;

    expect(loras?.type).toEqual({ batch: false, cardinality: 'SINGLE_OR_COLLECTION', name: 'LoRAField' });
    expect(loras?.input).toBe('any');
    expect(loras?.default).toBeUndefined();
    expect(loras?.uiModelBase).toEqual(['sd-1', 'sd-2']);
    expect(loras?.uiModelType).toEqual(['lora']);
  });

  it('keeps internal-kind metadata and board inputs, but drops node attributes', () => {
    // Keep internal metadata and board inputs so saved edges and exposed Linear controls survive template parsing.
    const saveVideo = templates.save_video;

    expect(Object.keys(saveVideo?.inputs ?? {}).sort()).toEqual(['board', 'latents', 'metadata']);
    expect(saveVideo?.inputs.metadata?.type.name).toBe('MetadataField');
    expect(saveVideo?.inputs.board?.type.name).toBe('BoardField');
    expect(saveVideo?.inputs.metadata?.fieldKind).toBe('internal');
    expect(saveVideo?.inputs.board?.fieldKind).toBe('internal');
    expect(saveVideo?.inputs.latents?.fieldKind).toBe('input');
  });

  it('parses output templates', () => {
    expect(templates.denoise?.outputs.latents?.type.name).toBe('LatentsField');
    expect(templates.add?.outputs.value?.type.name).toBe('IntegerField');
  });

  it('preserves output scopes and hidden scheduler outputs', () => {
    const parsed = parseOpenApiToTemplates({
      components: {
        schemas: {
          ForInvocation: {
            class: 'invocation',
            output: { $ref: '#/components/schemas/ForOutput' },
            properties: { type: { default: 'for' } },
          },
          ForOutput: {
            class: 'output',
            properties: {
              item: { field_kind: 'output', output_scope: 'iteration', type: 'string' },
              output_collection: {
                field_kind: 'output',
                output_scope: 'final',
                type: 'array',
                items: { type: 'string' },
              },
              output: { field_kind: 'output', ui_hidden: true, type: 'string' },
              type: { default: 'for_output' },
            },
          },
        },
      },
    });

    expect(parsed.for?.outputs.item?.outputScope).toBe('iteration');
    expect(parsed.for?.outputs.output_collection?.outputScope).toBe('final');
    expect(parsed.for?.outputs.output?.uiHidden).toBe(true);
  });

  it('extracts options from nullable Literal schemas and normalizes numeric options', () => {
    const parsed = parseOpenApiToTemplates({
      components: {
        schemas: {
          LiteralInvocation: {
            class: 'invocation',
            output: { $ref: '#/components/schemas/IntegerOutput' },
            properties: {
              type: { default: 'literal_invocation' },
              text: {
                anyOf: [{ enum: ['fast', 'slow'], type: 'string' }, { type: 'null' }],
                default: 'slow',
                field_kind: 'input',
                orig_required: false,
                title: 'Text',
              },
              number: {
                anyOf: [{ const: 2, type: 'integer' }, { type: 'null' }],
                field_kind: 'input',
                orig_required: false,
                title: 'Number',
              },
            },
            title: 'Literal',
            type: 'object',
          },
          IntegerOutput: {
            class: 'output',
            properties: { type: { const: 'integer_output' }, value: { field_kind: 'output', type: 'integer' } },
            type: 'object',
          },
        },
      },
    });

    expect(parsed.literal_invocation?.inputs.text?.options).toEqual(['fast', 'slow']);
    expect(parsed.literal_invocation?.inputs.text?.default).toBe('slow');
    expect(parsed.literal_invocation?.inputs.number?.options).toEqual([2]);
    expect(parsed.literal_invocation?.inputs.number?.default).toBe(2);
  });

  it('leaves optional null enum defaults unset and rejects malformed enum shapes', () => {
    const parsed = parseOpenApiToTemplates({
      components: {
        schemas: {
          OptionalEnums: {
            class: 'invocation',
            output: { $ref: '#/components/schemas/IntegerOutput' },
            properties: {
              type: { default: 'optional_enums' },
              provider: {
                default: null,
                enum: ['openai', 'gemini'],
                field_kind: 'input',
                orig_required: false,
                title: 'Provider',
                type: 'string',
              },
              malformed: {
                enum: 'not-an-array',
                field_kind: 'input',
                orig_required: false,
                title: 'Malformed',
                type: 'string',
                ui_type: 'EnumField',
              },
            },
            title: 'Optional enums',
            type: 'object',
          },
          IntegerOutput: {
            class: 'output',
            properties: { type: { const: 'integer_output' }, value: { field_kind: 'output', type: 'integer' } },
            type: 'object',
          },
        },
      },
    });

    expect(parsed.optional_enums?.inputs.provider?.default).toBeUndefined();
    expect(parsed.optional_enums?.inputs.malformed?.options).toEqual([]);
  });
});

describe('parseFieldType', () => {
  it('parses collections of refs and primitives', () => {
    expect(parseFieldType({ items: { $ref: '#/components/schemas/ImageField' }, type: 'array' })).toEqual({
      batch: false,
      cardinality: 'COLLECTION',
      name: 'ImageField',
    });
    expect(parseFieldType({ items: { type: 'integer' }, type: 'array' })).toEqual({
      batch: false,
      cardinality: 'COLLECTION',
      name: 'IntegerField',
    });
  });

  it('returns null for unparseable shapes instead of throwing', () => {
    expect(parseFieldType({ anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] })).toBeNull();
    expect(parseFieldType('nonsense')).toBeNull();
  });
});

describe('integer Literal enum templates', () => {
  // Preserve numeric Literal defaults; backend validation rejects equivalent numeric strings.
  it('keeps a numeric Literal default numeric', () => {
    const parsed = parseOpenApiToTemplates({
      components: {
        schemas: {
          IntegerOutput: {
            class: 'output',
            properties: { type: { const: 'integer_output' }, value: { field_kind: 'output', type: 'integer' } },
            type: 'object',
          },
          MaxSeqLenInvocation: {
            class: 'invocation',
            output: { $ref: '#/components/schemas/IntegerOutput' },
            properties: {
              max_seq_len: {
                default: 512,
                enum: [256, 512],
                field_kind: 'input',
                orig_required: false,
                title: 'Max Seq Length',
                type: 'integer',
              },
              type: { default: 'max_seq_len_invocation' },
            },
            title: 'MaxSeqLen',
            type: 'object',
          },
        },
      },
    });

    expect(parsed.max_seq_len_invocation?.inputs.max_seq_len?.default).toBe(512);
  });

  // Required nullable numeric literals fall back to a numeric first option, matching legacy parsing.
  it('keeps a nullable Literal fallback default numeric', () => {
    const parsed = parseOpenApiToTemplates({
      components: {
        schemas: {
          IntegerOutput: {
            class: 'output',
            properties: { type: { const: 'integer_output' }, value: { field_kind: 'output', type: 'integer' } },
            type: 'object',
          },
          NullableMaxSeqLenInvocation: {
            class: 'invocation',
            output: { $ref: '#/components/schemas/IntegerOutput' },
            properties: {
              t5_max_seq_len: {
                anyOf: [{ enum: [256, 512], type: 'integer' }, { type: 'null' }],
                default: null,
                field_kind: 'input',
                orig_required: true,
                title: 'T5 Max Seq Length',
              },
              type: { default: 'nullable_max_seq_len_invocation' },
            },
            title: 'NullableMaxSeqLen',
            type: 'object',
          },
        },
      },
    });

    expect(parsed.nullable_max_seq_len_invocation?.inputs.t5_max_seq_len?.default).toBe(256);
  });
});
