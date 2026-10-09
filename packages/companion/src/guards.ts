import { items, type Item } from '@nix/api-client';
import type { StructureProperty, StructureView } from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import { WorkspaceToolRefusal } from './tool-args.js';

/** A stable serialization of all configuration that can affect an approved structure change. */
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
  schema: {
    declared: readonly StructureProperty[];
    effective?: readonly StructureProperty[];
    inherit?: boolean;
    defaultViewId?: string;
    hideDocument?: boolean;
    version?: string;
  },
  views: readonly StructureView[],
): StructureFingerprint {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, stable(entry)]),
      );
    return value;
  };
  return JSON.stringify(stable({ schema, views }));
}
