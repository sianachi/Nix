import { keyForProperty } from '../vocabulary/recipes.js';
import { TASK_SEMANTIC_FIELD_TYPES, type FieldSpec } from './field.js';

const TASK_SEMANTIC_TYPES: ReadonlySet<string> = new Set(TASK_SEMANTIC_FIELD_TYPES);

/**
 * The key a compiled field gets. A task-semantic type's key is always the type's own name
 * (`PropertySchemaRules.cs`'s rule that the key must equal the type for these five) - a pet
 * cannot choose a different key for a due date, because the whole point of the type is that
 * smart lists and timelines can find it by name. `fieldSpecSchema` already refuses a spec that
 * declares a conflicting `key` on one of these types, so the fallback here can never silently
 * discard one. Every other field keeps an explicit `key`, or falls back to slugging the label the
 * way the web wizard does.
 */
export function keyFor(field: FieldSpec): string {
  if (TASK_SEMANTIC_TYPES.has(field.type)) {
    return field.type;
  }
  return field.key ?? keyForProperty(field.label);
}
