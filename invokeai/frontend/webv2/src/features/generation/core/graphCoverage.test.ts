/**
 * Every supported base compiles a graph — the systematic counterpart to `graph.test.ts`.
 *
 * `graph.test.ts` asserts *what* individual families wire up, one hand-written case at a time. That
 * leaves a base added to `BASE_GENERATION` and `GRAPH_BUILDERS` but never given a case silently
 * untested. This file instead iterates `SUPPORTED_GENERATE_BASES`, so a new architecture is covered
 * the moment it is registered, and asserts the properties that hold for *all* of them: the
 * component policy is satisfiable, the builder runs, and the resulting graph is structurally sound.
 *
 * It also writes the node types each base emits to a file snapshot. That file is the frontend half
 * of a cross-stack contract — `tests/app/invocations/test_frontend_graph_node_types.py` reads it and
 * checks every type against the backend's `InvocationRegistry`. A node moved between modules and
 * accidentally renamed shows up there, which no frontend-only assertion can see.
 */

import type { BackendGraphContract } from '@features/generation/core/contracts';

import { describe, expect, it } from 'vitest';

import type {
  ComponentPolicyContext,
  ComponentSlotPolicy,
  GenerateComponentValueKey,
  SupportedGenerateBase,
} from './baseGenerationPolicies';
import type { GenerateSettings, MainModelConfig, ModelIdentifierConfig } from './types';

import {
  getComponentSectionPolicy,
  getDefaultGenerateSettings,
  getGenerationValidationReasons,
  SUPPORTED_GENERATE_BASES,
} from './baseGenerationPolicies';
import { compileGenerateGraph, GRAPH_BUILDERS } from './graph';

/**
 * Main-model shapes to compile per base.
 *
 * `diffusers` bundles its submodels, so the component slots go optional and the builder takes the
 * bundled path; a quantized single-file main carries only the transformer and forces the standalone
 * -component path. Both paths produce different graphs, so both are worth compiling.
 */
interface ModelShape {
  label: string;
  overrides: Partial<MainModelConfig>;
}

const DEFAULT_SHAPES: readonly ModelShape[] = [
  { label: 'diffusers', overrides: { format: 'diffusers' } },
  { label: 'standalone-components', overrides: { format: 'gguf_quantized' } },
];

/**
 * Bases whose builder needs more than a format to pick a path. Keys are checked against
 * `SUPPORTED_GENERATE_BASES` below, so a renamed or removed base cannot leave a stale entry here.
 */
const SHAPE_OVERRIDES: Partial<Record<SupportedGenerateBase, readonly ModelShape[]>> = {
  // The two FLUX.2 lines take different encoders: [dev] wants Mistral, Klein wants a Qwen3 whose
  // variant is pinned to the Klein size by KLEIN_TO_QWEN3_VARIANT.
  flux2: [
    { label: 'dev-diffusers', overrides: { format: 'diffusers', variant: 'dev' } },
    { label: 'dev-standalone', overrides: { format: 'gguf_quantized', variant: 'dev' } },
    { label: 'klein-9b-standalone', overrides: { format: 'gguf_quantized', variant: 'klein_9b' } },
  ],
};

const shapesForBase = (base: SupportedGenerateBase): readonly ModelShape[] => SHAPE_OVERRIDES[base] ?? DEFAULT_SHAPES;

/**
 * Candidate components the slot filters get to choose from.
 *
 * Deliberately a search over a pool rather than a hand-written model per slot: the filters
 * (`isAnimaQwen3Encoder`, `isKrea2Vae`, `isFlux2Qwen3EncoderForModel`, ...) encode which base and
 * variant a component must carry, and duplicating that knowledge here would make the test agree
 * with itself instead of with the policy.
 */
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
] as const;

