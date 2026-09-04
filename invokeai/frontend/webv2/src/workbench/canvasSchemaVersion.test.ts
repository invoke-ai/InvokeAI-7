import { describe, expect, it } from 'vitest';

import { getProjectCanvasSchemaRequirement } from './canvasSchemaVersion';

describe('getProjectCanvasSchemaRequirement', () => {
  it('uses the highest schema version across the live canvas and queue snapshots', () => {
    expect(
      getProjectCanvasSchemaRequirement({
        canvas: { version: 2 },
        queue: {
          items: [{ snapshot: { canvas: { version: 2 } } }, { snapshot: { canvas: { version: 3 } } }],
        },
      })
    ).toBe(3);
  });

  it.each([
    ['the live canvas is missing', {}],
    ['the live version is malformed', { canvas: { version: '2' } }],
    ['a queue snapshot is malformed', { canvas: { version: 2 }, queue: { items: [{}] } }],
  ])('fails closed when %s', (_label, document) => {
    expect(() => getProjectCanvasSchemaRequirement(document)).toThrow();
  });
});
