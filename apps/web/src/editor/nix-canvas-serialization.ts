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
const legacyElementSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  versionNonce: z.number().int().nonnegative().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  text: z.string().optional(),
  index: z.string().optional(),
  isDeleted: z.boolean().optional(),
  points: z.array(z.unknown()).optional(),
});
const legacyDocumentSchema = z.looseObject({ elements: z.array(legacyElementSchema).max(CANVAS_ELEMENT_CEILING) });

export interface NixCanvasDocument {
  readonly version: 1;
  readonly elements: readonly NixCanvasElement[];
}

export function serializeCanvas(elements: readonly NixCanvasElement[]): string {
  return JSON.stringify({ version: 1, elements });
}

export function parseCanvas(serialized: string): NixCanvasDocument {
  const raw: unknown = JSON.parse(serialized);
  const native = documentSchema.safeParse(raw);
  if (native.success) return { version: 1, elements: native.data.elements as NixCanvasElement[] };
  if (typeof raw === 'object' && raw !== null && 'version' in raw) {
    throw new Error('Unsupported native canvas document version.');
  }

  const legacy = legacyDocumentSchema.parse(raw);
  return { version: 1, elements: legacy.elements.map(legacyElement) };
}

function legacyElement(element: z.infer<typeof legacyElementSchema>): NixCanvasElement {
  const type = element.type === 'diamond' ? 'rectangle' : element.type === 'freedraw' ? 'freehand' : element.type;
  if (!['rectangle', 'ellipse', 'line', 'arrow', 'text', 'freehand'].includes(type)) {
    throw new Error(`Unsupported legacy canvas element: ${element.type}`);
  }
  const points = element.points?.map((point) => {
    if (Array.isArray(point) && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
      return { x: (element.x ?? 0) + point[0], y: (element.y ?? 0) + point[1] };
    }
    if (typeof point === 'object' && point !== null && 'x' in point && 'y' in point && typeof point.x === 'number' && typeof point.y === 'number') {
      return { x: point.x, y: point.y };
    }
    throw new Error('Unsupported legacy freehand point.');
  });
  return {
    id: element.id,
    type: type as NixCanvasElement['type'],
    version: element.version ?? 1,
    versionNonce: element.versionNonce ?? 0,
    x: element.x ?? 0,
    y: element.y ?? 0,
    width: element.width ?? 1,
    height: element.height ?? 1,
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(element.index === undefined ? {} : { index: element.index }),
    ...(element.isDeleted === undefined ? {} : { isDeleted: element.isDeleted }),
    ...(points === undefined ? {} : { points }),
  };
}
