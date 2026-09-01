import {
  BASE_SCHEMA_VERSION,
  SCHEMA_VERSION,
  parseDocument,
  requiredSchemaVersion,
} from '@nix/editor-schema';
import { SHEET_ITEM_TYPE, SHEET_SCHEMA_VERSION, checkSheetSnapshot } from '@nix/sheet';
import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from 'fflate';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_ENTRY,
  TEMPLATE_PROFILE_VERSION,
  isArchiveSafeId,
  type ArchiveItemEntry,
  type ArchiveManifest,
  type ItemBody,
  type ItemBundle,
  type SchemaSnapshot,
  type TemplateArchiveProfile,
  type ViewRowSnapshot,
  type ViewSnapshot,
  type ViewsSnapshot,
} from './manifest.js';

/** Bounds applied while bytes are still compressed and before JSON is trusted. */
export interface ArchiveReadLimits {
  readonly maxInputBytes: number;
  readonly maxEntryBytes: number;
  readonly maxUncompressedBytes: number;
  readonly maxEntries: number;
  readonly maxItems: number;
  readonly maxCompressionRatio: number;
}

export const TEMPLATE_ARCHIVE_LIMITS: ArchiveReadLimits = {
  maxInputBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxEntries: 201,
  maxItems: 200,
  maxCompressionRatio: 100,
};

/**
 * Maximum JSON request a trusted import worker may forward after parsing an archive.
 *
 * The zip's expanded entries may total more because the internal request adds one containing
 * object and repeats the small profile. Preview measures the actual request against this bound,
 * and Collab applies the identical Fastify body limit, so a file cannot pass preview and then be
 * rejected merely because the service seam has a smaller envelope.
 */
export const TEMPLATE_IMPORT_REQUEST_BYTES = 40 * 1024 * 1024;

export interface ReadArchiveOptions {
  readonly limits?: ArchiveReadLimits;
  readonly signal?: AbortSignal;
}

export interface ReadArchiveResult {
  readonly manifest: ArchiveManifest;
  readonly bundles: readonly ItemBundle[];
}

/**
 * Parses the already-expanded archive object passed between trusted services.
 *
 * The import worker owns zip expansion and byte limits. Collab still owns its HTTP boundary, so it
 * must not turn the worker's JSON back into archive types with an assertion. This entry point
 * deliberately reuses the exact manifest, bundle and cross-entry parsers used by
 * {@link readArchive}; the services therefore cannot disagree about whether a nested schema, view,
 * body or tree is a valid archive.
 */
export function parseArchiveObject(
  value: unknown,
  maxItems = TEMPLATE_ARCHIVE_LIMITS.maxItems,
): ReadArchiveResult {
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0) {
    throw new TypeError('The archive object item limit must be a positive safe integer.');
  }
  if (!record(value) || !Array.isArray(value.bundles) || value.bundles.length > maxItems) {
    throw refusal(
      'archive.invalid_bundle',
      `The expanded archive must contain at most ${String(maxItems)} item payloads.`,
    );
  }

  const manifest = parseManifest(value.manifest, maxItems);
  const bundles = new Map<string, ItemBundle>();
  for (const candidate of value.bundles) {
    const bundle = parseBundle(candidate, 'a forwarded item payload');
    if (bundles.has(bundle.id)) {
      throw refusal(
        'archive.duplicate_item',
        `The archive contains item ${bundle.id} more than once.`,
      );
    }
    bundles.set(bundle.id, bundle);
  }

  validateWholeArchive(manifest, bundles);
  return {
    manifest,
    bundles: manifest.items.map((entry) => requiredBundle(bundles, entry.id)),
  };
}

/** A stable machine code and a sentence safe to surface in a problem detail. */
export class ArchiveReadError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'ArchiveReadError';
    this.code = code;
  }
}

/**
 * Reads a zip incrementally and returns only after its whole shape has been proved consistent.
 *
 * `Unzip` emits one entry at a time from the incoming chunks. Each entry is bounded before its
 * chunks are retained; the archive total is bounded independently; and JSON is parsed only after
 * the entry closes. The returned values are held because an import has to validate every parent,
 * payload and declared identifier before Core stages its first row. That memory is bounded by
 * `maxUncompressedBytes`, not by what the sender chose to declare in a zip header.
 */
