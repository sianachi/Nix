import { z } from 'zod';

import { CANVAS_ELEMENT_CEILING, type NixCanvasElement } from './nix-canvas-model';

const pointSchema = z.object({ x: z.number(), y: z.number() });
const elementSchema = z.looseObject({
    id: z.string().min(1),
    type: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'text', 'freehand', 'card']),
    version: z.number().int().nonnegative(),
    versionNonce: z.number().int().nonnegative(),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    isDeleted: z.boolean().optional(),
    index: z.string().optional(),
    text: z.string().optional(),
    itemId: z.string().optional(),
    fill: z.enum(['accent', 'surface', 'none']).optional(),
    stroke: z.enum(['foreground', 'accent', 'muted']).optional(),
    opacity: z.number().min(0).max(1).optional(),
    cornerRadius: z.number().nonnegative().optional(),
    points: z.array(pointSchema).optional(),
  });

const documentSchema = z.object({ version: z.literal(1), elements: z.array(elementSchema).max(CANVAS_ELEMENT_CEILING) });

export interface NixCanvasDocument {
  readonly version: 1;
  readonly elements: readonly NixCanvasElement[];
}

export function serializeCanvas(elements: readonly NixCanvasElement[]): string {
  return JSON.stringify({ version: 1, elements });
}

export function parseCanvas(serialized: string): NixCanvasDocument {
  const parsed = documentSchema.parse(JSON.parse(serialized));
  return { version: 1, elements: parsed.elements as NixCanvasElement[] };
}
