import { Icon, Text, focusRing } from '@nix/ui';
import { FileText } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { indentAt, ROW_INDENT } from '../items/workspace-sidebar';
import { layoutGraph, nodeTitle, NODE_RADIUS, type PositionedNode } from './graph-layout';
import type { GraphLink, GraphNode } from '@nix/api-client';

/**
 * One workspace, drawn.
 *
 * **There are two representations here, and both are complete.** The `<svg>` is the picture, and it
 * is `aria-hidden`: a scatter of discs and paths conveys nothing through an accessibility tree, and
 * labelling it `role="img"` with a summary would be claiming otherwise. Beside it is a real tree of
 * buttons carrying the same nodes, the same nesting and - the part a drawing genuinely cannot
 * offer - each node's outgoing references named in words. A reader using a screen reader gets the
 * graph, not an apology for it.
 *
 * That is more than the usual "add an aria-label" because the usual thing does not work here. The
 * question a graph answers is "what points at what", and the only way to answer it without sight is
 * to say so per node.
 *
 * **Every node is a button, so the keyboard reaches all of them.** Up and Down walk the list, Home
 * and End jump to its ends, Enter and Space open. One tab stop, moved as focus moves, so tabbing
 * past the graph costs one key press rather than one per item.
 */

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
 * which is the same shrug an unnamed spinner is. Built once per payload because it is O(links) and
 * every one of the node rows below needs it.
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

/** What a node's row says, drawing and accessible tree agreeing on one sentence. */
function describe(node: PositionedNode, references: readonly string[]): string {
  const kind = `${nodeTitle(node)}, ${node.type}`;
  if (references.length === 0) {
    return `${kind}, no references`;
  }

  return `${kind}, ${references.length === 1 ? 'references' : `${String(references.length)} references:`} ${references.join(', ')}`;
}

export function GraphView({ nodes, links, onOpen, selectedId }: GraphViewProps): ReactElement {
  // Profiled cost is not the reason - the reason is that `layout` is the input to `outgoing` and to
  // every row below, and laying 2,000 nodes out on an unrelated re-render (a selection change, a
  // parent's state) would redo the whole walk to produce an identical result. Both memos key on the
  // payload, which only changes when the graph is refetched.
  const layout = useMemo(() => layoutGraph(nodes, links), [nodes, links]);
  const outgoing = useMemo(() => outgoingByNode(layout.nodes, links), [layout.nodes, links]);

  // Which row is the tree's single tab stop. Null until somebody has put focus here, so the entry
  // point is the open item by default - derived rather than copied, so it stays right when the
  // selection changes underneath.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const selectedIndex = layout.nodes.findIndex((node) => node.id === selectedId);
  const entryIndex = focusedIndex ?? Math.max(selectedIndex, 0);

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
      default:
        break;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The picture. Hidden from assistive technology on purpose - the tree below carries the same
          graph in a form that can actually be read. `overflow-x-auto` because a wide workspace is
          wider than the pane, and the horizontal axis belongs to the view (see layout/regions.ts). */}
      <div className="overflow-x-auto">
        <svg
          aria-hidden={true}
          focusable="false"
          width={layout.width}
          height={layout.height}
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

          {layout.nodes.map((node) => (
            <g key={node.id}>
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
                className="fill-current text-xs text-muted"
              >
                {nodeTitle(node)}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* The graph as something readable. Not a fallback and not a duplicate for its own sake -
          it is the only representation that can say what points at what. */}
      <ul className="flex flex-col gap-px" role="tree" aria-label="Workspace graph">
        {layout.nodes.map((node, index) => {
          const references = outgoing.get(node.id) ?? [];

          return (
            <li
              key={node.id}
              role="treeitem"
              aria-level={node.depth + 1}
              aria-selected={node.id === selectedId}
              // Every node is a leaf of this list even when it has children in the workspace: the
              // list is already flattened in tree order and nothing here expands or collapses, so
              // claiming `aria-expanded` would promise a control that does not exist.
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
                onKeyDown={(event) => {
                  onRowKeyDown(event, index);
                }}
                onClick={() => {
                  onOpen(node.id);
                }}
                className={`${focusRing} ${indentAt(ROW_INDENT, node.depth)} flex w-full items-center gap-2 py-1 pr-2 text-left hover:bg-surface ${
                  node.id === selectedId ? 'bg-surface' : ''
                }`}
              >
                <Icon icon={FileText} size="sm" className="shrink-0 text-muted" />
                <Text as="span" variant="note" className="truncate">
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
