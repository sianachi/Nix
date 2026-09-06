import { z } from 'zod';

const eventName = 'nix:item-children-changed';
const detailSchema = z.object({ workspaceId: z.string(), parentId: z.string().nullable() });
/** A null parent requests a workspace-wide refresh after a multi-container change. */
export function notifyItemChildrenChanged(workspaceId: string, parentId: string | null): void {
  window.dispatchEvent(new CustomEvent(eventName, { detail: { workspaceId, parentId } }));
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
