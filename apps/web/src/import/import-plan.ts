/**
 * Planning an import: what the chosen files would become, before anything is created.
 *
 * The plan is the preview - MVP-7's 7.5 asks for exactly this order: what will be mapped, what
 * will be dropped, said *before* commit rather than discovered after. Every chosen file lands in
 * exactly one place: a planned note, a skipped row with its reason (not Markdown, inside a hidden
 * directory), or a failed row (a body the document model rejects). Front matter becomes
 * properties by the same shared rule the CLI applies (`@nix/markdown/front-matter`), and the
 * unresolved counts (`[[wiki links]]`, local image paths) use the same shared counting, so the two
 * surfaces cannot disagree about what a file becomes.
 *
 * Everything is planned under one root container - the picked folder's name, or a plain "Imported
 * notes" for loose files - so the whole import has a single handle: one item to open, and one item
 * to delete to undo it.
 */

import { noteFromMarkdown } from '@nix/markdown/front-matter';
import { countLocalImages, countWikiLinks } from '@nix/markdown/scan';

/** One chosen file, already read: its source-relative path and its text. */
export interface ImportSource {
  /** `folder/sub/note.md` from a folder pick, or a bare `note.md` from a file pick. */
  readonly path: string;
  readonly text: string;
}

export interface PathReason {
  readonly path: string;
  readonly reason: string;
}

/** One planned item: a note from a file, or a container from a folder segment. */
export interface PlannedNode {
  readonly path: string;
  readonly kind: 'note' | 'container';
  readonly title: string;
  /** Front matter values to set, minus the `title` key the item itself consumes. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** The validated body, ready to write; null when there is nothing to write. */
  readonly doc: unknown;
  readonly droppedFrontMatter: readonly string[];
  readonly unresolvedWikiLinks: number;
  readonly unresolvedLocalImages: number;
  readonly children: readonly PlannedNode[];
}

export interface ImportPlan {
  /** The one container everything hangs under; null when nothing was importable. */
  readonly root: PlannedNode | null;
  /** How many items a run would create, root and containers included. */
  readonly totalItems: number;
  readonly skipped: readonly PathReason[];
  readonly failed: readonly PathReason[];
}

/** The parser seam: `markdownToDocument`'s shape, injected so the plan is testable without it. */
export type ParseBody = (
  markdown: string,
) => { readonly ok: true; readonly doc: unknown } | { readonly ok: false; readonly reason: string };

interface DraftFolder {
  readonly name: string;
  readonly folders: Map<string, DraftFolder>;
  readonly notes: PlannedNode[];
}

export interface ScreenedSelection {
  /** True at index `i` when `paths[i]` is worth reading; same order as the input. */
  readonly wanted: readonly boolean[];
  readonly skipped: readonly PathReason[];
}

/**
 * Decides which of the chosen paths are worth reading at all, before a byte of file content is
 * loaded. A folder pick delivers everything the folder holds - attachments, images, a tool's
 * hidden directories - and reading those into memory just to skip them is how a large vault
 * crashes the tab. Same rules, same reasons, and the same shared-head handling as `planImport`,
 * through the one `skipReasonFor`, so screening cannot disagree with planning.
 */
export function screenPaths(paths: readonly string[]): ScreenedSelection {
  const segmented = paths.map(toSegments);
  const shared = sharedHead(segmented);
  const skipped: PathReason[] = [];
  const wanted = paths.map((path, index) => {
    const relative = shared !== null ? (segmented[index] ?? []).slice(1) : (segmented[index] ?? []);
    const reason = skipReasonFor(relative);
    if (reason !== null) {
      skipped.push({ path, reason });
      return false;
    }
    return true;
  });
  return { wanted, skipped };
}

/**
 * Plans what the chosen files become. Pure: no network, no globals, deterministic order.
 *
 * `preSkipped` carries what `screenPaths` already turned away, so the preview's skipped rows are
 * whole even though those files were never read.
 */
