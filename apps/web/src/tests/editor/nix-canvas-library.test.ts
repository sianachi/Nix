import { describe, expect, it } from 'vitest';

import { createElement } from '../../editor/nix-canvas-model';
import {
  createNativeLibraryItem,
  instantiateLibraryItem,
  parseNativeLibraryItems,
} from '../../editor/nix-canvas-library';

describe('native canvas library items', () => {
  it('accepts only versioned native documents and ignores legacy entries', () => {
    const item = createNativeLibraryItem('Callout', [createElement('rectangle', { x: 10, y: 20 }, 'z00000')]);

    expect(parseNativeLibraryItems([item, { type: 'excalidraw-library-item' }])).toEqual([item]);
    expect(parseNativeLibraryItems([{ ...item, document: '{"version":2}' }])).toEqual([]);
  });

  it('instantiates a library item with fresh identity and a placement offset', () => {
    const source = createElement('text', { x: 10, y: 20 }, 'z00000');
    const item = createNativeLibraryItem('Label', [source]);
    const [instance] = instantiateLibraryItem(item, { x: 100, y: 50 });

    expect(instance).toMatchObject({ x: 110, y: 70, version: 1, isDeleted: false });
    expect(instance?.id).not.toBe(source.id);
  });
});
