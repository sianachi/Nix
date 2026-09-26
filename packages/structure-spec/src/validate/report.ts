import type { StructureProperty, StructureView } from '../types.js';

/**
 * One thing wrong with a spec, at a path a caller can point somebody at.
 *
 * `path` follows the shape a Zod issue already prints for an array index - `fields[2].options`,
 * `entries[1].values.rating` - so a problem raised inside this module and one that came straight
 * from a Zod parse read the same way in a preview or a CLI message.
 */
export interface Problem {
  path: string;
  code: string;
  message: string;
}

/**
 * What `validateSpec` (and, later, `validateBlueprint`) hands back: whether the spec is storable,
 * every reason it is not, non-blocking advice, and enough counts for a preview line ("3 fields, 2
 * views") without the caller re-deriving them from the spec itself.
 */
export interface ValidationReport {
  ok: boolean;
  problems: Problem[];
  warnings: Problem[];
  stats: { fields: number; views: number; entries: number };
}

/**
 * What a spec is checked against: the schema already in effect where it will land, and - for an
 * additive operation - the item's own declared properties and views, so a collision with either
 * can be told apart from a field the item simply does not have yet.
 */
export interface ValidationContext {
  inheritedFields: StructureProperty[];
  existing?: { declared: StructureProperty[]; inherit?: boolean; views: StructureView[] };
  /** The item's current property values, used to require a due date before setting recurrence. */
  itemValues?: Record<string, unknown>;
  today: string;
}
