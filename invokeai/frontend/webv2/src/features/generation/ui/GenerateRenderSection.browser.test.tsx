/* oxlint-disable react-perf/jsx-no-new-object-as-prop */
import type { MainModelConfig } from '@features/generation/core/types';

import { ChakraProvider } from '@chakra-ui/react';
import { seedArchitectureCapabilities } from '@features/generation/core/architectureCapabilities.testing';
import { getDefaultGenerateSettings } from '@features/generation/core/baseGenerationPolicies';
import { system } from '@theme/system';
import { createInstance } from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GenerateRenderSection } from './GenerateRenderSection';

vi.mock('./GenerationUiContext', () => ({
  useGenerationUi: () => ({
    queueInsights: { seedHistory: [] },
    sectionPreferences: { sectionsOpen: { render: true }, setSectionOpen: vi.fn() },
  }),
}));

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  fallbackLng: 'en',
  initAsync: false,
  lng: 'en',
  resources: {
    en: {
      translation: {
        widgets: {
          generate: {
            random: 'Random',
            render: 'Render',
            scheduler: 'Scheduler',
            seed: 'Seed',
            steps: 'Steps',
            useModelDefaultField: 'Use model default {{field}}',
            useModelDefaultScheduler: 'Use model default scheduler',
            useModelDefaultSteps: 'Use model default steps',
          },
        },
      },
    },
  },
});

/**
 * FLUX Fill's own recommendation is `guidance=30`, well past the guidance slider's practical top of
 * 10. That is the case the number input's looser `numberInputMax` exists for: without it the field
 * clamps to the slider's bound the first time it loses focus, and the model's own default is gone
 * before the user has touched anything.
 */
const fluxFillModel: MainModelConfig = {
  base: 'flux',
  default_settings: { cfg_scale: 1, guidance: 30 },
  format: 'diffusers',
  key: 'flux-fill',
  name: 'FLUX Fill',
  type: 'main',
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = (action: () => void): Promise<void> =>
  act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 50);
    });
  });

const render = async (model: MainModelConfig) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const onCommit = vi.fn();

  await settle(() => {
    root?.render(
      <ChakraProvider value={system}>
        <I18nextProvider i18n={i18n}>
          <GenerateRenderSection
            selectedModel={model}
            settings={getDefaultGenerateSettings(model)}
            onCommit={onCommit}
            onCommitImmediate={vi.fn()}
          />
        </I18nextProvider>
      </ChakraProvider>
    );
  });

  return onCommit;
};

afterEach(async () => {
  await settle(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('GenerateRenderSection guidance field', () => {
  // The guidance label and the model's stored guidance both come from the served table now,
  // and the resolver returns nothing without it -- the field would render empty.
  seedArchitectureCapabilities();

  it('does not clamp a model default above the slider track when the field loses focus', async () => {
    const onCommit = await render(fluxFillModel);
    const input = host?.querySelector<HTMLInputElement>('input[aria-label="Guidance"]');

    expect(input?.value).toBe('30');

    await settle(() => input?.focus());
    await settle(() => input?.blur());

    // The commit is the observable, not the input's value: the field is controlled, so the value
    // prop puts 30 back either way and only the caller sees the clamp. Dropping numberInputMax
    // makes this a commit of 10, which is then the value every subsequent graph is compiled with.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('still holds the guidance slider itself to its practical range', async () => {
    await render(fluxFillModel);
    // The thumb is the tooltip trigger, so `role="slider"` is the stable selector. Guidance is the
    // second slider in the section; steps is the first.
    const thumbs = [...(host?.querySelectorAll('[role="slider"]') ?? [])];

    expect(thumbs[1]?.getAttribute('aria-valuenow')).toBe('10');
    expect(thumbs[1]?.getAttribute('aria-valuemax')).toBe('10');
  });
});
