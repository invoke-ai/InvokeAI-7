/** Cover every builder against backend-validated node/field/literal fixtures; tests own snapshot formatting. */

import type { BackendGraphContract } from '@features/generation/core/contracts';

import { seedArchitectureCapabilities } from '@features/generation/core/architectureCapabilities.testing';
import { describe, expect, it } from 'vitest';

import type {
  ComponentPolicyContext,
  ComponentSlotPolicy,
  GenerateComponentValueKey,
  SupportedGenerateBase,
} from './baseGenerationPolicies';
import type { GenerateSettings, MainModelConfig, ModelIdentifierConfig, VaeModelConfig } from './types';

import {
  getComponentSectionPolicy,
  getDefaultGenerateSettings,
  getGenerationValidationReasons,
  SUPPORTED_GENERATE_BASES,
} from './baseGenerationPolicies';
import { compileGenerateGraph, GRAPH_BUILDERS } from './graph';

/** Compile both bundled and standalone component paths. */
interface ModelShape {
  label: string;
  overrides: Partial<MainModelConfig>;
}

const DEFAULT_SHAPES: readonly ModelShape[] = [
  { label: 'diffusers', overrides: { format: 'diffusers' } },
  { label: 'standalone-components', overrides: { format: 'gguf_quantized' } },
];

/** Check per-base shape overrides against supported bases. */
const SHAPE_OVERRIDES: Partial<Record<SupportedGenerateBase, readonly ModelShape[]>> = {
  // Ideogram's standalone fixture is a conditional checkpoint, not GGUF.
  'ideogram-4': [
    { label: 'diffusers', overrides: { format: 'diffusers' } },
    { label: 'standalone-components', overrides: { branch: 'conditional', format: 'checkpoint' } },
  ],
  // FLUX.2 dev and Klein need distinct encoder variants.
  flux2: [
    { label: 'dev-diffusers', overrides: { format: 'diffusers', variant: 'dev' } },
    { label: 'dev-standalone', overrides: { format: 'gguf_quantized', variant: 'dev' } },
    { label: 'klein-9b-standalone', overrides: { format: 'gguf_quantized', variant: 'klein_9b' } },
  ],
};

const shapesForBase = (base: SupportedGenerateBase): readonly ModelShape[] => SHAPE_OVERRIDES[base] ?? DEFAULT_SHAPES;

/** Search component candidates through policy rather than copy compatibility rules. */
const CANDIDATE_BASES = ['any', ...SUPPORTED_GENERATE_BASES] as const;
const CANDIDATE_VARIANTS = [
  undefined,
  'qwen3_06b',
  'qwen3_4b',
  'qwen3_8b',
  'large',
  'gigantic',
  'dev',
  'klein_4b',
  'klein_9b',
  'ministral3_3b',
  'qwen3_vl_4b',
  'qwen3_vl_8b',
] as const;
/** Ideogram 4's two transformer branches; every other main leaves the field unset. */
const CANDIDATE_BRANCHES = [undefined, 'conditional', 'unconditional'] as const;
/** VAE widths. A served row can constrain the width as well as the base -- Wan ships 16 and 48. */
const CANDIDATE_LATENT_CHANNELS = [undefined, 16, 48] as const;

const candidatesForSlot = (slot: ComponentSlotPolicy): ModelIdentifierConfig[] => {
  const candidates: ModelIdentifierConfig[] = [];

  for (const type of slot.modelTypes) {
    for (const base of CANDIDATE_BASES) {
      for (const variant of CANDIDATE_VARIANTS) {
        for (const latentChannels of type === 'vae' ? CANDIDATE_LATENT_CHANNELS : [undefined]) {
          for (const branch of type === 'main' ? CANDIDATE_BRANCHES : [undefined]) {
            candidates.push({
              base,
              // Distinguish bundled component sources from single-file branch formats.
              format: slot.valueKind === 'main' ? (branch ? 'checkpoint' : 'diffusers') : undefined,
              key: `${base}-${type}-${variant ?? 'novariant'}${latentChannels ? `-${latentChannels}` : ''}${branch ? `-${branch}` : ''}`,
              name: `${base} ${type} ${variant ?? ''} ${branch ?? ''}`.trim(),
              type,
              variant: variant ?? null,
              ...(branch ? { branch } : {}),
              ...(latentChannels ? { latent_channels: latentChannels } : {}),
            });
          }
        }
      }
    }
  }

  return candidates;
};

