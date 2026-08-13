/**
 * The `.nix` archive manifest — ADR-0017.
 *
 * The manifest is the archive's spine: parentage, sibling order and what was left out live here
 * rather than in the payloads, so a reader can reconstruct the tree, decide whether it wants the
 * bodies, and stream them, without opening a single one.
 */

/** What a `.nix` file says it is. A reader that finds anything else should refuse it. */
export const ARCHIVE_FORMAT = 'nix-archive';

/**
 * The archive's own shape.
 *
 * **Deliberately independent of `SCHEMA_VERSION`.** The container and the document block set change
 * for different reasons and on different cadences; one number for both would force a fake bump on
 * whichever side did not change.
 */
export const ARCHIVE_FORMAT_VERSION = 1;

/** The manifest's entry name. Always the first entry written, so a reader can stream. */
export const MANIFEST_ENTRY = 'manifest.json';

/** Where an item's payload lives, given its identifier in the source workspace. */
export function itemEntryName(sourceId: string): string {
  return `items/${sourceId}.json`;
}

/**
 * One item's place in the tree.
 *
 * `seq` is a string because it is an `int64` on the wire and JavaScript numbers cannot hold every
 * one of them. Sibling order is data - `ItemResponse.Seq` is documented as "its position among its
 * siblings" and every view renders in it - so rounding it silently would reorder somebody's board.
 */
export interface ArchiveItemEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly seq: string;
  readonly title: string;
  readonly type: string;
}

/** Why something inside the exported subtree is not in the archive. */
export type OmissionReason = 'not-readable' | 'soft-deleted' | 'limit-reached';

/**
 * Something the export could not or would not include.
 *
 * An archive with a hole in it and no comment is a lie about the one property this format sells,
 * so every gap is named. `id` is null where the export knows only that a parent had more children
 * than it took - a listing omits what the caller cannot read entirely, so there is no identifier to
 * report.
 */
export interface Omission {
  readonly id: string | null;
  readonly parentId: string;
  readonly reason: OmissionReason;
  readonly detail: string;
}

/**
 * Something a mapper could not represent in its target format.
 *
 * Empty for `.nix`, and that emptiness is the claim - this is the lossless format, so an entry here
 * is a bug rather than a note. It is defined in the shared manifest because the lossy exporters
 * (Markdown, PDF, DOCX) owe a stated list of what does not survive, and one shape for that list is
 * what lets an import report and an export report be read the same way.
 */
export interface LossEntry {
  readonly itemId: string;
  readonly kind: string;
  readonly detail: string;
}

/** A property as its schema declares it. */
export interface PropertyDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly options: readonly string[];
  readonly required: boolean;
}

/**
 * The property schema in force at an item.
 *
 * **`properties` is the effective set and `declared` is this item's own contribution**, which is
 * the distinction that makes a subtree re-importable. The cascade reaches past whatever boundary an
 * export draws - `GetEffectiveSchemaHandler` merges every ancestor's declaration and says outright
 * that no client can reconstruct them - so an archive carrying only `declared` would land items
 * holding property values that no schema declares.
 */
export interface SchemaSnapshot {
  readonly properties: readonly PropertyDefinition[];
  readonly declared: readonly PropertyDefinition[];
  readonly inherit: boolean;
}

/** A view over an item's children, as stored. */
export interface ViewSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly columns: readonly string[];
  readonly groupBy: string | null;
  readonly groupOrder: readonly string[];
  readonly dateProperty: string | null;
  readonly sortBy: string | null;
  readonly sortDescending: boolean;
  readonly mode: string | null;
  readonly coverProperty: string | null;
  readonly endDateProperty: string | null;
  readonly cardSize: string | null;
}

/** The view set an item offers over its children. */
export interface ViewsSnapshot {
  readonly views: readonly ViewSnapshot[];
  readonly default: string;
}

