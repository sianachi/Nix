import type { CanvasElement } from './canvas-binding';

export type NixCanvasElementType = 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'freehand' | 'card';
export type CanvasFill = 'accent' | 'surface' | 'none';
export type CanvasStroke = 'foreground' | 'accent' | 'muted';

export interface NixCanvasElement extends CanvasElement {
  readonly type: NixCanvasElementType;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text?: string;
  readonly isDeleted?: boolean;
  readonly fill?: CanvasFill;
  readonly stroke?: CanvasStroke;
  readonly opacity?: number;
  readonly cornerRadius?: number;
  readonly points?: readonly CanvasPoint[];
  readonly itemId?: string;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const CANVAS_WIDTH = 1200;
export const CANVAS_HEIGHT = 800;
export const CANVAS_ELEMENT_CEILING = 10_000;
export const FREEHAND_POINT_CEILING = 2_000;

export function boundedPoints(points: readonly CanvasPoint[]): CanvasPoint[] {
  if (points.length <= FREEHAND_POINT_CEILING) return [...points];
  const step = (points.length - 1) / (FREEHAND_POINT_CEILING - 1);
  return Array.from({ length: FREEHAND_POINT_CEILING }, (_, index) => points[Math.round(index * step)]).filter(
    (point): point is CanvasPoint => point !== undefined,
  );
}

export function intersectsViewport(element: NixCanvasElement, viewport: CanvasViewport): boolean {
  return element.x < viewport.x + viewport.width && element.x + element.width > viewport.x && element.y < viewport.y + viewport.height && element.y + element.height > viewport.y;
}

export function clampViewport(viewport: CanvasViewport): CanvasViewport {
  const maxX = Math.max(0, CANVAS_WIDTH - viewport.width);
  const maxY = Math.max(0, CANVAS_HEIGHT - viewport.height);
  return {
    ...viewport,
    x: Math.min(maxX, Math.max(0, viewport.x)),
    y: Math.min(maxY, Math.max(0, viewport.y)),
  };
}

export function renderableElements(
  elements: readonly NixCanvasElement[],
  viewport: CanvasViewport,
): NixCanvasElement[] {
  return elements
    .filter((element) => !element.isDeleted && intersectsViewport(element, viewport))
    .slice(0, CANVAS_ELEMENT_CEILING);
}

export function createElement(
  type: NixCanvasElementType,
  point: CanvasPoint,
  index: string,
): NixCanvasElement {
  const dimensions = type === 'text' ? { width: 160, height: 40 } : type === 'card' ? { width: 240, height: 120 } : { width: 180, height: 110 };
  return {
    id: crypto.randomUUID(),
    type,
    version: 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
    x: point.x,
    y: point.y,
    width: dimensions.width,
    height: dimensions.height,
    index,
    ...(type === 'text' ? { text: 'Text' } : {}),
    ...(type === 'card' ? { itemId: '' } : {}),
    fill: type === 'text' || type === 'line' || type === 'arrow' || type === 'freehand' ? 'none' : 'accent',
    stroke: 'foreground',
    opacity: 1,
    cornerRadius: type === 'rectangle' ? 12 : 0,
  };
}

export function updateElement(
  element: NixCanvasElement,
  changes: Partial<Pick<NixCanvasElement, 'x' | 'y' | 'width' | 'height' | 'text' | 'isDeleted' | 'fill' | 'stroke' | 'opacity' | 'cornerRadius' | 'itemId'>>,
): NixCanvasElement {
  return {
    ...element,
    ...changes,
    version: element.version + 1,
    versionNonce: Math.floor(Math.random() * 2_000_000_000),
  };
}

export function boundsOf(elements: readonly NixCanvasElement[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} | null {
  const visible = elements.filter((element) => !element.isDeleted);
  if (visible.length === 0) return null;
  const left = Math.min(...visible.map((element) => element.x));
  const top = Math.min(...visible.map((element) => element.y));
  const right = Math.max(...visible.map((element) => element.x + element.width));
  const bottom = Math.max(...visible.map((element) => element.y + element.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
