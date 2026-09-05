import type { GraphLink, GraphNode } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { useNarrowViewport } from '../layout/viewport';
import { GraphView } from './graph-view';

interface Connection {
  id: string;
  relation: string;
}
export function graphConnections(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
): Map<string, Connection[]> {
  const connections = new Map(nodes.map((node) => [node.id, [] as Connection[]]));
  function add(from: string, to: string, relation: string): void {
    if (connections.has(to)) connections.get(from)?.push({ id: to, relation });
  }
  for (const node of nodes)
    if (node.parentId) {
      add(node.id, node.parentId, 'Inside');
      add(node.parentId, node.id, 'Contains');
    }
  for (const link of links) {
    add(link.sourceId, link.targetId, 'Links to');
    add(link.targetId, link.sourceId, 'Linked from');
  }
  return connections;
}

export function GraphExplorer({
  nodes,
  links,
  onOpen,
}: {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  readonly onOpen: (itemId: string) => void;
}): ReactNode {
  const narrow = useNarrowViewport();
  const [choice, setChoice] = useState<'browse' | 'spatial' | null>(null);
  const [visitedSpatial, setVisitedSpatial] = useState(!narrow);
  const mode = choice ?? (narrow ? 'browse' : 'spatial');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  // The graph can contain 2,000 nodes and 4,000 edges. Index only when server data changes,
  // not on each search keystroke or disclosure toggle.
  const connections = useMemo(() => graphConnections(nodes, links), [nodes, links]);
  const titles = new Map(
    nodes.map((node) => [node.id, node.title?.trim() ? node.title : 'Untitled']),
  );
  const matches = nodes.filter((node) =>
    (node.title?.trim() ? node.title : 'Untitled')
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap gap-2" aria-label="Graph presentation">
        <Button
          variant="ghost"
          aria-pressed={mode === 'browse'}
          onClick={() => {
            setChoice('browse');
          }}
        >
          Browse connections
        </Button>
        <Button
          variant="ghost"
          aria-pressed={mode === 'spatial'}
          onClick={() => {
            setChoice('spatial');
            setVisitedSpatial(true);
          }}
        >
          Spatial graph
        </Button>
      </div>
      {mode === 'spatial' || visitedSpatial ? (
        <div hidden={mode !== 'spatial'}>
          <GraphView nodes={nodes} links={links} onOpen={onOpen} />
        </div>
      ) : null}
      <section
        hidden={mode !== 'browse'}
        aria-label="Graph connections"
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-2">
          <Text as="span" variant="caption">
            Find an item
          </Text>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(50);
            }}
            className="rounded-md border border-divider bg-background px-3 py-2"
          />
        </label>
        <Text as="p" variant="caption" tone="muted" role="status">
          {String(matches.length)} matching items
        </Text>
        <ul className="divide-y divide-divider">
          {matches.slice(0, limit).map((node) => {
            const related = connections.get(node.id) ?? [];
            return (
              <li key={node.id} className="py-3">
                <Button
                  variant="ghost"
                  className="w-full justify-start whitespace-normal text-left"
                  onClick={() => {
                    onOpen(node.id);
                  }}
                >
                  {titles.get(node.id)}
                </Button>
                {related.length === 0 ? (
                  <Text as="p" variant="caption" tone="muted">
                    No connections in this graph.
                  </Text>
                ) : (
                  <details>
                    <summary className="cursor-pointer py-2">
                      {String(related.length)} connections
                    </summary>
                    <ul className="border-l border-divider pl-3">
                      {related.map((connection, index) => (
                        <li
                          key={`${connection.relation}:${connection.id}:${String(index)}`}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <Text as="span" variant="caption" tone="muted">
                            {connection.relation}
                          </Text>
                          <Button
                            variant="ghost"
                            className="whitespace-normal text-left"
                            onClick={() => {
                              onOpen(connection.id);
                            }}
                          >
                            {titles.get(connection.id)}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {matches.length > limit ? (
          <Button
            variant="secondary"
            onClick={() => {
              setLimit((current) => current + 50);
            }}
          >
            Show more items
          </Button>
        ) : null}
      </section>
    </div>
  );
}