export async function readArchive(
  source: AsyncIterable<Uint8Array>,
  options: ReadArchiveOptions = {},
): Promise<ReadArchiveResult> {
  const limits = options.limits ?? TEMPLATE_ARCHIVE_LIMITS;
  validateLimits(limits);

  let inputBytes = 0;
  let outputBytes = 0;
  let entries = 0;
  let failure: ArchiveReadError | null = null;
  let manifest: ArchiveManifest | null = null;
  const bundles = new Map<string, ItemBundle>();
  const names = new Set<string>();
  const pending = new Set<string>();
  const currentFailure = (): ArchiveReadError | null => failure;

  const unzip = new Unzip((file) => {
    if (failure !== null) {
      file.terminate();
      return;
    }

    try {
      options.signal?.throwIfAborted();
      entries += 1;
      if (entries > limits.maxEntries) {
        throw refusal(
          'archive.too_many_entries',
          `The archive contains more than ${String(limits.maxEntries)} entries.`,
        );
      }
      if (!safeEntryName(file.name)) {
        throw refusal(
          'archive.invalid_entry_name',
          `The archive entry "${file.name}" is not allowed.`,
        );
      }
      if (names.has(file.name)) {
        throw refusal(
          'archive.duplicate_entry',
          `The archive contains "${file.name}" more than once.`,
        );
      }
      if (entries === 1 && file.name !== MANIFEST_ENTRY) {
        throw refusal(
          'archive.manifest_not_first',
          `The first archive entry must be ${MANIFEST_ENTRY}.`,
        );
      }
      const entryItemId = file.name === MANIFEST_ENTRY ? null : itemIdFromEntryName(file.name);
      if (file.name !== MANIFEST_ENTRY && entryItemId === null) {
        throw refusal(
          'archive.invalid_entry_name',
          `The archive entry "${file.name}" is not a manifest or item payload.`,
        );
      }
      if (file.compression !== 0 && file.compression !== 8) {
        throw refusal(
          'archive.unsupported_compression',
          `The archive entry "${file.name}" uses an unsupported compression method.`,
        );
      }
      if (file.originalSize !== undefined && file.originalSize > limits.maxEntryBytes) {
        throw refusal(
          'archive.entry_too_large',
          `The archive entry "${file.name}" is larger than ${String(limits.maxEntryBytes)} bytes.`,
        );
      }
      if (
        file.size !== undefined &&
        file.originalSize !== undefined &&
        file.originalSize > Math.max(1, file.size) * limits.maxCompressionRatio
      ) {
        throw refusal(
          'archive.compression_ratio',
          `The archive entry "${file.name}" expands beyond the allowed compression ratio.`,
        );
      }

      names.add(file.name);
      pending.add(file.name);
      readEntry(file, limits.maxEntryBytes, (bytes) => {
        if (failure !== null) return;
        try {
          outputBytes += bytes.byteLength;
          if (outputBytes > limits.maxUncompressedBytes) {
            throw refusal(
              'archive.too_large',
              `The expanded archive is larger than ${String(limits.maxUncompressedBytes)} bytes.`,
            );
          }
          const value = parseJson(bytes, file.name);
          if (file.name === MANIFEST_ENTRY) {
            if (manifest !== null) {
              throw refusal(
                'archive.duplicate_entry',
                `The archive contains ${MANIFEST_ENTRY} more than once.`,
              );
            }
            manifest = parseManifest(value, limits.maxItems);
          } else {
            const bundle = parseBundle(value, file.name);
            if (bundle.id !== entryItemId) {
              throw refusal(
                'archive.bundle_mismatch',
                `The payload in "${file.name}" has a different item identifier.`,
              );
            }
            if (bundles.has(bundle.id)) {
              throw refusal(
                'archive.duplicate_item',
                `The archive contains item ${bundle.id} more than once.`,
              );
            }
            bundles.set(bundle.id, bundle);
          }
          pending.delete(file.name);
        } catch (error) {
          failure = asArchiveError(error);
        }
      });
    } catch (error) {
      failure = asArchiveError(error);
      file.terminate();
    }
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of source) {
      options.signal?.throwIfAborted();
      const beforePush = currentFailure();
      if (beforePush !== null) throw beforePush;
      inputBytes += chunk.byteLength;
      if (inputBytes > limits.maxInputBytes) {
        throw refusal(
          'archive.too_large',
          `The archive is larger than ${String(limits.maxInputBytes)} bytes.`,
        );
      }
      unzip.push(chunk, false);
      const afterPush = currentFailure();
      if (afterPush !== null) throw afterPush;
    }
    unzip.push(new Uint8Array(), true);
  } catch (error) {
    if (error instanceof ArchiveReadError) throw error;
    if (options.signal?.aborted === true) {
      throw options.signal.reason instanceof DOMException &&
        options.signal.reason.name === 'TimeoutError'
        ? refusal('archive.timed_out', 'The archive was not fully read within 30 seconds.')
        : refusal('archive.cancelled', 'The archive read was cancelled.');
    }
    throw asArchiveError(error);
  }

  const finalFailure = currentFailure();
  if (finalFailure !== null) throw finalFailure;
  if (pending.size > 0) {
    throw refusal(
      'archive.truncated',
      `The archive ended before ${[...pending][0] ?? 'an entry'} was complete.`,
    );
  }
  if (outputBytes > Math.max(1, inputBytes) * limits.maxCompressionRatio) {
    throw refusal(
      'archive.compression_ratio',
      'The archive expands beyond the allowed compression ratio.',
    );
  }
  const parsedManifest = manifest as ArchiveManifest | null;
  if (parsedManifest === null) {
    throw refusal('archive.manifest_missing', `The archive does not contain ${MANIFEST_ENTRY}.`);
  }

  validateWholeArchive(parsedManifest, bundles);
  return {
    manifest: parsedManifest,
    bundles: parsedManifest.items.map((entry) => requiredBundle(bundles, entry.id)),
  };
}

function requiredBundle(bundles: ReadonlyMap<string, ItemBundle>, id: string): ItemBundle {
  const bundle = bundles.get(id);
  if (bundle === undefined) {
    throw refusal('archive.bundle_missing', `The archive has no payload for item ${id}.`);
  }
  return bundle;
}

