import { Button, Text } from '@nix/ui';
import { useMemo, useState, type ReactNode } from 'react';
import type { CanvasElement } from './canvas-binding';
import {
  itemIdFromNixLink,
  nixFileItemIdFromElement,
  nixItemIdFromElement,
  prepareCanvasElements,
} from './nix-canvas-model';

export function canvasEntries(elements: readonly CanvasElement[]): {
  entries: { id: string; title: string; itemId: string | null; kind: string }[];
  drawingCount: number;
} {
  const scene = prepareCanvasElements(elements).filter((element) => !element.isDeleted);
  const byId = new Map(scene.map((element) => [element.id, element]));
  const entries: { id: string; title: string; itemId: string | null; kind: string }[] = [];
  let drawingCount = 0;
  for (const element of scene) {
    const itemId =
      nixItemIdFromElement(element) ??
      nixFileItemIdFromElement(element) ??
      itemIdFromNixLink(element.link);
    const label = element.boundElements
      ?.map((bound) => byId.get(bound.id))
      .find((bound) => bound?.type === 'text');
    if (itemId) {
      entries.push({
        id: element.id,
        title:
          label?.type === 'text'
            ? label.text
            : element.type === 'text'
              ? element.text
              : 'Linked item',
        itemId,
        kind: element.type === 'image' ? 'Image' : 'Item',
      });
    } else if (element.type === 'text') {
      const container = element.containerId ? byId.get(element.containerId) : null;
      if (container && (nixItemIdFromElement(container) || itemIdFromNixLink(container.link)))
        continue;
      entries.push({ id: element.id, title: element.text, itemId: null, kind: 'Text' });
    } else if (element.type === 'image') {
      entries.push({ id: element.id, title: 'Canvas image', itemId: null, kind: 'Image' });
    } else {
      drawingCount += 1;
    }
  }
  return { entries, drawingCount };
}

export function CanvasBrowser({
  elements,
  onOpen,
  onSpatial,
  loading,
}: {
  readonly elements: readonly CanvasElement[];
  readonly onOpen: (itemId: string) => void;
  readonly onSpatial: () => void;
  readonly loading: boolean;
}): ReactNode {
  const [search, setSearch] = useState('');
  // Scene conversion walks every shape; searching must not repeat it for unchanged scene data.
  const { entries, drawingCount } = useMemo(() => canvasEntries(elements), [elements]);
  const visible = entries.filter((entry) =>
    entry.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <section aria-label="Canvas contents" className="h-full overflow-y-auto px-4 py-3">
      <label className="flex flex-col gap-2">
        <Text as="span" variant="caption">
          Find in canvas
        </Text>
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          className="rounded-md border border-divider bg-background px-3 py-2"
        />
      </label>
      {loading && elements.length === 0 ? (
        <Text as="p" className="py-4">
          Loading canvas…
        </Text>
      ) : null}
      {!loading && entries.length === 0 && drawingCount === 0 ? (
        <Text as="p" className="py-4">
          Your canvas is empty. Open the spatial canvas to add something.
        </Text>
      ) : null}
      {search && visible.length === 0 ? (
        <Text as="p" className="py-4">
          No matching content.
        </Text>
      ) : null}
      <ul className="divide-y divide-divider">
        {visible.map((entry) => (
          <li key={entry.id} className="py-4">
            <Text as="p" variant="caption" tone="muted">
              {entry.kind}
            </Text>
            {entry.itemId !== null ? (
              <Button
                variant="ghost"
                className="w-full justify-start whitespace-normal text-left"
                onClick={() => {
                  if (entry.itemId) onOpen(entry.itemId);
                }}
              >
                {entry.title || 'Untitled'}
              </Button>
            ) : entry.kind === 'Image' ? (
              <Button variant="ghost" onClick={onSpatial}>
                View image in canvas
              </Button>
            ) : (
              <Text as="p" className="whitespace-pre-wrap break-words">
                {entry.title}
              </Text>
            )}
          </li>
        ))}
      </ul>
      {drawingCount > 0 ? (
        <Button variant="secondary" onClick={onSpatial}>
          View drawing ({String(drawingCount)} shapes)
        </Button>
      ) : null}
    </section>
  );
}