const candidatesForSlot = (slot: ComponentSlotPolicy): ModelIdentifierConfig[] => {
  const candidates: ModelIdentifierConfig[] = [];

  for (const type of slot.modelTypes) {
    for (const base of CANDIDATE_BASES) {
      for (const variant of CANDIDATE_VARIANTS) {
        candidates.push({
          base,
          // A component source is a main model, and only a bundled one can stand in for the slots
          // it satisfies — `isDiffusersMainForBase` and `isBundledMainForBase` both demand it.
          format: slot.valueKind === 'main' ? 'diffusers' : undefined,
          key: `${base}-${type}-${variant ?? 'novariant'}`,
          name: `${base} ${type} ${variant ?? ''}`.trim(),
          type,
          variant: variant ?? null,
        });
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
  // Derived from the slots rather than from a hand-kept key list: a new slot key is picked up here
  // automatically, and a key that no slot uses cannot go stale.
  const keys = new Set<GenerateComponentValueKey>(slots.map((slot) => slot.key));
  const selectedComponents = {} as ComponentPolicyContext['selectedComponents'];

  for (const key of keys) {
    selectedComponents[key] = settings[key] as never;
  }

  return { model, settings, selectedComponents };
};

/**
 * Fill every required component slot with something the slot's own filter accepts.
 *
 * Iterated to a fixpoint because slots are interdependent: selecting a component source can make
 * the VAE and encoder slots stop being required, so one pass is not enough to reach a stable answer.
 */
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

const compileForShape = (
  base: SupportedGenerateBase,
  shape: ModelShape
): { filled: GenerateComponentValueKey[]; graph: BackendGraphContract } => {
  const model = createModel(base, shape);
  const { filled, settings } = satisfyRequiredComponents(model, {
    ...getDefaultGenerateSettings(model),
    positivePrompt: 'a test prompt',
    seed: 1,
    shouldRandomizeSeed: false,
  });

  // Compiling an invalid selection throws the first reason, which makes for a poor failure message.
  // Asserting here reports every unmet requirement at once, and doubles as the check that the
  // base's component policy is satisfiable at all.
  expect(getGenerationValidationReasons(model, settings), `${base}/${shape.label} is not satisfiable`).toEqual([]);

  return { filled, graph: compileGenerateGraph(settings, model, 'gallery', { useCpuNoise: true }).backendGraph };
};

const cases = SUPPORTED_GENERATE_BASES.flatMap((base) =>
  shapesForBase(base).map((shape) => ({ base, label: `${base} / ${shape.label}`, shape }))
);

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

  it('emits the node types and fields the backend has to provide', async () => {
    const byBase: Record<string, { componentsFilled: Record<string, string[]>; nodeTypes: string[] }> = {};
    const fields: Record<string, { inputs: Set<string>; outputs: Set<string> }> = {};

    const fieldsFor = (nodeType: string) => (fields[nodeType] ??= { inputs: new Set(), outputs: new Set() });

    for (const { base, shape } of cases) {
      const { filled, graph } = compileForShape(base, shape);
      const entry = (byBase[base] ??= { componentsFilled: {}, nodeTypes: [] });

      entry.componentsFilled[shape.label] = filled;
      entry.nodeTypes = [
        ...new Set([...entry.nodeTypes, ...Object.values(graph.nodes).map((node) => node.type)]),
      ].sort();

      for (const edge of graph.edges) {
        fieldsFor(graph.nodes[edge.source.node_id]!.type).outputs.add(edge.source.field);
        fieldsFor(graph.nodes[edge.destination.node_id]!.type).inputs.add(edge.destination.field);
      }
    }

    const contract = {
      _comment:
        'Generated by src/features/generation/core/graphCoverage.test.ts. Update with `vitest -u`. ' +
        'Consumed by tests/app/invocations/test_frontend_graph_node_types.py, which checks every ' +
        'node type and field below against the backend invocation registry.',
      byBase,
      fieldsByNodeType: Object.fromEntries(
        Object.entries(fields)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([nodeType, { inputs, outputs }]) => [
            nodeType,
            { inputs: [...inputs].sort(), outputs: [...outputs].sort() },
          ])
      ),
    };

    await expect(`${JSON.stringify(contract, null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/generateGraphNodeTypes.json'
    );
  });
});
