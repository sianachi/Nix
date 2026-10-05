import { z } from 'zod';

/** Loaded descendants become unavailable with their deleted parent. */
export function itemSubtreeIds(
  items: readonly { readonly id: string; readonly parentId: string | null }[],
  roots: readonly string[],
): Set<string> {
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item.id);
    children.set(item.parentId, siblings);
  }
  const removed = new Set(roots);
  const pending = [...removed];
  for (const parentId of pending) {
    for (const id of children.get(parentId) ?? []) {
      if (removed.has(id)) continue;
      removed.add(id);
      pending.push(id);
    }
  }
  return removed;
}

const eventName = 'nix:item-children-changed';
const detailSchema = z.object({
  workspaceId: z.string(),
  parentId: z.string().nullable(),
  removedItemIds: z.array(z.string()).default([]),
  restoredItemIds: z.array(z.string()).default([]),
});
/** A null parent requests a workspace-wide refresh after a multi-container change. */
export function notifyItemChildrenChanged(
  workspaceId: string,
  parentId: string | null,
  change: {
    readonly removedItemIds?: readonly string[];
    readonly restoredItemIds?: readonly string[];
  } = {},
): void {
  window.dispatchEvent(
    new CustomEvent(eventName, { detail: { workspaceId, parentId, ...change } }),
  );
}
export function onItemChildrenChanged(
  listener: (detail: z.infer<typeof detailSchema>) => void,
): () => void {
  const receive = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = detailSchema.safeParse(event.detail);
    if (parsed.success) listener(parsed.data);
  };
  window.addEventListener(eventName, receive);
  return () => {
    window.removeEventListener(eventName, receive);
  };
}
