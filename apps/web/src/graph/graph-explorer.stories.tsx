import type { GraphLink, GraphNode } from '@nix/api-client';
import type { ReactElement } from 'react';
import { GraphExplorer } from './graph-explorer';
import { GraphView } from './graph-view';
import type { GraphRepresentation } from './graph-representations';

export default { title: 'Nix/Graph', parameters: { layout: 'padded' } };
const noop = (): void => undefined;
const nodes: GraphNode[] = [
  ['project', 'Launch project', null, 1],
  ['research', 'Research', 'project', 3],
  ['interviews', 'Customer interviews', 'research', 5],
  ['findings', 'Research findings', 'research', 9],
  ['design', 'Design', 'project', 12],
  ['prototype', 'Prototype', 'design', 14],
  ['feedback', 'Prototype feedback', 'design', 17],
  ['launch', 'Launch checklist', 'project', 21],
  ['ideas', 'Future ideas', null, 25],
].map(([id, title, parentId, day]) => ({
  id: String(id),
  title: String(title),
  parentId: parentId === null ? null : String(parentId),
  type: 'note',
  createdAt: new Date(Date.UTC(2026, 0, Number(day))).toISOString(),
  lastModifiedAt: null,
}));
const links: GraphLink[] = [
  { sourceId: 'research', targetId: 'interviews', occurrences: 3 },
  { sourceId: 'interviews', targetId: 'findings', occurrences: 3 },
  { sourceId: 'findings', targetId: 'research', occurrences: 3 },
  { sourceId: 'design', targetId: 'prototype', occurrences: 3 },
  { sourceId: 'prototype', targetId: 'feedback', occurrences: 3 },
  { sourceId: 'feedback', targetId: 'design', occurrences: 3 },
  { sourceId: 'findings', targetId: 'prototype', occurrences: 1 },
  { sourceId: 'launch', targetId: 'feedback', occurrences: 1 },
];
function view(representation: GraphRepresentation): ReactElement {
  return (
    <GraphView
      nodes={nodes}
      links={links}
      representation={representation}
      focusId="prototype"
      distance={1}
      onOpen={noop}
    />
  );
}
export function Focused(): ReactElement {
  return view('focused');
}
export function Hierarchy(): ReactElement {
  return view('hierarchy');
}
export function Clusters(): ReactElement {
  return view('clusters');
}
export function Chronological(): ReactElement {
  return view('chronological');
}
export function LayoutPicker(): ReactElement {
  return <GraphExplorer nodes={nodes} links={links} onOpen={noop} />;
}
export function DarkClusters(): ReactElement {
  return view('clusters');
}
DarkClusters.globals = { ground: 'dark' };
export function PhoneChronological(): ReactElement {
  return <div className="max-w-sm">{view('chronological')}</div>;
}
export function PartialFocused(): ReactElement {
  return (
    <GraphView
      nodes={nodes}
      links={links}
      representation="focused"
      focusId="prototype"
      partial
      onOpen={noop}
    />
  );
}
export function Empty(): ReactElement {
  return <GraphExplorer nodes={[]} links={[]} onOpen={noop} />;
}
