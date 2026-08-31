import { describe, expect, it } from 'vitest';

import { createElement } from '../../editor/nix-canvas-model';
import { parseCanvas, serializeCanvas } from '../../editor/nix-canvas-serialization';

describe('the native canvas interchange format', () => {
  it('round-trips a versioned scene without losing element data', () => {
    const scene = [createElement('rectangle', { x: 10, y: 20 }, 'z00000')];

    expect(parseCanvas(serializeCanvas(scene))).toEqual({ version: 1, elements: scene });
  });

  it('rejects malformed or unsupported documents at the runtime boundary', () => {
    expect(() => parseCanvas('{"version":2,"elements":[]}')).toThrow();
    expect(() => parseCanvas('{"version":1,"elements":[{"type":"unknown"}]}')).toThrow();
  });

  it('imports compatible legacy scenes without requiring the legacy editor package', () => {
    const legacy = JSON.stringify({
      elements: [
        { id: 'rectangle-1', type: 'rectangle', x: 4, y: 8, width: 20, height: 30 },
        { id: 'path-1', type: 'freedraw', x: 10, y: 20, points: [[0, 0], [4, 5]] },
      ],
    });

    expect(parseCanvas(legacy).elements).toEqual([
      expect.objectContaining({ id: 'rectangle-1', type: 'rectangle', x: 4 }),
      expect.objectContaining({ id: 'path-1', type: 'freehand', points: [{ x: 10, y: 20 }, { x: 14, y: 25 }] }),
    ]);
  });

  it('refuses legacy elements it cannot represent instead of dropping them', () => {
    expect(() => parseCanvas(JSON.stringify({ elements: [{ id: 'image-1', type: 'image' }] }))).toThrow(
      'Unsupported legacy canvas element',
    );
  });
});