export interface ArchiveManifest {
  /**
   * Always {@link ARCHIVE_FORMAT}, and typed as a plain string on purpose.
   *
   * A reader parses this out of JSON somebody else wrote, so a literal type here would be a claim
   * the compiler cannot back - and a reader that trusts the field because its type says so is
   * exactly how a hostile archive gets treated as one of ours. The writer checks it instead.
   */
  readonly format: string;
  readonly formatVersion: number;

  /** The `editor-schema` version the bodies in this archive were written against. */
  readonly schemaVersion: number;

  readonly exportedAt: string;

  /** The item the export was rooted at. Always present in `items`. */
  readonly root: string;

  /**
   * The effective schema at the root, so an import can re-declare what the root inherited from
   * ancestors that are not in the archive. See {@link SchemaSnapshot}.
   */
  readonly rootEffectiveSchema: SchemaSnapshot | null;

  /** Whether soft-deleted descendants were included. Stated either way. */
  readonly includesDeleted: boolean;

  /** Every item in the archive, parents before children, siblings in `seq` order. */
  readonly items: readonly ArchiveItemEntry[];

  readonly omitted: readonly Omission[];
  readonly loss: readonly LossEntry[];
}

/** An item's payload: what it is, what it carries, and what it says about its children. */
export interface ItemBundle {
  readonly id: string;
  readonly parentId: string | null;
  readonly workspaceId: string;
  readonly type: string;
  readonly title: string;
  readonly seq: string;
  readonly lifecycleState: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly properties: Readonly<Record<string, unknown>>;

  /** What this item declares for its children, or null when it declares nothing. */
  readonly schema: SchemaSnapshot | null;

  /** How its children are shown, or null when it offers no views. */
  readonly views: ViewsSnapshot | null;

  /** Its own document body, or null when it has never been opened. */
  readonly body: ItemBody | null;
}

/**
 * An item's own content, in whichever shape its body kind stores it.
 *
 * **One arm per body kind, and a missing arm is a hole in the format's central claim.** A body kind
 * with no arm here reads as `body: null` - indistinguishable from an item nobody has ever opened -
 * so the archive would say "this item has no content" about an item full of it. That is exactly the
 * silent gap ADR-0017 refuses, which is why a new body kind owes an arm here in the same commit
 * that legalises it.
 */
export type ItemBody = ProseBody | SheetBody | CanvasBody;

export interface ProseBody {
  /** The schema version this body was validated against when it was written. */
  readonly schemaVersion: number;

  /** ProseMirror JSON, stored verbatim. This is what makes `.nix` the lossless format. */
  readonly prosemirror: unknown;
}

/** A spreadsheet item's body: the raw cell grid, versioned on its own axis. */
export interface SheetBody {
  /** The sheet schema version, independent of the note schema's. */
  readonly schemaVersion: number;

  /** The cell grid as { body: 'sheet', cells, meta }, stored verbatim. */
  readonly sheet: unknown;
}

/**
 * A canvas item's body: the scene, element by element.
 *
 * Stored as `{ elements }` keyed by element id, which is the client's reconciliation contract
 * rather than a shape invented here - the same JSON `canvasStrategy.materialize` writes to the
 * snapshot. A lossy exporter has nothing to draw a scene with and says so with `body-not-rendered`;
 * `.nix` carries it verbatim, because carrying it is what makes `.nix` lossless.
 */
export interface CanvasBody {
  /**
   * The base schema version. A scene holds no ProseMirror nodes, so nothing in it can require a
   * newer build, and the field is here for uniformity with the other arms rather than to be read.
   */
  readonly schemaVersion: number;

  /** The scene as { elements: { [id]: element } }, stored verbatim. */
  readonly canvas: unknown;
}

/**
 * Whether a string is safe to use as the identifying part of an archive entry name.
 *
 * Identifiers reaching the writer come from Core and are always UUIDs, so this never fires in
 * practice. It is here because "never in practice" is how a path traversal gets written: an entry
 * name is a path, and the check that it cannot contain one belongs at the point where the path is
 * built rather than in the reasoning of whoever calls it.
 */
export function isArchiveSafeId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
}
