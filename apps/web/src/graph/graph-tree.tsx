import { Icon, Text, focusRing } from '@nix/ui';
import { FileText } from 'lucide-react';
import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { indentAt, ROW_INDENT } from '../items/workspace-sidebar';
import { nodeTitle, type PositionedNode } from './graph-layout';
import type { GraphLink } from '@nix/api-client';

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

export interface GraphTreeProps {
  readonly nodes: readonly PositionedNode[];
  readonly links: readonly GraphLink[];

  /** The nodes that have children, and which of those are folded - a tree's expanded state. */
  readonly parents: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleFold: (itemId: string) => void;
  readonly onOpen: (itemId: string) => void;

  /** Tells the drawing which node the keyboard is on, so it can write that node's name. */
  readonly onFocusChange: (itemId: string | null) => void;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
}

/**
 * The graph in words: the same nodes, the same nesting, and each node's references by name.
 *
 * Visually hidden, not absent. On screen this would be a second copy of the workspace under a
 * picture of it, but to a screen reader it is the only readable form of the graph.
 *
 * Memoised for a measured-by-construction reason rather than a habit: it is one button per node,
 * up to the 2,000-node ceiling, and nothing a drag, a pan or a zoom changes is among its props.
 * Unmemoised, every pointer move over the drawing re-rendered all of them.
 */
export const GraphTree = memo(function GraphTree({
  nodes,
  links,
  parents,
  collapsed,
  onToggleFold,
  onOpen,
  onFocusChange,
  onZoomIn,
  onZoomOut,
}: GraphTreeProps): ReactElement {
  const outgoing = useMemo(() => outgoingByNode(nodes, links), [nodes, links]);

  // Which row is the tree's single tab stop.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const entryIndex = focusedIndex ?? 0;

  const moveTo = (index: number): void => {
    const bounded = Math.min(Math.max(index, 0), nodes.length - 1);
    setFocusedIndex(bounded);
    rowRefs.current[bounded]?.focus();
  };

  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const id = nodes[index]?.id;

    switch (event.key) {
      // The tree pattern's own keys for a branch: right opens a closed one, left closes an open
      // one. This is the fold control the drawing offers a pointer, for a keyboard.
      case 'ArrowRight':
        if (id !== undefined && parents.has(id) && collapsed.has(id)) {
          event.preventDefault();
          onToggleFold(id);
        }
        break;
      case 'ArrowLeft':
        if (id !== undefined && parents.has(id) && !collapsed.has(id)) {
          event.preventDefault();
          onToggleFold(id);
        }
        break;
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
        moveTo(nodes.length - 1);
        break;

      // The two shortcuts every zoomable surface has. Claimed here rather than on the window: a
      // global handler would steal `+` from anybody typing in a document elsewhere on the page.
      case '+':
      case '=':
        event.preventDefault();
        onZoomIn();
        break;
      case '-':
        event.preventDefault();
        onZoomOut();
        break;
      default:
        break;
    }
  };

  return (
    <ul className="sr-only" role="tree" aria-label="Workspace graph">
      {nodes.map((node, index) => {
        const references = outgoing.get(node.id) ?? [];

        return (
          <li
            key={node.id}
            role="treeitem"
            aria-level={node.depth + 1}
            aria-expanded={parents.has(node.id) ? !collapsed.has(node.id) : undefined}
            // There is no persistent graph selection: activating a node navigates to its note.
            // An explicit undefined keeps that state absent while satisfying the static role
            // contract, whose role table cannot distinguish a navigation tree from a selector.
            aria-selected={undefined}
          >
            <button
              type="button"
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              tabIndex={index === entryIndex ? 0 : -1}
              onFocus={() => {
                setFocusedIndex(index);
                onFocusChange(node.id);
              }}
              onBlur={() => {
                setFocusedIndex(null);
                onFocusChange(null);
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
  );
});
