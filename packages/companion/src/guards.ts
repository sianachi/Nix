import { items, type Item } from '@nix/api-client';
import type { StructureProperty, StructureView } from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import { WorkspaceToolRefusal } from './tool-args.js';

/** A hash of the structure a preview was rendered against: sorted `key:type` pairs for the
 * declared fields, then `|`, then `id:kind` pairs for the views, in view order. Two calls that
 * see the same declared schema and the same views produce the same fingerprint; any change to
 * either changes it. */
export type StructureFingerprint = string;

/** Reads an item and refuses it outside this workspace. Scope guards supplement, never
 * replace, permission checks in Core and collab. */
export async function checkItem(
  ports: CompanionPorts,
  workspaceId: string,
  id: string,
  signal: AbortSignal,
): Promise<Item> {
  if (!id) throw new Error('An item identity is required.');
  const item = await ports.core.query(items.itemById(id), { signal, forceRefresh: true });
  if (item.workspaceId !== workspaceId)
    throw new WorkspaceToolRefusal('The item is outside this workspace. No action was run.');
  return item;
}

/** Fingerprints a structure so `run.ts` can refuse a write whose preview no longer matches what
 * it would execute against (architecture 1.2's fingerprint fence). */
export function structureFingerprint(
  schema: { declared: readonly StructureProperty[] },
  views: readonly StructureView[],
): StructureFingerprint {
  const fields = schema.declared
    .map((property) => `${property.key}:${property.type}`)
    .sort()
    .join(',');
  const viewParts = views.map((view) => `${view.id}:${view.kind}`).join(',');
  return `${fields}|${viewParts}`;
}
