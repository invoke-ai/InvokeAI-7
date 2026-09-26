import type { QueueItem } from '@features/queue/core/historyTypes';
import type { QueueItemReadModel } from '@features/queue/core/types';

import { describe, expect, it } from 'vitest';

import type { RemoteDispatchPlan } from './remoteWorkersDispatch';

import { getRemoteOnlyDispatchDisplay } from './remoteOnlyDispatchDisplay';

const source = {
  id: 'generation-1',
  status: 'completed',
  backendItemIds: [55],
  snapshot: {
    graph: { label: 'Portrait workflow' },
    presentation: { positivePrompt: 'goth elsa' },
    backendSubmission: { kind: 'generate', positivePrompt: 'goth elsa', negativePrompt: 'blurry', seed: 123 },
  },
} as QueueItem;

const launcher = {
  id: 55,
  origin: 'webv2:generation-1',
  status: 'completed',
  fieldValues: [{ nodePath: '__irw_automatic_mirror__', fieldName: 'source_graph_json', value: '{"edges":[]}' }],
} as QueueItemReadModel;

const remoteOnly: RemoteDispatchPlan = { local: false, remoteSlots: [1], remoteUrls: ['http://worker'] };
const mirrored: RemoteDispatchPlan = { ...remoteOnly, local: true };

const plan = (id: string) => (id === source.id ? remoteOnly : null);

describe('Remote-only native queue presenter', () => {
  it('shows the original prompt and metadata, not the launcher JSON, after local completion', () => {
    expect(getRemoteOnlyDispatchDisplay(launcher, [source], plan)).toEqual({
      positivePrompt: 'goth elsa',
      negativePrompt: 'blurry',
      seed: 123,
    });
  });

  it('recovers a historical remote-only launcher after a hard refresh', () => {
    expect(getRemoteOnlyDispatchDisplay(launcher, [source], () => null)?.positivePrompt).toBe('goth elsa');
  });

  it('does not affect ordinary or mirrored local rendering', () => {
    expect(getRemoteOnlyDispatchDisplay(launcher, [source], () => mirrored)).toBeNull();
    expect(getRemoteOnlyDispatchDisplay({ ...launcher, fieldValues: [] }, [source], () => null)).toBeNull();
  });

  it('recovers a missing browser snapshot without displaying serialized graph JSON', () => {
    expect(getRemoteOnlyDispatchDisplay(launcher, [], plan)).toEqual({ positivePrompt: 'Remote workflow' });
    expect(getRemoteOnlyDispatchDisplay({ ...launcher, origin: 'webv2:other' }, [source], plan)).toEqual({
      positivePrompt: 'Remote workflow',
    });
  });

  it('recovers prompt, negative and seed from the persisted per-iteration source graph', () => {
    const graph = JSON.stringify({
      edges: [],
      nodes: {
        positive_prompt: { type: 'string', value: 'second batch prompt' },
        negative_prompt: { type: 'string', value: 'blurry' },
        seed: { type: 'integer', value: 456 },
      },
    });
    const persisted = {
      ...launcher,
      fieldValues: [{ nodePath: '__irw_automatic_mirror__', fieldName: 'source_graph_json', value: graph }],
    };
    expect(getRemoteOnlyDispatchDisplay(persisted, [], () => null)).toEqual({
      positivePrompt: 'second batch prompt',
      negativePrompt: 'blurry',
      seed: 456,
    });
    // Persisted iteration-specific fields beat the initial browser snapshot.
    expect(getRemoteOnlyDispatchDisplay(persisted, [source], plan)?.positivePrompt).toBe('second batch prompt');
  });

  it('shows a safe label for malformed source graphs and leaves normal items alone', () => {
    const malformed = {
      ...launcher,
      fieldValues: [{ nodePath: '__irw_automatic_mirror__', fieldName: 'source_graph_json', value: '{broken' }],
    };
    expect(getRemoteOnlyDispatchDisplay(malformed, [], () => null)).toEqual({ positivePrompt: 'Remote workflow' });
    expect(getRemoteOnlyDispatchDisplay({ ...launcher, fieldValues: [] }, [], () => null)).toBeNull();
  });

  it('resolves a legacy item with no origin from its backend item ID', () => {
    expect(getRemoteOnlyDispatchDisplay({ ...launcher, origin: null }, [source], plan)?.positivePrompt).toBe(
      'goth elsa'
    );
  });
});