/** Template endpoints require the additive profile and a complete, lossless archive. */
export function requireTemplateProfile(manifest: ArchiveManifest): TemplateArchiveProfile {
  const candidate: unknown = manifest.profile;
  if (candidate === undefined) {
    throw refusal(
      'template.profile_missing',
      'This is a Nix archive, but it is not a template file.',
    );
  }
  if (
    !record(candidate) ||
    candidate.kind !== 'template' ||
    candidate.version !== TEMPLATE_PROFILE_VERSION
  ) {
    throw refusal(
      'template.profile_unsupported',
      'This template profile is not supported by this build.',
    );
  }
  const profile = candidate as unknown as TemplateArchiveProfile;
  if (manifest.omitted.length > 0 || manifest.loss.length > 0) {
    throw refusal(
      'template.archive_incomplete',
      'A template file cannot contain omitted or lossy items.',
    );
  }
  if (!profile.includeChildren && manifest.items.length !== 1) {
    throw refusal(
      'template.children_mismatch',
      'This template says it excludes children but contains more than its root item.',
    );
  }
  return profile;
}

/** Proves the cross-entry rules a template needs before it may be staged. */
export function validateTemplateArchive(archive: ReadArchiveResult): TemplateArchiveProfile {
  const profile = requireTemplateProfile(archive.manifest);
  const rootBundle = archive.bundles.find((bundle) => bundle.id === archive.manifest.root);
  if (!profile.includeBody && rootBundle !== undefined && rootBundle.body !== null) {
    throw refusal(
      'template.body_mismatch',
      'This template says it excludes its root body but contains one.',
    );
  }
  for (const bundle of archive.bundles) {
    if (
      bundle.body !== null &&
      !('sheet' in bundle.body) &&
      bundle.body.schemaVersion > archive.manifest.schemaVersion
    ) {
      throw refusal(
        'template.body_schema_mismatch',
        `The body for item ${bundle.id} uses a schema newer than the archive manifest declares.`,
      );
    }
    validateBodyKind(bundle);
    validateViews(bundle);
  }
  return profile;
}

/**
 * Parses Core's compact stored-view JSON into the lossless archive representation.
 *
 * Stored views omit fields whose values are the format defaults. This parser accepts only that
 * omission: a field that is present still has to satisfy the same nested and semantic rules as an
 * archive view. Keeping this parser beside the archive reader prevents service clients from
 * reconstructing trusted view or Interactive Form objects with casts.
 */
export function parseStoredViewsObject(value: unknown, ownerId: string): ViewsSnapshot | null {
  if (value === null || value === undefined) return null;
  if (!record(value) || !Array.isArray(value.views) || value.views.length > 12) {
    throw refusal('archive.views_invalid', `The views on item ${ownerId} are invalid.`);
  }
  const defaultView = value.default ?? 'document';
  if (typeof defaultView !== 'string') {
    throw refusal('archive.views_invalid', `The views on item ${ownerId} are invalid.`);
  }
  const views: ViewsSnapshot = {
    default: defaultView,
    views: value.views.map((candidate) => {
      if (!record(candidate)) {
        throw refusal('archive.views_invalid', `Item ${ownerId} contains an unsupported view.`);
      }
      return parseView(
        {
          ...candidate,
          columns: candidate.columns === undefined ? [] : candidate.columns,
          groupOrder: candidate.groupOrder === undefined ? [] : candidate.groupOrder,
          sortDescending: candidate.sortDescending === undefined ? false : candidate.sortDescending,
        },
        ownerId,
      );
    }),
  };
  validateViewsSnapshot(views, ownerId);
  return views;
}

const VIEW_KINDS = new Set([
  'list',
  'board',
  'calendar',
  'gallery',
  'timeline',
  'sheet',
  'form',
  'query',
  'interactive_form',
]);
const FILTER_OPERATORS = new Set([
  'equals',
  'not-equals',
  'on',
  'before',
  'on-or-after',
  'within-next',
]);
const FORM_BLOCK_KINDS = new Set(['field', 'heading', 'paragraph']);
const FORM_CONDITION_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'checked',
  'not_checked',
]);
const FORM_IDENTITY_ROLES = new Set(['name', 'email']);
const FORM_TITLE_MODES = new Set(['generated', 'field']);
const CARD_SIZES = new Set(['small', 'medium', 'large']);

function validateBodyKind(bundle: ItemBundle): void {
  if (bundle.body === null) return;
  const body = bundle.body as unknown;
  if (!record(body) || !integer(body.schemaVersion)) {
    throw refusal(
      'template.body_invalid',
      `The body for item ${bundle.id} has no valid schema version.`,
    );
  }
  const expected =
    bundle.type === 'canvas' ? 'canvas' : isSheetItemType(bundle.type) ? 'sheet' : 'prosemirror';
  if (!(expected in body)) {
    throw refusal(
      'template.body_kind_mismatch',
      `The body for item ${bundle.id} does not match item type "${bundle.type}".`,
    );
  }
}

function validateViews(bundle: ItemBundle): void {
  if (bundle.views === null) return;
  validateViewsSnapshot(bundle.views, bundle.id);
}

