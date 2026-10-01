import { PRIORITY_LEVELS } from '../../properties/property-input';
import type { PropertyDefinition } from '../core/container-model';
import { unnamedMember, type MemberNameOf } from './member-name';

/**
 * A stored property value as a person reads it, for a sentence a suggestion says: a priority by
 * its scale word ("1 - Urgent"), a person by name when a member lookup is given and as "a workspace
 * member" otherwise (the identifier itself is never shown), anything else as stored.
 *
 * Shared by the form's usual values and query by example's proposed rules, so the same value
 * reads the same way wherever a suggestion names it.
 */
export function valueText(
  definition: PropertyDefinition | undefined,
  stored: string,
  memberName: MemberNameOf = unnamedMember,
): string {
  if (definition?.type === 'priority') {
    return PRIORITY_LEVELS.find((level) => String(level.value) === stored)?.label ?? stored;
  }
  if (definition?.type === 'assignee') {
    return memberName(stored);
  }
  return stored;
}
