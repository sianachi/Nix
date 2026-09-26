import { Button, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';
import type { PreviewModel, PreviewNode } from '@nix/structure-spec';

export function PetStructurePreview({ model }: { readonly model: PreviewModel }): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Text variant="body">{model.headline}</Text>
      <Text variant="note" tone="muted">
        In: {model.destination.path.length ? model.destination.path.join(' / ') : 'Workspace root'}
      </Text>
      <Text variant="note" tone="muted">
        {model.counts.items} items, {model.counts.fields} fields, {model.counts.views} views,{' '}
        {model.counts.entries} entries, {model.counts.writes} writes
      </Text>
      {model.tree.length ? (
        <ul className="list-disc space-y-2 pl-5">
          {model.tree.map((node, index) => (
            <PreviewTreeNode key={`${node.label}:${String(index)}`} node={node} depth={0} />
          ))}
        </ul>
      ) : null}
      {model.notes.length ? (
        <ul className="list-disc pl-5">
          {model.notes.map((note, index) => (
            <li key={`${note}:${String(index)}`}>
              <Text variant="note">{note}</Text>
            </li>
          ))}
        </ul>
      ) : null}
      {model.warnings.length ? (
        <details>
          <summary>
            <Text variant="note" as="span">
              Worth knowing ({model.warnings.length})
            </Text>
          </summary>
          <ul className="list-disc pl-5">
            {model.warnings.map((warning, index) => (
              <li key={`${warning.path}:${String(index)}`}>
                <Text variant="note">
                  {warning.path}: {warning.message}
                </Text>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {model.problems.length ? (
        <div role="alert" className="flex flex-col gap-1">
          <Text variant="note">Cannot run</Text>
          <ul className="list-disc pl-5">
            {model.problems.map((problem, index) => (
              <li key={`${problem.path}:${String(index)}`}>
                <Text variant="note">
                  {problem.path}: {problem.message}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Text variant="note" tone="muted">
        This never: {model.neverDoes.join('; ')}.
      </Text>
    </div>
  );
}

function countNodes(nodes: readonly PreviewNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function PreviewTreeNode({
  node,
  depth,
}: {
  readonly node: PreviewNode;
  readonly depth: number;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = countNodes(node.children);
  const collapsed = depth >= 2 && hiddenCount > 0 && !expanded;
  return (
    <li className="space-y-1">
      <Text variant="body">{node.label}</Text>
      {node.detail.map((detail, index) => (
        <Text key={`${detail}:${String(index)}`} variant="note" tone="muted" className="block">
          {detail}
        </Text>
      ))}
      {node.why ? (
        <details>
          <summary>
            <Text variant="note" as="span">
              Why
            </Text>
          </summary>
          <Text variant="note">{node.why}</Text>
        </details>
      ) : null}
      {collapsed ? (
        <Button
          variant="ghost"
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show {hiddenCount} more
        </Button>
      ) : node.children.length ? (
        <ul className="list-disc space-y-2 pl-5">
          {node.children.map((child, index) => (
            <PreviewTreeNode
              key={`${child.label}:${String(index)}`}
              node={child}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
