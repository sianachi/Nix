import type { NixClient } from '@nix/api-client';
import type { MarkdownImportScan, MarkdownLoss } from '@nix/markdown';

/** `runWorkspaceTool` never reads the wall clock directly, so a fixed fake can
 * stand in for it in tests. (`CompanionBodies.append` still calls
 * `crypto.randomUUID()` for its own idempotency key; that is unrelated to the
 * executor's id port and is not yet routed through `CompanionIds`.) */
export interface CompanionClock {
  today(): string;
  timeZone(): string;
  now(): Date;
}

export interface CompanionIds {
  uuid(): string;
}

/** One edit inside a note body. A section is the blocks from a top-level heading up to the next
 * heading of the same or higher level; a passage is text inside a single paragraph, heading or
 * code block, wherever it sits (a list item, a table cell, a callout). */
export type BodyEdit =
  | { kind: 'section'; heading: string; markdown: string }
  | { kind: 'passage'; find: string; replace: string };

/** What an edit would do, computed from the note as it is now and without writing anything. */
export interface BodyEditPlan {
  /** The edited blocks as Markdown now. For a section whose heading is kept, includes it. */
  before: string;
  /** The same blocks as Markdown after the edit. */
  after: string;
  blocksRemoved: number;
  blocksAdded: number;
  /** What the replaced blocks carry that Markdown cannot (a comment, a colour, alignment): the
   * edit drops it. */
  losses: readonly MarkdownLoss[];
  markdownChanges: MarkdownImportScan;
  /** Where the edit lands and what it replaces. Apply refuses when this no longer matches. */
  fingerprint: string;
}

export interface BodyEditResult {
  id: string;
  replaced: true;
  blocksRemoved: number;
  blocksAdded: number;
  markdownChanges: MarkdownImportScan;
}

export interface CompanionBodies {
  read(itemId: string, signal: AbortSignal): Promise<unknown>;
  append(itemId: string, markdown: string, signal: AbortSignal): Promise<unknown>;
  /** Plans an edit without writing. Throws `WorkspaceToolRefusal` when it cannot be placed. */
  planEdit(itemId: string, edit: BodyEdit, signal: AbortSignal): Promise<BodyEditPlan>;
  /** Plans the edit again against the latest note and writes it only when the plan's fingerprint
   * still equals `approved`, the fingerprint the owner's preview showed. */
  applyEdit(
    itemId: string,
    edit: BodyEdit,
    approved: string,
    signal: AbortSignal,
  ): Promise<BodyEditResult>;
}

/** Everything the executor touches outside its own pure logic, gathered so a
 * caller supplies exactly one object and a test supplies exactly one fake. */
export interface CompanionPorts {
  core: NixClient;
  collab: NixClient;
  bodies: CompanionBodies;
  clock: CompanionClock;
  ids: CompanionIds;
}

export function defaultClock(): CompanionClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    today() {
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    },
    timeZone() {
      return timeZone;
    },
    now() {
      return new Date();
    },
  };
}

export function defaultIds(): CompanionIds {
  return {
    uuid() {
      return crypto.randomUUID();
    },
  };
}
