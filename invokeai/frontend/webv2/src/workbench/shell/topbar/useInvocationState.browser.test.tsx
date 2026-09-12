import type { GenerateWidgetValues, MainModelConfig } from '@features/generation/contracts';
import type { Project } from '@workbench/projectContracts';
import type { ReactNode } from 'react';

import {
  resetArchitectureCapabilities,
  setArchitectureCapabilities,
} from '@features/generation/core/architectureCapabilities';
import { architectureCapabilitiesFixture } from '@features/generation/core/architectureCapabilities.testing';
import { getDefaultGenerateSettings } from '@features/generation/settings';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ project: null as unknown }));

vi.mock('@features/generation/react', () => ({
  useDynamicPrompts: () => ({ count: 1, error: null, isDynamic: false, isError: false, isLoading: false, prompts: [] }),
}));
vi.mock('@features/models', () => ({
  ensureModelsLoaded: () => Promise.resolve(),
  useModelsSelector: (selector: (snapshot: unknown) => unknown) => selector({ models: [sdxlModel], status: 'loaded' }),
}));
vi.mock('@workbench/activeInvocationSubmission', () => ({ submitActiveInvocation: () => Promise.resolve() }));
vi.mock('@workbench/canvasInvocationPreparation', () => ({ useIsCanvasInvocationPreparing: () => false }));
vi.mock('@workbench/WorkbenchContext', () => ({
  useActiveProjectSelector: (selector: (project: Project) => unknown) => selector(harness.project as Project),
  useWorkbenchCommands: () => ({}),
  useWorkbenchQueries: () => ({}),
  useWorkbenchSelector: (selector: (snapshot: unknown) => unknown) =>
    selector({ backendConnection: { status: 'connected' } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { createInitialWorkbenchState, workbenchReducer } from '@workbench/workbenchState.testing';

import { useInvocationState } from './useInvocationState';

const sdxlModel: MainModelConfig = { base: 'sdxl', key: 'sdxl-model', name: 'SDXL', type: 'main' };

const buildProject = (): Project => {
  // The table is needed to derive a *valid* saved project; the point of the test is what happens
  // when the app is restarted and that project is reopened before the table comes back.
  setArchitectureCapabilities(architectureCapabilitiesFixture);
  const values: GenerateWidgetValues = {
    ...getDefaultGenerateSettings(sdxlModel),
    model: sdxlModel,
    modelKey: sdxlModel.key,
    positivePrompt: 'a landscape',
  };
  resetArchitectureCapabilities();

  const state = workbenchReducer(createInitialWorkbenchState(), { type: 'setGenerateSettings', values });
  return state.projects.find((candidate) => candidate.id === state.activeProjectId)!;
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const Probe = (): ReactNode => <span data-testid="reasons">{useInvocationState().blockingReasons.join(' | ')}</span>;

const blockingReasons = (): string => host?.querySelector('[data-testid="reasons"]')?.textContent ?? '';

afterEach(async () => {
  await act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  resetArchitectureCapabilities();
});

describe('useInvocationState and the architecture capability table', () => {
  it('stops blocking Invoke as soon as a retried load succeeds', async () => {
    harness.project = buildProject();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(() => {
      root?.render(<Probe />);
    });

    expect(blockingReasons()).toBe(
      'Model capabilities are not available. Generation is blocked until they load; if this persists, retry from the Generate panel.'
    );

    // The retry button in the Generate widget, succeeding. Nothing else about the project changes,
    // so the route resolution has to be driven by the table's arrival alone.
    await act(() => {
      setArchitectureCapabilities(architectureCapabilitiesFixture);
    });

    expect(blockingReasons()).toBe('');
  });
});