function validateViewsSnapshot(views: ViewsSnapshot, ownerId: string): void {
  const ids = new Set<string>();
  const byId = new Map(views.views.map((view) => [view.id, view]));
  if (views.default !== 'document' && !byId.has(views.default)) {
    throw refusal('template.views_invalid', `The default view for item ${ownerId} does not exist.`);
  }
  for (const view of views.views) {
    if (view.id.length === 0 || ids.has(view.id) || !VIEW_KINDS.has(view.kind)) {
      throw refusal(
        'template.views_invalid',
        `Item ${ownerId} contains a duplicate or unsupported view.`,
      );
    }
    ids.add(view.id);
    const companionId = view.companionViewId ?? null;
    if (companionId !== null) {
      const companion = byId.get(companionId);
      if (companionId === view.id || companion === undefined || companion.companionViewId != null) {
        throw refusal(
          'template.composition_invalid',
          `The view composition on item ${ownerId} is invalid.`,
        );
      }
    }
    if (view.kind === 'interactive_form' && view.interactiveForm == null) {
      throw refusal(
        'template.form_invalid',
        `Interactive form view ${view.id} has no form configuration.`,
      );
    }
    if (view.kind !== 'interactive_form' && view.interactiveForm != null) {
      throw refusal(
        'template.form_invalid',
        `Only an interactive form view may carry form configuration.`,
      );
    }
    if (view.kind === 'interactive_form' && view.interactiveForm != null) {
      validateInteractiveForm(view.interactiveForm, ownerId, view.id);
    }
  }
}

function validateInteractiveForm(
  form: NonNullable<ViewSnapshot['interactiveForm']>,
  ownerId: string,
  viewId: string,
): void {
  const pageIds = new Set<string>();
  const blockIds = new Set<string>();
  const fieldIds = new Set<string>();
  const earlierFieldIds = new Set<string>();
  const identityRoles = new Set<string>();
  for (const page of form.pages) {
    if (page.id.length === 0 || pageIds.has(page.id)) {
      throw invalidForm(ownerId, viewId, 'every page needs a unique identifier');
    }
    pageIds.add(page.id);
    validateEarlierConditions(page.visibleWhen, earlierFieldIds, ownerId, viewId);
    for (const block of page.blocks) {
      if (block.id.length === 0 || blockIds.has(block.id)) {
        throw invalidForm(ownerId, viewId, 'every block needs a unique identifier');
      }
      blockIds.add(block.id);
      validateEarlierConditions(block.visibleWhen, earlierFieldIds, ownerId, viewId);
      if (block.kind === 'field') {
        if (block.propertyKey === null || block.propertyKey.trim().length === 0) {
          throw invalidForm(ownerId, viewId, `field "${block.id}" needs a property`);
        }
        fieldIds.add(block.id);
        earlierFieldIds.add(block.id);
      } else if (block.propertyKey !== null || block.required || block.identityRole !== null) {
        throw invalidForm(
          ownerId,
          viewId,
          `non-field block "${block.id}" carries field-only configuration`,
        );
      }
      if (block.identityRole !== null && identityRoles.has(block.identityRole)) {
        throw invalidForm(
          ownerId,
          viewId,
          `respondent ${block.identityRole} is assigned more than once`,
        );
      }
      if (block.identityRole !== null) identityRoles.add(block.identityRole);
    }
  }
  if (
    form.titleMode === 'field' &&
    (form.titleFieldBlockId === null || !fieldIds.has(form.titleFieldBlockId))
  ) {
    throw invalidForm(ownerId, viewId, 'the response title does not name a field block');
  }
  if (form.titleMode === 'generated' && form.titleFieldBlockId !== null) {
    throw invalidForm(ownerId, viewId, 'a generated response title cannot name a field block');
  }
}

function validateEarlierConditions(
  conditions: readonly { readonly fieldBlockId: string }[],
  earlierFieldIds: ReadonlySet<string>,
  ownerId: string,
  viewId: string,
): void {
  for (const condition of conditions) {
    if (!earlierFieldIds.has(condition.fieldBlockId)) {
      throw invalidForm(ownerId, viewId, 'a condition does not reference an earlier field');
    }
  }
}

function invalidForm(ownerId: string, viewId: string, reason: string): ArchiveReadError {
  return refusal(
    'template.form_invalid',
    `Interactive form ${viewId} on item ${ownerId}: ${reason}.`,
  );
}

function readEntry(file: UnzipFile, ceiling: number, complete: (bytes: Uint8Array) => void): void {
  const chunks: Uint8Array[] = [];
  let length = 0;
  file.ondata = (error, chunk, final) => {
    if (error !== null) {
      throw refusal(
        'archive.invalid_zip',
        `The archive entry "${file.name}" could not be expanded.`,
      );
    }
    length += chunk.byteLength;
    if (length > ceiling) {
      file.terminate();
      throw refusal(
        'archive.entry_too_large',
        `The archive entry "${file.name}" is larger than ${String(ceiling)} bytes.`,
      );
    }
    if (chunk.byteLength > 0) chunks.push(chunk);
    if (final) complete(join(chunks, length));
  };
  file.start();
}

function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array();
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseJson(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw refusal('archive.invalid_json', `The archive entry "${name}" is not valid UTF-8 JSON.`);
  }
}

