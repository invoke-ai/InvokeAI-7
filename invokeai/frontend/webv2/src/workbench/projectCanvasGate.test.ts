import { describe, expect, it } from 'vitest';

import { createEmptyCanvasState } from './canvasMigration';
import { gateProjectCanvases } from './projectCanvasGate';

const canvas = createEmptyCanvasState();
const queueItem = (id: string, itemCanvas: unknown) => ({ id, snapshot: { canvas: itemCanvas } });

describe('gateProjectCanvases', () => {
  it('admits a project whose live and queued canvases load', () => {
    expect(gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [queueItem('q', canvas)] } })).toBeNull();
    expect(gateProjectCanvases({ id: 'legacy', name: 'Legacy' })).toBeNull();
    expect(gateProjectCanvases('not a project')).toBeNull();
  });

  it('refuses a project whose live canvas is unsupported or invalid, keeping the raw document', () => {
    const future = { canvas: { ...canvas, version: 4 }, id: 'p', name: 'P' };
    const broken = { canvas: { ...canvas, version: '2' }, id: 'p', name: 'P' };

    expect(gateProjectCanvases(future)).toMatchObject({
      projectId: 'p',
      projectName: 'P',
      raw: future,
      refusal: { scope: 'state', status: 'unsupported-version', version: 4 },
      source: 'canvas',
    });
    expect(gateProjectCanvases(broken)).toMatchObject({
      raw: broken,
      refusal: { status: 'invalid' },
      source: 'canvas',
    });
  });

  it('refuses a project for any invalid queue canvas before normalization, naming the item', () => {
    const invalidItem = queueItem('invalid', { ...canvas, version: '2' });
    const futureItem = queueItem('future', { ...canvas, version: 4 });
    const invalidProject = { canvas, id: 'p', name: 'P', queue: { items: [invalidItem] } };

    expect(gateProjectCanvases(invalidProject)).toMatchObject({
      queueItem: { index: 0, itemId: 'invalid' },
      raw: invalidProject,
      refusal: { status: 'invalid' },
      source: 'queue-item',
    });
    expect(gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [futureItem] } })).toMatchObject({
      queueItem: { index: 0, itemId: 'future' },
      refusal: { status: 'unsupported-version', version: 4 },
      source: 'queue-item',
    });

    expect(
      gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [{ id: 'missing', snapshot: {} }] } })
    ).toMatchObject({
      queueItem: { index: 0, itemId: 'missing' },
      refusal: { status: 'invalid' },
      source: 'queue-item',
    });

    expect(
      gateProjectCanvases({ canvas, id: 'p', name: 'P', queue: { items: [{ id: 'missing', snapshot: null }] } })
    ).toMatchObject({
      queueItem: { index: 0, itemId: 'missing' },
      refusal: { status: 'invalid' },
      source: 'queue-item',
    });
  });
});