export function planImport(
  sources: readonly ImportSource[],
  parse: ParseBody,
  rootTitle = 'Imported notes',
  preSkipped: readonly PathReason[] = [],
): ImportPlan {
  const skipped: PathReason[] = [...preSkipped];
  const failed: PathReason[] = [];

  // A folder pick prefixes every path with the folder's own name; when that holds, the folder
  // becomes the root's name and the segment is consumed so it is not repeated as a child.
  const segmented = sources.map((source) => ({
    source,
    segments: toSegments(source.path),
  }));
  const shared = sharedHead(segmented.map((entry) => entry.segments));
  const title = shared ?? rootTitle;

  const draft: DraftFolder = { name: title, folders: new Map(), notes: [] };

  for (const { source, segments } of segmented) {
    const relative = shared !== null ? segments.slice(1) : segments;
    const reason = skipReasonFor(relative);
    if (reason !== null) {
      skipped.push({ path: source.path, reason });
      continue;
    }

    const fileName = relative[relative.length - 1] ?? '';
    const note = planNote(source.path, fileName, source.text, parse, failed);
    if (note === null) {
      continue;
    }

    let cursor = draft;
    for (const segment of relative.slice(0, -1)) {
      let next = cursor.folders.get(segment);
      if (next === undefined) {
        next = { name: segment, folders: new Map(), notes: [] };
        cursor.folders.set(segment, next);
      }
      cursor = next;
    }
    cursor.notes.push(note);
  }

  if (draft.folders.size === 0 && draft.notes.length === 0) {
    return { root: null, totalItems: 0, skipped, failed };
  }

  const root = toNode(draft, title);
  return { root, totalItems: countNodes(root), skipped, failed };
}

function toSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * Why a path (relative to any shared head) is not importable, or null when it is. The one
 * definition `screenPaths` and `planImport` both apply.
 */
function skipReasonFor(relative: readonly string[]): string | null {
  if (relative.length === 0) {
    return 'not a file';
  }
  if (relative.slice(0, -1).some((segment) => segment.startsWith('.'))) {
    return 'inside a hidden directory, not imported';
  }
  const fileName = relative[relative.length - 1] ?? '';
  if (!fileName.toLowerCase().endsWith('.md')) {
    return 'not a Markdown file';
  }
  return null;
}

/** The head segment every path shares when all of them have one and something after it. */
function sharedHead(paths: readonly (readonly string[])[]): string | null {
  if (paths.length === 0) {
    return null;
  }
  const head = paths[0]?.[0];
  if (head === undefined) {
    return null;
  }
  const allShare = paths.every((segments) => segments.length >= 2 && segments[0] === head);
  return allShare ? head : null;
}

function planNote(
  path: string,
  fileName: string,
  text: string,
  parse: ParseBody,
  failed: PathReason[],
): PlannedNode | null {
  const { title, properties, body, dropped } = noteFromMarkdown(text, fileName);

  let doc: unknown = null;
  if (body.trim().length > 0) {
    const parsed = parse(body);
    if (!parsed.ok) {
      failed.push({ path, reason: `not a valid note body: ${parsed.reason}` });
      return null;
    }
    doc = parsed.doc;
  }

  return {
    path,
    kind: 'note',
    title,
    properties,
    doc,
    droppedFrontMatter: dropped,
    unresolvedWikiLinks: countWikiLinks(body),
    unresolvedLocalImages: countLocalImages(body),
    children: [],
  };
}

/** Folders then files would be one order, names another; names, because that is what a tree shows. */
function toNode(folder: DraftFolder, path: string): PlannedNode {
  const children: PlannedNode[] = [
    ...[...folder.folders.values()].map((child) => toNode(child, `${path}/${child.name}`)),
    ...folder.notes,
  ].sort((left, right) => left.title.localeCompare(right.title));

  return {
    path,
    kind: 'container',
    title: folder.name,
    properties: {},
    doc: null,
    droppedFrontMatter: [],
    unresolvedWikiLinks: 0,
    unresolvedLocalImages: 0,
    children,
  };
}

function countNodes(node: PlannedNode): number {
  let total = 1;
  for (const child of node.children) {
    total += countNodes(child);
  }
  return total;
}