function parseManifest(value: unknown, maxItems: number): ArchiveManifest {
  if (!record(value) || value.format !== ARCHIVE_FORMAT) {
    throw refusal(
      'archive.invalid_manifest',
      `The manifest must declare format "${ARCHIVE_FORMAT}".`,
    );
  }
  if (value.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw refusal(
      'archive.version_unsupported',
      `Archive format version ${String(value.formatVersion)} is not supported by this build.`,
    );
  }
  const schemaVersion = value.schemaVersion;
  const exportedAt = value.exportedAt;
  const root = value.root;
  if (
    !integer(schemaVersion) ||
    typeof exportedAt !== 'string' ||
    typeof root !== 'string' ||
    !isArchiveSafeId(root)
  ) {
    throw refusal(
      'archive.invalid_manifest',
      'The manifest version, export time or root identifier is invalid.',
    );
  }
  if (schemaVersion < BASE_SCHEMA_VERSION || schemaVersion > SCHEMA_VERSION) {
    throw refusal(
      'archive.schema_unsupported',
      `Archive schema version ${String(schemaVersion)} is not supported by this build.`,
    );
  }
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > maxItems) {
    throw refusal(
      'archive.invalid_manifest',
      `The manifest must contain between 1 and ${String(maxItems)} items.`,
    );
  }
  if (
    !Array.isArray(value.omitted) ||
    value.omitted.length > maxItems ||
    !Array.isArray(value.loss) ||
    value.loss.length > maxItems
  ) {
    throw refusal(
      'archive.invalid_manifest',
      'The manifest must state its omitted and loss entries.',
    );
  }
  if (typeof value.includesDeleted !== 'boolean') {
    throw refusal(
      'archive.invalid_manifest',
      'The manifest must state whether deleted items are included.',
    );
  }
  const items = value.items.map(parseItemEntry);
  const profile = value.profile === undefined ? undefined : parseTemplateProfile(value.profile);
  return {
    format: value.format,
    formatVersion: value.formatVersion,
    schemaVersion,
    ...(profile === undefined ? {} : { profile }),
    exportedAt,
    root,
    rootEffectiveSchema: parseNullableSchema(value.rootEffectiveSchema, 'the manifest root'),
    includesDeleted: value.includesDeleted,
    items,
    omitted: value.omitted.map(parseOmission),
    loss: value.loss.map(parseLoss),
  };
}

const OMISSION_REASONS = new Set(['not-readable', 'soft-deleted', 'limit-reached']);

function parseOmission(value: unknown): ArchiveManifest['omitted'][number] {
  if (
    !record(value) ||
    (value.id !== null && (typeof value.id !== 'string' || !isArchiveSafeId(value.id))) ||
    typeof value.parentId !== 'string' ||
    !isArchiveSafeId(value.parentId) ||
    typeof value.reason !== 'string' ||
    !OMISSION_REASONS.has(value.reason) ||
    !shortText(value.detail, 1000, true)
  ) {
    throw refusal('archive.invalid_manifest', 'The manifest contains an invalid omission entry.');
  }
  return {
    id: value.id,
    parentId: value.parentId,
    reason: value.reason as ArchiveManifest['omitted'][number]['reason'],
    detail: value.detail,
  };
}

function parseLoss(value: unknown): ArchiveManifest['loss'][number] {
  if (
    !record(value) ||
    typeof value.itemId !== 'string' ||
    !isArchiveSafeId(value.itemId) ||
    !shortText(value.kind, 100) ||
    !shortText(value.detail, 1000, true)
  ) {
    throw refusal('archive.invalid_manifest', 'The manifest contains an invalid loss entry.');
  }
  return { itemId: value.itemId, kind: value.kind, detail: value.detail };
}

function parseTemplateProfile(value: unknown): TemplateArchiveProfile {
  if (!record(value)) {
    throw refusal('template.profile_invalid', 'The template profile is incomplete or invalid.');
  }
  const key = value.key;
  const name = value.name;
  const description = value.description;
  const includeBody = value.includeBody;
  const includeChildren = value.includeChildren;
  if (
    value.kind !== 'template' ||
    value.version !== TEMPLATE_PROFILE_VERSION ||
    !portableKey(key) ||
    !shortText(name, 200) ||
    !shortText(description, 1000, true) ||
    typeof includeBody !== 'boolean' ||
    typeof includeChildren !== 'boolean'
  ) {
    throw refusal('template.profile_invalid', 'The template profile is incomplete or invalid.');
  }
  return {
    kind: 'template',
    version: TEMPLATE_PROFILE_VERSION,
    key,
    name,
    description,
    includeBody,
    includeChildren,
  };
}

function parseItemEntry(value: unknown): ArchiveItemEntry {
  if (!record(value)) {
    throw refusal('archive.invalid_manifest', 'The manifest contains an invalid item entry.');
  }
  const id = value.id;
  const parentId = value.parentId;
  const seq = value.seq;
  const title = value.title;
  const type = value.type;
  if (
    typeof id !== 'string' ||
    !isArchiveSafeId(id) ||
    (parentId !== null && (typeof parentId !== 'string' || !isArchiveSafeId(parentId))) ||
    typeof seq !== 'string' ||
    !/^-?\d+$/.test(seq) ||
    !shortText(title, 1000, true) ||
    !shortText(type, 100)
  ) {
    throw refusal('archive.invalid_manifest', 'The manifest contains an invalid item entry.');
  }
  return { id, parentId, seq, title, type };
}