const buildContext = (
  model: MainModelConfig,
  settings: GenerateSettings,
  slots: readonly ComponentSlotPolicy[]
): ComponentPolicyContext => {
  // Derive keys from slots so new slots enter coverage automatically.
  const keys = new Set<GenerateComponentValueKey>(slots.map((slot) => slot.key));
  const selectedComponents = {} as ComponentPolicyContext['selectedComponents'];

  for (const key of keys) {
    selectedComponents[key] = settings[key] as never;
  }

  return { model, settings, selectedComponents };
};

/** Fill to a fixed point: selecting a component source can change required slots. */
const satisfyRequiredComponents = (
  model: MainModelConfig,
  initial: GenerateSettings
): { settings: GenerateSettings; filled: GenerateComponentValueKey[] } => {
  let settings = initial;
  const filled: GenerateComponentValueKey[] = [];

  for (let pass = 0; pass < 5; pass++) {
    const { slots } = getComponentSectionPolicy(model, settings);
    const context = buildContext(model, settings, slots);
    let changed = false;

    for (const slot of slots) {
      if (!slot.required?.(context) || settings[slot.key]) {
        continue;
      }

      const candidate = candidatesForSlot(slot).find((c) => !slot.filter || slot.filter(c, context));

      if (candidate) {
        settings = { ...settings, [slot.key]: candidate };
        filled.push(slot.key);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return { filled: filled.sort(), settings };
};

const createModel = (base: SupportedGenerateBase, shape: ModelShape): MainModelConfig => ({
  base,
  key: `${base}-${shape.label}`,
  name: `${base} (${shape.label})`,
  type: 'main',
  ...shape.overrides,
});

const satisfiedSettingsFor = (base: SupportedGenerateBase, shape: ModelShape) => {
  const model = createModel(base, shape);

  return {
    model,
    ...satisfyRequiredComponents(model, {
      ...getDefaultGenerateSettings(model),
      positivePrompt: 'a test prompt',
      seed: 1,
      seedMode: 'fixed',
    }),
  };
};

const compileForShape = (
  base: SupportedGenerateBase,
  shape: ModelShape
): { filled: GenerateComponentValueKey[]; graph: BackendGraphContract } => {
  const { filled, model, settings } = satisfiedSettingsFor(base, shape);

  // Assert every requirement before compilation for complete diagnostics.
  expect(getGenerationValidationReasons(model, settings), `${base}/${shape.label} is not satisfiable`).toEqual([]);

  return { filled, graph: compileGenerateGraph(settings, model, 'gallery', { useCpuNoise: true }).backendGraph };
};

const cases = SUPPORTED_GENERATE_BASES.flatMap((base) =>
  shapesForBase(base).map((shape) => ({ base, label: `${base} / ${shape.label}`, shape }))
);

seedArchitectureCapabilities();

describe('generate graph coverage', () => {
  it('has a builder for every supported base and no builder for anything else', () => {
    expect(Object.keys(GRAPH_BUILDERS).sort()).toEqual([...SUPPORTED_GENERATE_BASES].sort());
  });

  it('declares shape overrides only for bases that exist', () => {
    expect(Object.keys(SHAPE_OVERRIDES).filter((base) => !SUPPORTED_GENERATE_BASES.includes(base as never))).toEqual(
      []
    );
  });

  it.each(cases)('compiles a structurally sound graph for $label', ({ base, shape }) => {
    const { graph } = compileForShape(base, shape);
    const nodeIds = new Set(Object.keys(graph.nodes));

    expect(nodeIds.size).toBeGreaterThan(0);

    for (const [id, node] of Object.entries(graph.nodes)) {
      expect(node.id, `node keyed '${id}' carries a mismatched id`).toBe(id);
      expect(node.type, `node '${id}' has no type`).toBeTruthy();
    }

    for (const edge of graph.edges) {
      const description = `${edge.source.node_id}.${edge.source.field} -> ${edge.destination.node_id}.${edge.destination.field}`;

      expect(nodeIds.has(edge.source.node_id), `dangling source in edge ${description}`).toBe(true);
      expect(nodeIds.has(edge.destination.node_id), `dangling destination in edge ${description}`).toBe(true);
      expect(edge.source.field, `edge ${description} has no source field`).toBeTruthy();
      expect(edge.destination.field, `edge ${description} has no destination field`).toBeTruthy();
    }
  });

  it('sends every VAE the picker offers into the graph wherever a VAE is required', () => {
    // Enumerate accepted VAE families at runtime after fixture seeding.
    const checked: string[] = [];

    for (const { base, shape } of cases) {
      const { filled, model, settings } = satisfiedSettingsFor(base, shape);

      if (!filled.includes('vae')) {
        continue;
      }

      const { slots } = getComponentSectionPolicy(model, settings);
      const vaeSlot = slots.find((slot) => slot.key === 'vae')!;
      const context = buildContext(model, settings, slots);
      const offered = new Map<string, ModelIdentifierConfig>();

      for (const candidate of candidatesForSlot(vaeSlot)) {
        if (!vaeSlot.filter || vaeSlot.filter(candidate, context)) {
          offered.set(`${candidate.base}/${String(candidate.latent_channels)}`, candidate);
        }
      }

      for (const vae of offered.values()) {
        const { backendGraph } = compileGenerateGraph({ ...settings, vae: vae as VaeModelConfig }, model, 'gallery', {
          useCpuNoise: true,
        });
        // Metadata records the selection whether or not the builder used it, so it does not count.
        const sent = Object.values(backendGraph.nodes).some(
          (node) => node.type !== 'core_metadata' && JSON.stringify(node).includes(`"${vae.key}"`)
        );

        expect(sent, `${base}/${shape.label} dropped the offered VAE ${vae.key}`).toBe(true);
        checked.push(`${base}/${shape.label}:${vae.base}/${String(vae.latent_channels)}`);
      }
    }

    // Require nonempty cross-base coverage after runtime seeding.
    expect(checked).toEqual(
      expect.arrayContaining([
        'anima/standalone-components:qwen-image/undefined',
        'anima/standalone-components:wan/16',
        'krea-2/standalone-components:anima/undefined',
        'qwen-image/standalone-components:anima/undefined',
        'z-image/standalone-components:flux/undefined',
      ])
    );
  });

  it('emits the node types and fields the backend has to provide', async () => {
    const byBase: Record<string, { componentsFilled: Record<string, string[]>; nodeTypes: string[] }> = {};
    const fields: Record<
      string,
      { inputs: Set<string>; literals: Map<string, Map<string, unknown>>; outputs: Set<string> }
    > = {};

    const fieldsFor = (nodeType: string) =>
      (fields[nodeType] ??= { inputs: new Set(), literals: new Map(), outputs: new Set() });

    for (const { base, shape } of cases) {
      const { filled, graph } = compileForShape(base, shape);
      const entry = (byBase[base] ??= { componentsFilled: {}, nodeTypes: [] });

      entry.componentsFilled[shape.label] = filled;
      entry.nodeTypes = [
        ...new Set([...entry.nodeTypes, ...Object.values(graph.nodes).map((node) => node.type)]),
      ].sort();

      for (const node of Object.values(graph.nodes)) {
        const { literals } = fieldsFor(node.type);

        for (const [field, value] of Object.entries(node)) {
          // Node identity and undefined values are excluded from serialized input contracts.
          if (field === 'id' || field === 'type' || value === undefined) {
            continue;
          }

          const values = literals.get(field) ?? new Map<string, unknown>();
          literals.set(field, values);

          // Check scalar values, not only object names, for synthetic unhashed model fixtures.
          if (value === null || typeof value !== 'object') {
            values.set(JSON.stringify(value), value);
          }
        }
      }

      for (const edge of graph.edges) {
        fieldsFor(graph.nodes[edge.source.node_id]!.type).outputs.add(edge.source.field);
        fieldsFor(graph.nodes[edge.destination.node_id]!.type).inputs.add(edge.destination.field);
      }
    }

    const contract = {
      _comment:
        'Generated by src/features/generation/core/graphCoverage.test.ts; regenerate with ' +
        '`vitest -u`. Excluded from oxfmt so the test alone owns its layout. Consumed by ' +
        'tests/app/invocations/test_frontend_graph_node_types.py, which checks every node type, ' +
        'edge field and literal input value below against the backend invocation registry. An ' +
        'empty literalInputs value list means the field is set to something other than a scalar, ' +
        'so only its name is checked.',
      byBase,
      fieldsByNodeType: Object.fromEntries(
        Object.entries(fields)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([nodeType, { inputs, literals, outputs }]) => [
            nodeType,
            {
              inputs: [...inputs].sort(),
              literalInputs: Object.fromEntries(
                [...literals]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([field, values]) => [
                    field,
                    [...values].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
                  ])
              ),
              outputs: [...outputs].sort(),
            },
          ])
      ),
    };

    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/generateGraphNodeTypes.json'
    );
  });
});
