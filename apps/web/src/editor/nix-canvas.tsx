import { Button, Icon, Text } from '@nix/ui';
import {
  Circle,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  createElement,
  type CanvasPoint,
  type NixCanvasElement,
  type NixCanvasElementType,
  type CanvasFill,
  updateElement,
} from './nix-canvas-model';

export interface NixCanvasProps {
  readonly elements: readonly NixCanvasElement[];
  readonly onChange: (elements: readonly NixCanvasElement[]) => void;
}

type Tool = 'select' | NixCanvasElementType;
interface DragState {
  readonly id: string;
  readonly start: CanvasPoint;
  readonly origin: NixCanvasElement;
  readonly before: readonly NixCanvasElement[];
  readonly resize: boolean;
}

const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  freehand: 'Freehand',
};

export function NixCanvas({ elements, onChange }: NixCanvasProps): ReactNode {
  const [tool, setTool] = useState<Tool>('select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [past, setPast] = useState<readonly NixCanvasElement[][]>([]);
  const [future, setFuture] = useState<readonly NixCanvasElement[][]>([]);
  const [textDraft, setTextDraft] = useState('');
  const dragRef = useRef<DragState | null>(null);
  const drawingRef = useRef<CanvasPoint[] | null>(null);
  const [drawingPoints, setDrawingPoints] = useState<readonly CanvasPoint[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);

  const visible = elements.filter((element) => !element.isDeleted);
  const selected = visible.find((element) => element.id === selectedId) ?? null;

  const commit = useCallback(
    (next: readonly NixCanvasElement[]): void => {
      setPast((current) => [...current, [...elements]]);
      setFuture([]);
      onChange(next);
    },
    [elements, onChange],
  );

  const undo = useCallback((): void => {
    const previous = past.at(-1);
    if (previous === undefined) return;
    setPast((current) => current.slice(0, -1));
    setFuture((current) => [[...elements], ...current]);
    onChange(previous);
  }, [elements, onChange, past]);

  const redo = useCallback((): void => {
    const next = future[0];
    if (next === undefined) return;
    setFuture((current) => current.slice(1));
    setPast((current) => [...current, [...elements]]);
    onChange(next);
  }, [elements, future, onChange]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (selectedId !== null && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        const selectedElement = elements.find((element) => element.id === selectedId);
        if (selectedElement === undefined) return;
        const distance = event.shiftKey ? 10 : 1;
        const delta = {
          ArrowUp: { x: 0, y: -distance },
          ArrowDown: { x: 0, y: distance },
          ArrowLeft: { x: -distance, y: 0 },
          ArrowRight: { x: distance, y: 0 },
        }[event.key];
        if (delta === undefined) return;
        commit(
          elements.map((element) =>
            element.id === selectedId
              ? updateElement(element, { x: element.x + delta.x, y: element.y + delta.y })
              : element,
          ),
        );
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== null) {
        event.preventDefault();
        const next = elements.map((element) =>
          element.id === selectedId ? updateElement(element, { isDeleted: true }) : element,
        );
        commit(next);
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [commit, elements, redo, selectedId, undo]);

  function pointFromEvent(event: PointerEvent<SVGSVGElement>): CanvasPoint {
    const svg = svgRef.current;
    if (svg === null) return { x: 0, y: 0 };
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const transformed = point.matrixTransform(svg.getScreenCTM()?.inverse());
    return { x: transformed.x, y: transformed.y };
  }

  function addAt(point: CanvasPoint): void {
    if (tool === 'freehand') {
      drawingRef.current = [point];
      setDrawingPoints([point]);
      return;
    }
    if (tool === 'select') {
      setSelectedId(null);
      return;
    }
    const next = [...elements, createElement(tool, point, `z${String(elements.length).padStart(5, '0')}`)];
    commit(next);
    const added = next.at(-1);
    setSelectedId(added?.id ?? null);
    setTextDraft(added?.text ?? '');
    setTool('select');
  }

  function commitText(): void {
    if (selected?.type !== 'text' || selected.text === textDraft) return;
    commit(elements.map((element) => (element.id === selected.id ? updateElement(element, { text: textDraft }) : element)));
  }

  function updateSelected(changes: Partial<Pick<NixCanvasElement, 'fill' | 'stroke' | 'opacity'>>): void {
    if (selected === null) return;
    commit(elements.map((element) => (element.id === selected.id ? updateElement(element, changes) : element)));
  }

  function startDrag(event: PointerEvent<SVGGraphicsElement>, element: NixCanvasElement, resize = false): void {
    event.stopPropagation();
    const point = pointFromEvent(event as unknown as PointerEvent<SVGSVGElement>);
    setSelectedId(element.id);
    setTextDraft(element.text ?? '');
    dragRef.current = { id: element.id, start: point, origin: element, before: [...elements], resize };
    (event.currentTarget).setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null) return;
    const point = pointFromEvent(event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    const next = elements.map((element) => {
      if (element.id !== drag.id) return element;
      if (drag.resize) {
        return updateElement(element, {
          width: Math.max(40, drag.origin.width + dx),
          height: Math.max(30, drag.origin.height + dy),
        });
      }
      return updateElement(element, { x: drag.origin.x + dx, y: drag.origin.y + dy });
    });
    onChange(next);
  }

  function finishDrag(): void {
    const drag = dragRef.current;
    if (drag !== null && elements.some((element) => element.id === drag.id && element !== drag.origin)) {
      setPast((current) => [...current, [...drag.before]]);
      setFuture([]);
    }
    dragRef.current = null;
  }

  function finishDrawing(): void {
    const points = drawingRef.current;
    if (points === null) return;
    drawingRef.current = null;
    setDrawingPoints([]);
    if (points.length < 2) return;
    const left = Math.min(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    const base = createElement('freehand', { x: left, y: top }, `z${String(elements.length).padStart(5, '0')}`);
    const drawn = updateElement(base, {
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    });
    commit([...elements, { ...drawn, points }]);
    setSelectedId(drawn.id);
    setTool('select');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-divider px-4 py-2" role="toolbar" aria-label="Canvas tools">
        {(Object.keys(TOOL_LABELS) as Tool[]).map((candidate) => {
          const glyph = candidate === 'select' ? MousePointer2 : candidate === 'rectangle' ? Square : candidate === 'ellipse' ? Circle : candidate === 'text' ? Type : candidate === 'freehand' ? Pencil : Minus;
          return (
            <Button
              key={candidate}
              variant="icon"
              aria-label={TOOL_LABELS[candidate]}
              aria-pressed={tool === candidate}
              className={tool === candidate ? 'bg-accent/15 text-accent-text' : ''}
              onClick={() => { setTool(candidate); }}
            >
              <Icon icon={glyph} size="sm" />
            </Button>
          );
        })}
        <span className="mx-2 h-5 w-px bg-divider" aria-hidden="true" />
        {selected?.type === 'text' ? (
          <input
            aria-label="Text content"
            className="h-(--control-md) min-w-32 rounded-sm bg-surface px-2 text-sm text-foreground outline-2 outline-transparent focus-visible:outline-accent"
            value={textDraft}
            onChange={(event) => { setTextDraft(event.target.value); }}
            onBlur={commitText}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitText();
              }
            }}
          />
        ) : null}
        {selected !== null && selected.type !== 'line' && selected.type !== 'arrow' && selected.type !== 'text' ? (
          <span className="ml-2 flex items-center gap-1" aria-label="Fill">
            {(['accent', 'surface', 'none'] as CanvasFill[]).map((fill) => (
              <Button key={fill} variant="ghost" className="px-2 py-1 text-xs" aria-label={`Fill ${fill}`} aria-pressed={(selected.fill ?? 'accent') === fill} onClick={() => { updateSelected({ fill }); }}>
                {fill === 'none' ? 'None' : fill === 'accent' ? 'Accent' : 'Surface'}
              </Button>
            ))}
          </span>
        ) : null}
        <Button variant="icon" aria-label="Undo" disabled={past.length === 0} onClick={undo}><Icon icon={Undo2} size="sm" /></Button>
        <Button variant="icon" aria-label="Redo" disabled={future.length === 0} onClick={redo}><Icon icon={Redo2} size="sm" /></Button>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="icon" aria-label="Zoom out" onClick={() => { setZoom((value) => Math.max(0.5, value - 0.1)); }}><Icon icon={ZoomOut} size="sm" /></Button>
          <Text as="span" variant="caption" tone="muted" className="min-w-12 text-center">{Math.round(zoom * 100)}%</Text>
          <Button variant="icon" aria-label="Zoom in" onClick={() => { setZoom((value) => Math.min(2, value + 0.1)); }}><Icon icon={ZoomIn} size="sm" /></Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-surface p-6">
        <svg
          ref={svgRef}
          className="mx-auto block max-w-full origin-top-left bg-background shadow-sm"
          style={{ width: `${String(CANVAS_WIDTH * zoom)}px`, height: `${String(CANVAS_HEIGHT * zoom)}px` }}
          viewBox={`0 0 ${String(CANVAS_WIDTH)} ${String(CANVAS_HEIGHT)}`}
          role="application"
          aria-label="Canvas workspace"
          onPointerDown={(event) => { addAt(pointFromEvent(event)); }}
          onPointerMove={(event) => {
            if (drawingRef.current !== null) {
              drawingRef.current = [...drawingRef.current, pointFromEvent(event)];
              setDrawingPoints(drawingRef.current);
            } else {
              moveDrag(event);
            }
          }}
          onPointerUp={() => { finishDrawing(); finishDrag(); }}
          onPointerCancel={() => { finishDrawing(); finishDrag(); }}
        >
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--color-foreground)" />
            </marker>
            <pattern id="canvas-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="var(--color-divider)" strokeWidth="0.6" opacity="0.5" />
            </pattern>
          </defs>
          <rect width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#canvas-grid)" pointerEvents="none" />
          {drawingPoints.length > 1 ? <path d={pathFor(drawingPoints)} fill="none" stroke="var(--color-accent)" strokeWidth="2" pointerEvents="none" /> : null}
          {visible.map((element) => <CanvasShape key={element.id} element={element} selected={element.id === selectedId} onPointerDown={startDrag} />)}
          {selected === null ? null : <ResizeHandle element={selected} onPointerDown={startDrag} />}
        </svg>
      </div>
      <div className="flex shrink-0 items-center justify-between px-4 py-1.5">
        <Text as="span" variant="caption" tone="muted">{selected === null ? `${String(visible.length)} objects` : `${TOOL_LABELS[selected.type]} selected`}</Text>
        <Text as="span" variant="caption" tone="muted">Drag to move. Select a tool, then click the canvas.</Text>
      </div>
    </div>
  );
}