function parseBundle(value: unknown, name: string): ItemBundle {
  if (!record(value)) {
    throw refusal(
      'archive.invalid_bundle',
      `The archive entry "${name}" is not a valid item payload.`,
    );
  }
  const id = value.id;
  const parentId = value.parentId;
  const workspaceId = value.workspaceId;
  const seq = value.seq;
  const type = value.type;
  const title = value.title;
  const lifecycleState = value.lifecycleState;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (
    typeof id !== 'string' ||
    !isArchiveSafeId(id) ||
    (parentId !== null && (typeof parentId !== 'string' || !isArchiveSafeId(parentId))) ||
    typeof workspaceId !== 'string' ||
    !isArchiveSafeId(workspaceId) ||
    typeof seq !== 'string' ||
    !/^-?\d+$/.test(seq) ||
    !shortText(type, 100) ||
    !shortText(title, 1000, true) ||
    typeof lifecycleState !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    !record(value.properties) ||
    !Array.isArray(value.viewRows) ||
    typeof value.viewRowsTruncated !== 'boolean'
  ) {
    throw refusal(
      'archive.invalid_bundle',
      `The archive entry "${name}" is not a valid item payload.`,
    );
  }
  return {
    id,
    parentId,
    workspaceId,
    type,
    title,
    seq,
    lifecycleState,
    createdAt,
    updatedAt,
    properties: value.properties,
    schema: parseNullableSchema(value.schema, `item ${id}`),
    views: parseNullableViews(value.views, id),
    viewRows: value.viewRows.map((row) => parseViewRow(row, id)),
    viewRowsTruncated: value.viewRowsTruncated,
    body: parseNullableBody(value.body, type, id),
  };
}

// The server's closed set, mirrored (`PropertyType.cs` / `PropertyTypes.TryParse` is the canon).
// This copy is a validator, so unlike `view-render`'s open rendering set it refuses what it does
// not know - which means a type added to the canon and not here breaks the archive round trip for
// exactly the schemas that carry it. `reader.test.ts` enumerates this list against the canon's
// current fourteen names so the drift is a failing test, not a refused import.
const PROPERTY_TYPES = new Set([
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'timestamp',
  'image',
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
]);

function parseNullableSchema(value: unknown, owner: string): SchemaSnapshot | null {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    !Array.isArray(value.properties) ||
    !Array.isArray(value.declared) ||
    typeof value.inherit !== 'boolean'
  ) {
    throw refusal('archive.schema_invalid', `The schema on ${owner} is invalid.`);
  }
  return {
    properties: value.properties.map((property) => parseProperty(property, owner)),
    declared: value.declared.map((property) => parseProperty(property, owner)),
    inherit: value.inherit,
  };
}

function parseProperty(value: unknown, owner: string): SchemaSnapshot['properties'][number] {
  if (
    !record(value) ||
    !shortText(value.key, 200) ||
    !shortText(value.label, 500) ||
    typeof value.type !== 'string' ||
    !PROPERTY_TYPES.has(value.type) ||
    !Array.isArray(value.options) ||
    !value.options.every((option) => typeof option === 'string') ||
    typeof value.required !== 'boolean'
  ) {
    throw refusal(
      'archive.schema_invalid',
      `The schema on ${owner} contains an unsupported property.`,
    );
  }
  return {
    key: value.key,
    label: value.label,
    type: value.type,
    options: value.options,
    required: value.required,
  };
}

function parseNullableViews(value: unknown, ownerId: string): ViewsSnapshot | null {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    typeof value.default !== 'string' ||
    !Array.isArray(value.views) ||
    value.views.length > 12
  ) {
    throw refusal('archive.views_invalid', `The views on item ${ownerId} are invalid.`);
  }
  return { default: value.default, views: value.views.map((view) => parseView(view, ownerId)) };
}

function parseView(value: unknown, ownerId: string): ViewSnapshot {
  if (
    !record(value) ||
    !shortText(value.id, 200) ||
    !shortText(value.name, 500) ||
    typeof value.kind !== 'string' ||
    !VIEW_KINDS.has(value.kind) ||
    !stringArray(value.columns) ||
    !stringArray(value.groupOrder) ||
    typeof value.sortDescending !== 'boolean'
  ) {
    throw refusal('archive.views_invalid', `Item ${ownerId} contains an unsupported view.`);
  }
  const placement = value.companionPlacement;
  if (
    placement !== null &&
    placement !== undefined &&
    placement !== 'below' &&
    placement !== 'beside'
  ) {
    throw refusal(
      'archive.views_invalid',
      `Item ${ownerId} contains an unsupported companion placement.`,
    );
  }
  const filters = value.filters === undefined ? [] : value.filters;
  if (!Array.isArray(filters) || filters.length > 8) {
    throw refusal('archive.views_invalid', `Item ${ownerId} contains invalid filters.`);
  }
  if (
    value.cardSize !== null &&
    value.cardSize !== undefined &&
    (typeof value.cardSize !== 'string' || !CARD_SIZES.has(value.cardSize))
  ) {
    throw refusal('archive.views_invalid', `Item ${ownerId} contains an unsupported card size.`);
  }
  const companionViewId = nullableString(value.companionViewId, ownerId);
  if ((companionViewId === null) !== (placement === null || placement === undefined)) {
    throw refusal(
      'archive.views_invalid',
      `Item ${ownerId} contains an incomplete companion configuration.`,
    );
  }
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    columns: value.columns,
    groupBy: nullableString(value.groupBy, ownerId),
    groupOrder: value.groupOrder,
    dateProperty: nullableString(value.dateProperty, ownerId),
    sortBy: nullableString(value.sortBy, ownerId),
    sortDescending: value.sortDescending,
    mode: nullableString(value.mode, ownerId),
    coverProperty: nullableString(value.coverProperty, ownerId),
    endDateProperty: nullableString(value.endDateProperty, ownerId),
    cardSize: nullableString(value.cardSize, ownerId),
    filters: filters.map((filter) => parseFilter(filter, ownerId)),
    companionViewId,
    companionPlacement: placement ?? null,
    interactiveForm: parseNullableForm(value.interactiveForm, ownerId),
  };
}

