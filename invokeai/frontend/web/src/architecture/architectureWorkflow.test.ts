import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('architecture workflow', () => {
  it('confines unstable TypeScript imports to the source-analysis adapter', () => {
    const modules = import.meta.glob(['../**/*.{ts,tsx}', '../../scripts/**/*.{js,mjs,cjs,ts,mts,cts}'], {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>;
    const unstablePrefix = ['typescript', 'unstable'].join('/');
    const offenders = Object.entries(modules)
      .filter(
        ([path, source]) =>
          (!path.endsWith('/tsSourceAnalysis.ts') && source.includes(unstablePrefix)) ||
          (path.includes('/scripts/') && source.includes('./parse-source.mjs'))
      )
      .map(([path]) => path)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('runs the release gates with base comparisons and retains diagnostics even on failure', () => {
    const workflows = import.meta.glob('../../../../../.github/workflows/frontend-tests.yml', {
      eager: true,
      import: 'default',
      query: '?raw',
    }) as Record<string, string>;
    const workflow = Object.values(workflows)[0] ?? '';

    expect(workflow).toContain('name: webv2-architecture-review');
    expect(workflow).toContain('invokeai/frontend/webv2/artifacts/architecture');
    expect(workflow).toContain('invokeai/frontend/webv2/artifacts/architecture-performance');
    expect(workflow).toContain('invokeai/frontend/webv2/artifacts/accessibility');
    expect(workflow).toContain('if: ${{ always()');

    const jobs = parse(workflow).jobs;
    const completion = jobs['frontend-webv2-tests'].steps.find((step: { run?: string }) =>
      step.run?.startsWith('pnpm check:')
    );
    expect(completion.run).toBe('pnpm check:release');
    expect(completion.env.WEBV2_PERF_REFERENCE_DIR).toContain('steps.perf-ref.outputs.cache-matched-key');
  });
});
