import { Button, Icon, Text, focusRing } from '@nix/ui';
import { FileText, Minus, Plus, Scan } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
} from 'react';

import { indentAt, ROW_INDENT } from '../items/workspace-sidebar';
import {
  applyOffsets,
  buildEdges,
  layoutGraph,
  nodeTitle,
  NODE_RADIUS,
  type Offset,
  type PositionedNode,
} from './graph-layout';
import { atZoom, zoomIn, zoomOut, ZOOM_DEFAULT, type Zoom } from './graph-zoom';
import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * One workspace, drawn.
 *
 * **There are two representations and both are complete.** The `<svg>` is the picture, and it is
 * `aria-hidden`: a scatter of discs and paths conveys nothing through an accessibility tree, and
 * labelling it `role="img"` with a summary would be claiming otherwise. Beside it is a real tree of
 * buttons carrying the same nodes, the same nesting and - the part a drawing genuinely cannot
 * offer - each node's outgoing references named in words.
 *
 * **That tree is `sr-only`, which is a visual decision and not an accessibility one.** On screen it
 * would be a second copy of the workspace stacked under a picture of the workspace, which is
 * clutter; to a screen reader it is the only form of the graph that can be read at all. Hiding it
 * visually costs sighted readers nothing and removing it would cost everyone else the whole view.
 *
 * **The discs are clickable and draggable; they are not focusable.** Pointer affordances inside an
 * `aria-hidden` subtree are fine - a mouse reaches them and assistive technology is not told they
 * exist, which is honest, because the same actions are on the real buttons in the tree. A
 * `tabIndex` here would not be: a focusable control inside `aria-hidden` is a tab stop that
 * announces nothing, which is worse than either having it or not.
 */

/**
 * When a node writes its name.
 *
 * Labels used to be permanent, and past a few dozen items that is a grey mat of overlapping text
 * rather than a graph - the shape, which is the thing a drawing is for, disappears underneath the
 * words. So a node is a disc until you ask: hover, keyboard focus, or being the item that is
 * currently open.
 *
 * Hover is CSS rather than React state on purpose. `group-hover` costs no re-render, and a graph
 * at the 2,000-node ceiling re-rendering every disc on every `mousemove` would be janky for a
 * cosmetic change. Focus is React state because it changes on a key press rather than continuously.
 */
const LABEL_REVEAL = 'opacity-0 transition-opacity group-hover:opacity-100';

/**
 * How far a pointer may travel between press and release and still count as a click.
 *
 * Without a threshold every drag would also open the note it just moved, because a drag ends with a
 * pointer release over the thing it started on. Measured in screen pixels rather than graph units
 * so it means the same thing at every zoom level - it is a statement about the reader's hand, not
 * about the drawing.
 */
const CLICK_SLOP = 4;

export interface GraphViewProps {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];

  /** Opens an item. Wired to the same `useOpenItem` the tree and the palette use. */
  readonly onOpen: (itemId: string) => void;

  /** The item currently open, drawn as the current node. Null when the graph is not showing one. */
  readonly selectedId: string | null;
}

/**
 * What each node points at, by name, for the accessible tree.
 *
 * Names rather than counts: "2 references" tells a reader there is something to find and not what,
 * which is the same shrug an unnamed spinner is.
 */
function outgoingByNode(
  nodes: readonly PositionedNode[],
  links: readonly GraphLink[],
): ReadonlyMap<string, readonly string[]> {
  const titles = new Map(nodes.map((node) => [node.id, nodeTitle(node)]));
  const outgoing = new Map<string, string[]>();

  for (const link of links) {
    const target = titles.get(link.targetId);
    if (target === undefined) {
      continue;
    }

    const named = outgoing.get(link.sourceId);
    if (named === undefined) {
      outgoing.set(link.sourceId, [target]);
      continue;
    }

    named.push(target);
  }

  return outgoing;
}

/** What a node's row says. */
function describe(node: PositionedNode, references: readonly string[]): string {
  const kind = `${nodeTitle(node)}, ${node.type}`;
  if (references.length === 0) {
    return `${kind}, no references`;
  }

  return `${kind}, ${references.length === 1 ? 'references' : `${String(references.length)} references:`} ${references.join(', ')}`;
}

/** A drag in progress: which node, where the pointer went down, and how far it has come. */
interface Drag {
  readonly id: string;
  readonly startX: number;
  readonly startY: number;
  readonly from: Offset;
  moved: boolean;
}

