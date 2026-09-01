import { z } from 'zod';

import { parseCanvas, type NixCanvasDocument } from './nix-canvas-serialization';
import type { NixCanvasElement } from './nix-canvas-model';

const nativeLibraryItemSchema = z.object({
  type: z.literal('nix-canvas-library-item'),
  name: z.string().min(1),
  document: z.string().min(1),
});

export interface NixCanvasLibraryItem {
  readonly type: 'nix-canvas-library-item';
  readonly name: string;
  readonly document: string;
}

export function parseNativeLibraryItems(items: readonly unknown[]): NixCanvasLibraryItem[] {
  return items.flatMap((item) => {
    const parsed = nativeLibraryItemSchema.safeParse(item);
    if (!parsed.success) return [];
    try {
      parseCanvas(parsed.data.document);
      return [parsed.data];
    } catch {
      return [];
    }
  });
}

export function createNativeLibraryItem(
  name: string,
  elements: readonly NixCanvasElement[],
): NixCanvasLibraryItem {
  return {
    type: 'nix-canvas-library-item',
    name: name.trim() || 'Canvas shape',
    document: JSON.stringify({ version: 1, elements }),
  };
}

export function instantiateLibraryItem(
  item: NixCanvasLibraryItem,
  offset: { readonly x: number; readonly y: number },
): NixCanvasElement[] {
  const document: NixCanvasDocument = parseCanvas(item.document);
  return document.elements
    .filter((element) => !element.isDeleted)
    .map((element) => ({
      ...element,
      id: crypto.randomUUID(),
      x: element.x + offset.x,
      y: element.y + offset.y,
      isDeleted: false,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2_000_000_000),
    }));
}
