import { z } from 'zod';

import { CANVAS_ELEMENT_CEILING, type NixCanvasElement } from './nix-canvas-model';
import { isFetchableImageAddress } from '../lib/image-address';

const pointSchema = z.object({ x: z.number(), y: z.number() });
const elementSchema = z.looseObject({
    id: z.string().min(1),
    type: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'text', 'freehand', 'card', 'image']),
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
    imageUrl: z.string().refine((value) => value === '' || isFetchableImageAddress(value), 'Image address must use http or https.').optional(),
    alt: z.string().optional(),
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
  imageUrl: z.string().optional(),
  src: z.string().optional(),
  url: z.string().optional(),
  alt: z.string().optional(),
});
const legacyDocumentSchema = z.looseObject({ elements: z.array(legacyElementSchema).max(CANVAS_ELEMENT_CEILING) });

export interface NixCanvasDocument {
  readonly version: 1;
  readonly elements: readonly NixCanvasElement[];
}

export function serializeCanvas(elements: readonly NixCanvasElement[]): string {
  return JSON.stringify({ version: 1, elements });
}

export function serializeCanvasSvg(elements: readonly NixCanvasElement[]): string {
  const shapes = elements
    .filter((element) => !element.isDeleted)
    .map((element) => {
      if (element.type === 'ellipse') {
        return `<ellipse cx="${number(element.x + element.width / 2)}" cy="${number(element.y + element.height / 2)}" rx="${number(element.width / 2)}" ry="${number(element.height / 2)}" fill="currentColor" opacity="${number(element.opacity ?? 1)}" />`;
      }
      if (element.type === 'line' || element.type === 'arrow') {
        return `<line x1="${number(element.x)}" y1="${number(element.y)}" x2="${number(element.x + element.width)}" y2="${number(element.y + element.height)}" stroke="currentColor" fill="none" />`;
      }
      if (element.type === 'freehand') {
        return `<path d="${pathFor(element.points ?? [])}" stroke="currentColor" fill="none" opacity="${number(element.opacity ?? 1)}" />`;
      }
      if (element.type === 'text') {
        return `<text x="${number(element.x)}" y="${number(element.y + 28)}" fill="currentColor">${escapeXml(element.text ?? 'Text')}</text>`;
      }
      if (element.type === 'card') {
        return `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" rx="${number(element.cornerRadius ?? 0)}" fill="currentColor" opacity="${number(element.opacity ?? 1)}" />`;
      }
      if (element.type === 'image') {
        if (element.imageUrl === undefined || element.imageUrl === '') {
          return `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" fill="none" stroke="currentColor" />`;
        }
        return `<image href="${escapeXml(element.imageUrl)}" x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" preserveAspectRatio="xMidYMid meet" />`;
      }
      return `<rect x="${number(element.x)}" y="${number(element.y)}" width="${number(element.width)}" height="${number(element.height)}" rx="${number(element.cornerRadius ?? 0)}" fill="currentColor" opacity="${number(element.opacity ?? 1)}" />`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">${shapes}</svg>`;
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
  if (!['rectangle', 'ellipse', 'line', 'arrow', 'text', 'freehand', 'image'].includes(type)) {
    throw new Error(`Unsupported legacy canvas element: ${element.type}`);
  }
  const imageUrl = type === 'image' ? element.imageUrl ?? element.src ?? element.url : undefined;
  if (type === 'image' && (imageUrl === undefined || !isFetchableImageAddress(imageUrl))) {
    throw new Error('Unsupported legacy image source.');
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
    ...(imageUrl === undefined ? {} : { imageUrl }),
    ...(element.alt === undefined ? {} : { alt: element.alt }),
    ...(points === undefined ? {} : { points }),
  };
}

function pathFor(points: readonly { readonly x: number; readonly y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${number(point.x)} ${number(point.y)}`).join(' ');
}

function number(value: number): string {
  return String(value);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character);
}