function CanvasShape({ element, selected, onPointerDown }: { readonly element: NixCanvasElement; readonly selected: boolean; readonly onPointerDown: (event: PointerEvent<SVGGraphicsElement>, element: NixCanvasElement) => void }): ReactNode {
  const stroke = selected ? 'var(--color-accent)' : element.stroke === 'accent' ? 'var(--color-accent)' : element.stroke === 'muted' ? 'var(--color-muted)' : 'var(--color-foreground)';
  const fill = element.fill === 'surface' ? 'var(--color-surface)' : element.fill === 'none' ? 'none' : 'var(--color-accent-100)';
  const common = { stroke, strokeWidth: selected ? 2.5 : 1.5, onPointerDown: (event: PointerEvent<SVGGraphicsElement>) => { onPointerDown(event, element); } };
  if (element.type === 'ellipse') return <ellipse cx={element.x + element.width / 2} cy={element.y + element.height / 2} rx={element.width / 2} ry={element.height / 2} fill={fill} opacity={element.opacity ?? 1} {...common} />;
  if (element.type === 'line' || element.type === 'arrow') return <line x1={element.x} y1={element.y} x2={element.x + element.width} y2={element.y + element.height} fill="none" {...common} markerEnd={element.type === 'arrow' ? 'url(#arrow)' : undefined} />;
  if (element.type === 'freehand') return <path d={pathFor(element.points ?? [])} fill="none" {...common} opacity={element.opacity ?? 1} />;
  if (element.type === 'text') return <text x={element.x} y={element.y + 28} fill="var(--color-foreground)" fontFamily="var(--font-body)" fontSize="24" {...common}>{element.text ?? 'Text'}</text>;
  return <rect x={element.x} y={element.y} width={element.width} height={element.height} rx={element.cornerRadius ?? 0} fill={fill} opacity={element.opacity ?? 1} {...common} />;
}

function pathFor(points: readonly CanvasPoint[]): string {
  const first = points[0];
  if (first === undefined) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${String(point.x)} ${String(point.y)}`).join(' ');
}

function ResizeHandle({ element, onPointerDown }: { readonly element: NixCanvasElement; readonly onPointerDown: (event: PointerEvent<SVGGraphicsElement>, element: NixCanvasElement, resize?: boolean) => void }): ReactNode {
  return <rect x={element.x + element.width - 7} y={element.y + element.height - 7} width="14" height="14" fill="var(--color-accent-fill)" stroke="var(--color-background)" strokeWidth="2" cursor="nwse-resize" aria-label="Resize selected object" onPointerDown={(event) => { onPointerDown(event, element, true); }} />;
}