function parseFilter(
  value: unknown,
  ownerId: string,
): NonNullable<ViewSnapshot['filters']>[number] {
  if (
    !record(value) ||
    typeof value.property !== 'string' ||
    typeof value.operator !== 'string' ||
    !FILTER_OPERATORS.has(value.operator) ||
    typeof value.value !== 'string'
  ) {
    throw refusal('archive.views_invalid', `Item ${ownerId} contains an invalid filter.`);
  }
  return { property: value.property, operator: value.operator, value: value.value };
}

function parseNullableForm(
  value: unknown,
  ownerId: string,
): NonNullable<ViewSnapshot['interactiveForm']> | null {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    !Array.isArray(value.pages) ||
    value.pages.length === 0 ||
    value.pages.length > 50 ||
    typeof value.titleMode !== 'string' ||
    !FORM_TITLE_MODES.has(value.titleMode) ||
    typeof value.confirmationTitle !== 'string' ||
    typeof value.confirmationMessage !== 'string'
  ) {
    throw refusal('archive.form_invalid', `Item ${ownerId} contains an invalid interactive form.`);
  }
  return {
    pages: value.pages.map((page) => parseFormPage(page, ownerId)),
    titleMode: value.titleMode,
    titleFieldBlockId: nullableString(value.titleFieldBlockId, ownerId),
    confirmationTitle: value.confirmationTitle,
    confirmationMessage: value.confirmationMessage,
  };
}

function parseFormPage(
  value: unknown,
  ownerId: string,
): NonNullable<ViewSnapshot['interactiveForm']>['pages'][number] {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.blocks) ||
    value.blocks.length === 0 ||
    value.blocks.length > 500
  ) {
    throw refusal('archive.form_invalid', `Item ${ownerId} contains an invalid form page.`);
  }
  return {
    id: value.id,
    title: value.title,
    description: nullableString(value.description, ownerId),
    visibleWhen: parseConditions(value.visibleWhen, ownerId),
    blocks: value.blocks.map((block) => parseFormBlock(block, ownerId)),
  };
}

function parseFormBlock(
  value: unknown,
  ownerId: string,
): NonNullable<ViewSnapshot['interactiveForm']>['pages'][number]['blocks'][number] {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string' ||
    !FORM_BLOCK_KINDS.has(value.kind) ||
    typeof value.text !== 'string' ||
    typeof value.required !== 'boolean'
  ) {
    throw refusal('archive.form_invalid', `Item ${ownerId} contains an invalid form block.`);
  }
  const identityRole = nullableString(value.identityRole, ownerId);
  if (identityRole !== null && !FORM_IDENTITY_ROLES.has(identityRole)) {
    throw refusal(
      'archive.form_invalid',
      `Item ${ownerId} contains an invalid respondent identity role.`,
    );
  }
  return {
    id: value.id,
    kind: value.kind,
    propertyKey: nullableString(value.propertyKey, ownerId),
    text: value.text,
    help: nullableString(value.help, ownerId),
    required: value.required,
    identityRole,
    visibleWhen: parseConditions(value.visibleWhen, ownerId),
  };
}

function parseConditions(
  value: unknown,
  ownerId: string,
): NonNullable<ViewSnapshot['interactiveForm']>['pages'][number]['visibleWhen'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw refusal('archive.form_invalid', `Item ${ownerId} contains invalid form conditions.`);
  }
  return value.map((condition) => {
    if (
      !record(condition) ||
      typeof condition.fieldBlockId !== 'string' ||
      typeof condition.operator !== 'string' ||
      !FORM_CONDITION_OPERATORS.has(condition.operator)
    ) {
      throw refusal('archive.form_invalid', `Item ${ownerId} contains an invalid form condition.`);
    }
    return {
      fieldBlockId: condition.fieldBlockId,
      operator: condition.operator,
      value: nullableString(condition.value, ownerId),
    };
  });
}

function parseViewRow(value: unknown, ownerId: string): ViewRowSnapshot {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    !record(value.properties)
  ) {
    throw refusal('archive.view_rows_invalid', `Item ${ownerId} contains an invalid view row.`);
  }
  return { id: value.id, title: value.title, properties: value.properties };
}