export function GraphView({ nodes, links, onOpen, selectedId }: GraphViewProps): ReactElement {
  // Profiled cost is not the reason - the reason is that `layout` is the input to everything below,
  // and laying 2,000 nodes out again on an unrelated re-render (a zoom step, a drag, a hover) would
  // redo the whole walk to produce an identical arrangement. It keys on the payload alone.
  const layout = useMemo(() => layoutGraph(nodes, links), [nodes, links]);

  const [zoom, setZoom] = useState<Zoom>(ZOOM_DEFAULT);
  const [offsets, setOffsets] = useState<ReadonlyMap<string, Offset>>(new Map());
  const dragRef = useRef<Drag | null>(null);

  // Where the nodes actually are once the reader has nudged any of them, and the edges redrawn to
  // follow. Both key on `offsets`, so a graph nobody has touched pays nothing for the feature.
  const positioned = useMemo(() => applyOffsets(layout.nodes, offsets), [layout.nodes, offsets]);
  const edges = useMemo(
    () => (offsets.size === 0 ? layout : buildEdges(positioned, links)),
    [offsets.size, layout, positioned, links],
  );

  const outgoing = useMemo(() => outgoingByNode(positioned, links), [positioned, links]);

  /**
   * Whether the entrance has run.
   *
   * The nodes are rendered at the centre for one frame and then transition out to their rings,
   * which is the explosion the layout describes made visible. A flag flipped in an effect rather
   * than a CSS keyframe because the only `.css` files this project has are the Tailwind entry and
   * the token sheet - a keyframe would be a third.
   */
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSettled(true);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  // Which row is the tree's single tab stop, and which node the drawing should label.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedIndex = positioned.findIndex((node) => node.id === selectedId);
  const entryIndex = focusedIndex ?? Math.max(selectedIndex, 0);
  const focusedId = focusedIndex === null ? null : (positioned[focusedIndex]?.id ?? null);

  const moveTo = (index: number): void => {
    const bounded = Math.min(Math.max(index, 0), positioned.length - 1);
    setFocusedIndex(bounded);
    rowRefs.current[bounded]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        break;
      case 'End':
        event.preventDefault();
        moveTo(positioned.length - 1);
        break;

      // The two shortcuts every zoomable surface has. Claimed here rather than on the window: a
      // global handler would steal `+` from anybody typing in a document elsewhere on the page.
      case '+':
      case '=':
        event.preventDefault();
        setZoom(zoomIn);
        break;
      case '-':
        event.preventDefault();
        setZoom(zoomOut);
        break;
      default:
        break;
    }
  };

  const onNodePointerDown = (event: PointerEvent<SVGGElement>, node: PositionedNode): void => {
    // Only the primary button starts a drag; a right-click is the browser's business.
    if (event.button !== 0) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      from: offsets.get(node.id) ?? { dx: 0, dy: 0 },
      moved: false,
    };
  };

  const onNodePointerMove = (event: PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) {
      return;
    }
    drag.moved = true;

    // Screen pixels into graph units. The viewBox is fixed and only the painted size changes with
    // zoom (see graph-zoom.ts), so one screen pixel is exactly `1 / zoom` graph units - without
    // this division a node would run away from the pointer at 300% and lag it at 25%.
    setOffsets((current) => {
      const next = new Map(current);
      next.set(drag.id, { dx: drag.from.dx + dx / zoom, dy: drag.from.dy + dy / zoom });
      return next;
    });
  };

  const onNodePointerUp = (event: PointerEvent<SVGGElement>, node: PositionedNode): void => {
    const drag = dragRef.current;
    dragRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    // A release that never travelled is a click, and a click opens the note. A release that did is
    // the end of a drag, and opening the item somebody just finished arranging would be a surprise.
    if (drag !== null && !drag.moved && drag.id === node.id) {
      onOpen(node.id);
    }
  };

  const scaled = atZoom(layout, zoom);
  const nudged = offsets.size > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button
          variant="icon"
          aria-label="Zoom out"
          disabled={zoom === zoomOut(zoom)}
          onClick={() => {
            setZoom(zoomOut);
          }}
        >
          <Icon icon={Minus} size="sm" />
        </Button>

        {/* Live, because the two buttons either side change this number and a reader who cannot see
            the drawing rescale has no other way to know the press did anything. */}
        <Text as="span" variant="note" tone="muted" aria-live="polite">
          {`${String(Math.round(zoom * 100))}%`}
        </Text>

        <Button
          variant="icon"
          aria-label="Zoom in"
          disabled={zoom === zoomIn(zoom)}
          onClick={() => {
            setZoom(zoomIn);
          }}
        >
          <Icon icon={Plus} size="sm" />
        </Button>

        <Button
          variant="icon"
          aria-label="Reset zoom"
          disabled={zoom === ZOOM_DEFAULT}
          onClick={() => {
            setZoom(ZOOM_DEFAULT);
          }}
        >
          <Icon icon={Scan} size="sm" />
        </Button>

        {/* Offered only once there is something to undo, and named for what it does rather than
            for the gesture that caused it - somebody who nudged one node an hour ago should not
            have to remember they did to understand this button. */}
        {nudged && (
          <Button
            variant="ghost"
            onClick={() => {
              setOffsets(new Map());
            }}
          >
            Tidy up
          </Button>
        )}
      </div>

      {/* Scrolls on both axes, which is the one place a pane's own horizontal scroller is not the
          answer: zooming in makes the drawing bigger than the pane in both directions by design, so
          this is the view bringing its own, exactly as layout/regions.ts describes. */}
      <div className="max-h-[70vh] overflow-auto">
        <svg
          aria-hidden={true}
          focusable="false"
          width={scaled.width}
          height={scaled.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          className="max-w-none touch-none"
        >
          {/* Two heads rather than one, because a marker cannot inherit the colour of the path that
              references it: `context-stroke` would do it, but support is uneven enough that a
              containment head would be the wrong colour on some browsers and right on others.

              `orient="auto"` turns the head to the path's own direction at its end, which is what
              makes one definition serve both a straight spoke and a bowed arc. The paths already
              stop short of the disc they point at (see graph-layout.ts), so the head lands in clear
              space rather than under the node. */}
          <defs>
            <marker
              id="graph-arrow-containment"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-divider" />
            </marker>
            <marker
              id="graph-arrow-reference"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-accent-text" />
            </marker>
          </defs>

          {/* The edges fade in behind the nodes rather than flying with them: a line whose two ends
              are both moving reads as noise, and there is nothing to follow until the discs land. */}
          <g
            className={`transition-opacity duration-500 motion-reduce:transition-none ${settled ? 'opacity-100' : 'opacity-0'}`}
          >
            {/* Containment first, so reference arcs sit over the structure rather than under it. */}
            <g fill="none" stroke="currentColor" className="text-divider">
              {edges.parentEdges.map((edge) => (
                <path
                  key={`${edge.parentId}-${edge.childId}`}
                  d={edge.path}
                  strokeWidth={1}
                  markerEnd="url(#graph-arrow-containment)"
                />
              ))}
            </g>

            <g fill="none" stroke="currentColor" className="text-accent-text">
              {edges.referenceEdges.map((edge, index) => (
                <path
                  key={`${edge.sourceId}-${edge.targetId}-${String(index)}`}
                  d={edge.path}
                  strokeWidth={1.5}
                  markerEnd="url(#graph-arrow-reference)"
                />
              ))}
            </g>
          </g>

          {positioned.map((node) => {
            // Open or keyboard-focused nodes keep their label permanently; everything else waits to
            // be hovered. A class swap rather than a conditional render, so the text node stays
            // mounted and the transition has something to animate.
            const named = node.id === selectedId || node.id === focusedId;

            // Before the first frame every node sits at the middle; afterwards it sits where the
            // layout put it, and the transition between the two is the explosion. `motion-reduce`
            // drops the movement for anybody who has asked their system for less of it - they get
            // the final arrangement immediately, which is the same picture without the journey.
            const home = settled
              ? undefined
              : `translate(${String(layout.width / 2 - node.x)} ${String(layout.height / 2 - node.y)}) scale(0.4)`;

            return (
              <g
                key={node.id}
                className="group cursor-pointer transition-transform duration-500 ease-out motion-reduce:transition-none"
                transform={home}
                onPointerDown={(event) => {
                  onNodePointerDown(event, node);
                }}
                onPointerMove={onNodePointerMove}
                onPointerUp={(event) => {
                  onNodePointerUp(event, node);
                }}
              >
                {/* A generous, invisible target under the disc. Seven pixels is a small thing to
                    hit with a mouse and smaller with a trackpad, and the alternative - a bigger
                    disc - would change the drawing to serve the pointer. */}
                <circle cx={node.x} cy={node.y} r={NODE_RADIUS * 2.5} className="fill-transparent" />
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={NODE_RADIUS}
                  // `transform-box: fill-box` makes `origin-center` mean this circle's own centre.
                  // Without it an SVG element's transform origin is resolved against the viewBox,
                  // so every disc would grow towards the middle of the drawing instead of in place
                  // - and the alternative, a computed `transform-origin` per node, is an inline
                  // style with two raw lengths in it.
                  className={`origin-center [transform-box:fill-box] transition-transform group-hover:scale-125 motion-reduce:transition-none ${
                    node.id === selectedId ? 'fill-accent-fill' : 'fill-surface stroke-divider'
                  }`}
                />
                <text
                  x={node.x + NODE_RADIUS * 2}
                  y={node.y + 4}
                  className={`fill-current text-xs text-muted ${named ? '' : LABEL_REVEAL}`}
                >
                  {nodeTitle(node)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Visually hidden, not absent. See the module comment: on screen this is a second copy of
          the workspace under a picture of it, but to a screen reader it is the only readable form
          of the graph. */}
      <ul className="sr-only" role="tree" aria-label="Workspace graph">
        {positioned.map((node, index) => {
          const references = outgoing.get(node.id) ?? [];

          return (
            <li
              key={node.id}
              role="treeitem"
              aria-level={node.depth + 1}
              aria-selected={node.id === selectedId}
            >
              <button
                type="button"
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                tabIndex={index === entryIndex ? 0 : -1}
                onFocus={() => {
                  setFocusedIndex(index);
                }}
                onBlur={() => {
                  setFocusedIndex(null);
                }}
                onKeyDown={(event) => {
                  onRowKeyDown(event, index);
                }}
                onClick={() => {
                  onOpen(node.id);
                }}
                className={`${focusRing} ${indentAt(ROW_INDENT, node.depth)} flex w-full items-center gap-2 py-1 pr-2 text-left`}
              >
                <Icon icon={FileText} size="sm" className="shrink-0 text-muted" />
                <Text as="span" variant="note">
                  {describe(node, references)}
                </Text>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
