import { Button, Icon, Text, focusRing } from '@nix/ui';
import { FileText, Minus, Plus, Scan } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { indentAt, ROW_INDENT } from '../items/workspace-sidebar';
import { layoutGraph, nodeTitle, NODE_RADIUS, type PositionedNode } from './graph-layout';
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
 * Keyboard focus still lands in it, and the drawing answers: the focused node reveals its label
 * exactly as a hovered one does, so a sighted keyboard user can see where they are even though the
 * control they are focused on is not painted.
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

export function GraphView({ nodes, links, onOpen, selectedId }: GraphViewProps): ReactElement {
  // Profiled cost is not the reason - the reason is that `layout` is the input to `outgoing` and to
  // every row below, and laying 2,000 nodes out on an unrelated re-render (a zoom step, a hover)
  // would redo the whole walk to produce an identical result. Both memos key on the payload.
  const layout = useMemo(() => layoutGraph(nodes, links), [nodes, links]);
  const outgoing = useMemo(() => outgoingByNode(layout.nodes, links), [layout.nodes, links]);

  const [zoom, setZoom] = useState<Zoom>(ZOOM_DEFAULT);

  // Which row is the tree's single tab stop, and which node the drawing should label. Null until
  // somebody has put focus here, so the entry point is the open item by default.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedIndex = layout.nodes.findIndex((node) => node.id === selectedId);
  const entryIndex = focusedIndex ?? Math.max(selectedIndex, 0);
  const focusedId = focusedIndex === null ? null : (layout.nodes[focusedIndex]?.id ?? null);

  const moveTo = (index: number): void => {
    const bounded = Math.min(Math.max(index, 0), layout.nodes.length - 1);
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
        moveTo(layout.nodes.length - 1);
        break;

      // The two shortcuts every zoomable surface has. Claimed here rather than on the window: a
      // global key handler would steal `+` from anybody typing in a document elsewhere on the page.
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

  const scaled = atZoom(layout, zoom);

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
      </div>

      {/* Scrolls on both axes, which is the one place in the app a pane's own horizontal scroller is
          not the answer: zooming in makes the drawing bigger than the pane in both directions by
          design, so this is the view bringing its own, exactly as layout/regions.ts describes. */}
      <div className="max-h-[70vh] overflow-auto">
        <svg
          aria-hidden={true}
          focusable="false"
          width={scaled.width}
          height={scaled.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          className="max-w-none"
        >
          {/* Containment first, so reference arcs sit over the structure rather than under it. */}
          <g fill="none" stroke="currentColor" className="text-divider">
            {layout.parentEdges.map((edge) => (
              <path key={`${edge.parentId}-${edge.childId}`} d={edge.path} strokeWidth={1} />
            ))}
          </g>

          <g fill="none" stroke="currentColor" className="text-accent-text">
            {layout.referenceEdges.map((edge, index) => (
              <path
                key={`${edge.sourceId}-${edge.targetId}-${String(index)}`}
                d={edge.path}
                strokeWidth={1.5}
              />
            ))}
          </g>

          {layout.nodes.map((node) => {
            // Open or keyboard-focused nodes keep their label permanently; everything else waits to
            // be hovered. Written as a class swap rather than a conditional render so the text node
            // stays mounted and the transition has something to animate.
            const named = node.id === selectedId || node.id === focusedId;

            return (
              <g key={node.id} className="group">
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={NODE_RADIUS}
                  className={
                    node.id === selectedId ? 'fill-accent-fill' : 'fill-surface stroke-divider'
                  }
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
        {layout.nodes.map((node, index) => {
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
