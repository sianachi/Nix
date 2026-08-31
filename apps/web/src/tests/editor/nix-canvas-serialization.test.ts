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
});
