import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport', () => ({
  browserNodesDataPort: {
    buildUrl: (path: string) => `https://api.test${path}`,
    request: vi.fn(),
    requestJson: vi.fn(),
  },
}));

import { nodeExecutionStore } from './nodeExecutionStore';

beforeEach(() => {
  nodeExecutionStore.clearAll();
});

describe('node execution lifecycle', () => {
  it('preserves the latest image across progress and failure transitions', () => {
    nodeExecutionStore.completed({
      invocation_source_id: 'node-1',
      result: { image: { image_name: 'result image.png' } },
    });
    nodeExecutionStore.progress('node-1', 0.5, 'Sampling');
    nodeExecutionStore.failed({ error_message: 'Out of memory', invocation_source_id: 'node-1' });

    expect(nodeExecutionStore.get('node-1')).toEqual({
      error: 'Out of memory',
      outputImageUrl: 'https://api.test/api/v1/images/i/result%20image.png/thumbnail',
      latestOutput: { image: { image_name: 'result image.png' } },
      progress: null,
      progressMessage: null,
      status: 'failed',
    });
  });

  it('keeps only the most recent result of a run', () => {
    nodeExecutionStore.started({ invocation_source_id: 'node-1' });
    nodeExecutionStore.completed({ invocation_source_id: 'node-1', result: { type: 'integer_output', value: 1 } });
    nodeExecutionStore.started({ invocation_source_id: 'node-1' });
    nodeExecutionStore.completed({ invocation_source_id: 'node-1', result: { type: 'integer_output', value: 2 } });

    expect(nodeExecutionStore.get('node-1')?.latestOutput).toEqual({ type: 'integer_output', value: 2 });
  });

  it('settles the named running nodes to the run outcome without disturbing terminal or other nodes', () => {
    nodeExecutionStore.started({ invocation_source_id: 'running' });
    nodeExecutionStore.started({ invocation_source_id: 'other-run' });
    nodeExecutionStore.failed({ error_message: 'failed', invocation_source_id: 'terminal' });

    nodeExecutionStore.settleRunning(['running', 'terminal'], 'completed');

    expect(nodeExecutionStore.get('running')?.status).toBe('completed');
    expect(nodeExecutionStore.get('terminal')?.status).toBe('failed');
    expect(nodeExecutionStore.get('other-run')?.status).toBe('running');

    nodeExecutionStore.settleRunning(['other-run'], 'canceled');

    expect(nodeExecutionStore.get('other-run')).toBeNull();
  });
});
