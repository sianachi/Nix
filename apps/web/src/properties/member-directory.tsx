import { createContext, use, useMemo, type ReactNode } from 'react';

import { useWorkspaceMembers } from '../settings/use-workspace-members';

/**
 * Who each workspace member is, loaded once for a whole view.
 *
 * A board of two hundred cards that each showed an assignee by calling `useWorkspaceMembers` would
 * page through the member list two hundred times. So a view that shows people mounts one directory
 * above its cards, and every value display reads names out of it.
 *
 * **Absent is not an error.** Outside a directory - a story, a component test, a view whose schema
 * declares no assignee - a name resolves to null and the display falls back to saying it does not
 * know, exactly as it does for an identifier that is no longer a member.
 */

const MemberNamesContext = createContext<ReadonlyMap<string, string> | null>(null);

export function MemberDirectory(props: { readonly children: ReactNode }): ReactNode {
  const { members } = useWorkspaceMembers();
  const names = useMemo(
    () => new Map(members.map((member) => [member.subjectId, member.subjectDisplayName])),
    [members],
  );

  return <MemberNamesContext value={names}>{props.children}</MemberNamesContext>;
}

/** A member's display name, or null when no directory is mounted or the id is not a member. */
export function useMemberName(subjectId: string | null): string | null {
  const names = use(MemberNamesContext);
  return subjectId === null ? null : (names?.get(subjectId) ?? null);
}

/** The whole map, for code that resolves many names at once - grouping, sorting. */
export function useMemberNames(): ReadonlyMap<string, string> | null {
  return use(MemberNamesContext);
}