function parseNullableBody(value: unknown, itemType: string, itemId: string): ItemBody | null {
  if (value === null || value === undefined) return null;
  if (!record(value) || !integer(value.schemaVersion)) {
    throw refusal('archive.body_invalid', `The body for item ${itemId} is invalid.`);
  }
  if (itemType === 'canvas') {
    if (
      value.schemaVersion < BASE_SCHEMA_VERSION ||
      value.schemaVersion > SCHEMA_VERSION ||
      !record(value.canvas) ||
      !record(value.canvas.elements) ||
      Object.keys(value.canvas.elements).length > 10_000 ||
      !Object.entries(value.canvas.elements).every(([id, element]) => {
        if (!record(element)) return false;
        return (
          element.id === id &&
          typeof element.type === 'string' &&
          typeof element.version === 'number' &&
          typeof element.versionNonce === 'number'
        );
      })
    ) {
      throw refusal('archive.body_invalid', `The canvas body for item ${itemId} is invalid.`);
    }
    return { schemaVersion: value.schemaVersion, canvas: value.canvas };
  }
  if (isSheetItemType(itemType)) {
    const sheet = value.sheet;
    const meta = record(sheet) ? sheet.meta : null;
    const colWidths = record(meta) && meta.colWidths !== undefined ? meta.colWidths : {};
    if (
      value.schemaVersion !== SHEET_SCHEMA_VERSION ||
      !record(sheet) ||
      sheet.body !== 'sheet' ||
      !record(sheet.cells) ||
      !Object.values(sheet.cells).every((cell) => typeof cell === 'string') ||
      !record(meta) ||
      !integer(meta.rows) ||
      meta.rows === 0 ||
      !integer(meta.cols) ||
      meta.cols === 0 ||
      !record(colWidths) ||
      !Object.values(colWidths).every((width) => typeof width === 'number')
    ) {
      throw refusal('archive.body_invalid', `The sheet body for item ${itemId} is invalid.`);
    }
    const rejection = checkSheetSnapshot({
      body: 'sheet',
      cells: sheet.cells as Readonly<Record<string, string>>,
      meta: {
        rows: meta.rows,
        cols: meta.cols,
        colWidths: colWidths as Readonly<Record<string, number>>,
      },
    });
    if (rejection !== null) {
      throw refusal(
        'archive.body_invalid',
        `The sheet body for item ${itemId} is invalid: ${rejection.message}`,
      );
    }
    return { schemaVersion: value.schemaVersion, sheet };
  }
  if (value.schemaVersion < BASE_SCHEMA_VERSION || value.schemaVersion > SCHEMA_VERSION) {
    throw refusal(
      'archive.body_schema_unsupported',
      `The body for item ${itemId} uses an unsupported schema.`,
    );
  }
  if (!record(value.prosemirror)) {
    throw refusal('archive.body_invalid', `The prose body for item ${itemId} is invalid.`);
  }
  const parsed = parseDocument(value.prosemirror);
  if (!parsed.ok || requiredSchemaVersion(parsed.document) > value.schemaVersion) {
    throw refusal('archive.body_invalid', `The prose body for item ${itemId} is invalid.`);
  }
  return { schemaVersion: value.schemaVersion, prosemirror: value.prosemirror };
}

function nullableString(value: unknown, ownerId: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw refusal(
      'archive.invalid_bundle',
      `Item ${ownerId} contains a field that must be text or null.`,
    );
  }
  return value;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateWholeArchive(
  manifest: ArchiveManifest,
  bundles: ReadonlyMap<string, ItemBundle>,
): void {
  const seen = new Set<string>();
  const depths = new Map<string, number>();
  const declared = new Map(manifest.items.map((item) => [item.id, item]));
  if (!declared.has(manifest.root))
    throw refusal('archive.invalid_manifest', 'The archive root is not listed in its items.');

  for (const entry of manifest.items) {
    if (seen.has(entry.id))
      throw refusal(
        'archive.duplicate_item',
        `The manifest lists item ${entry.id} more than once.`,
      );
    if (entry.id !== manifest.root && (entry.parentId === null || !seen.has(entry.parentId))) {
      throw refusal(
        'archive.invalid_tree',
        `Item ${entry.id} does not follow its parent in the archive.`,
      );
    }
    const depth = entry.parentId === null ? 0 : (depths.get(entry.parentId) ?? 32) + 1;
    if (depth > 32) {
      throw refusal(
        'archive.tree_too_deep',
        'The archive contains an item below the maximum depth of 32.',
      );
    }
    const bundle = bundles.get(entry.id);
    if (bundle === undefined)
      throw refusal('archive.bundle_missing', `The archive has no payload for item ${entry.id}.`);
    if (
      bundle.parentId !== entry.parentId ||
      bundle.seq !== entry.seq ||
      bundle.type !== entry.type ||
      bundle.title !== entry.title
    ) {
      throw refusal(
        'archive.bundle_mismatch',
        `The payload for item ${entry.id} disagrees with the manifest.`,
      );
    }
    seen.add(entry.id);
    depths.set(entry.id, depth);
  }
  if (bundles.size !== manifest.items.length) {
    throw refusal(
      'archive.unlisted_bundle',
      'The archive contains an item payload the manifest does not list.',
    );
  }
}

function safeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function itemIdFromEntryName(name: string): string | null {
  if (!name.startsWith('items/') || !name.endsWith('.json')) return null;
  const id = name.slice('items/'.length, -'.json'.length);
  return isArchiveSafeId(id) ? id : null;
}

function isSheetItemType(itemType: string): boolean {
  return itemType === SHEET_ITEM_TYPE || itemType === 'sheet';
}

function portableKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9._-]{0,158}[a-z0-9])?$/.test(value);
}

function shortText(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLimits(limits: ArchiveReadLimits): void {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError('Archive read limits must be positive safe integers.');
  }
}

function refusal(code: string, message: string): ArchiveReadError {
  return new ArchiveReadError(code, message);
}

function asArchiveError(error: unknown): ArchiveReadError {
  return error instanceof ArchiveReadError
    ? error
    : refusal(
        'archive.invalid_zip',
        error instanceof Error ? error.message : 'The archive is not a readable zip file.',
      );
}
