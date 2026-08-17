import {
  parseArchiveObject,
  validateTemplateArchive,
  type ArchiveManifest,
  type ItemBundle,
  type TemplateArchiveProfile,
} from '@nix/export';

export interface CaptureRequest {
  readonly workspaceId: string;
  readonly sourceItemId: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly idempotencyKey: string;
}

export interface ApplicationRequest {
  readonly templateId: string;
  readonly mode: 'merge' | 'create';
  readonly targetItemId?: string | undefined;
  readonly parentItemId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly idempotencyKey: string;
}

export interface ImportedTemplate {
  readonly manifest: ArchiveManifest;
  readonly bundles: readonly ItemBundle[];
  readonly profile: TemplateArchiveProfile;
  readonly digest: string;
  readonly workspaceId: string;
  readonly origin: 'user' | 'managed';
  readonly managedSource?: string | undefined;
  readonly idempotencyKey: string;
}

export interface StagedImport {
  readonly operationId: string | null;
  readonly templateId: string;
  readonly stableKey: string;
  readonly digest: string;
  readonly unchanged: boolean;
  readonly writtenTargetItemIds: readonly string[];
}

export interface DraftMetadataPatch {
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
}

export interface BeginDraftRequest {
  readonly idempotencyKey: string;
}

export interface DraftItemPatch {
  readonly title?: string | null | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | null | undefined;
  readonly schema?: Readonly<Record<string, unknown>> | null | undefined;
  readonly views?: Readonly<Record<string, unknown>> | null | undefined;
}

export interface ManagedFinalizeRequest {
  readonly imports: readonly StagedImport[];
  readonly activeStableKeys: readonly string[];
}

export class TemplateHttpContractError extends Error {
  public readonly status = 400;
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'TemplateHttpContractError';
    this.code = code;
  }
}

export function parseCaptureRequest(value: unknown): CaptureRequest {
  const body = requestRecord(value, 'template.capture_invalid', 'A capture request is required.');
  const workspaceId = requiredUuid(body.workspaceId);
  const sourceItemId = requiredUuid(body.sourceItemId);
  const title = requiredText(body.title);
  const idempotencyKey = requiredText(body.idempotencyKey);
  if (
    workspaceId === null ||
    sourceItemId === null ||
    title === null ||
    idempotencyKey === null ||
    typeof body.includeBody !== 'boolean' ||
    typeof body.includeChildren !== 'boolean' ||
    !optionalNullableText(body.description)
  ) {
    throw invalid(
      'template.capture_invalid',
      'A workspace, source item, title, capture options and idempotency key are required.',
    );
  }
  return {
    workspaceId,
    sourceItemId,
    title,
    ...(body.description === undefined ? {} : { description: body.description }),
    includeBody: body.includeBody,
    includeChildren: body.includeChildren,
    idempotencyKey,
  };
}

export function parseApplicationRequest(value: unknown): ApplicationRequest {
  const body = requestRecord(
    value,
    'template.application_invalid',
    'A template application request is required.',
  );
  const templateId = requiredUuid(body.templateId);
  const idempotencyKey = requiredText(body.idempotencyKey);
  if (
    templateId === null ||
    idempotencyKey === null ||
    (body.mode !== 'merge' && body.mode !== 'create') ||
    !optionalUuid(body.targetItemId) ||
    !optionalNullableUuid(body.parentItemId) ||
    !optionalText(body.title)
  ) {
    throw invalid(
      'template.application_invalid',
      'A template, mode, valid destination and idempotency key are required.',
    );
  }
  return {
    templateId,
    mode: body.mode,
    ...(body.targetItemId === undefined ? {} : { targetItemId: body.targetItemId }),
    ...(body.parentItemId === undefined ? {} : { parentItemId: body.parentItemId }),
    ...(body.title === undefined ? {} : { title: body.title }),
    idempotencyKey,
  };
}

export function parseImportedTemplate(value: unknown): ImportedTemplate {
  const body = requestRecord(
    value,
    'template.import_invalid',
    'A validated template import plan is required.',
  );
  let archive: { readonly manifest: ArchiveManifest; readonly bundles: readonly ItemBundle[] };
  try {
    archive = parseArchiveObject({ manifest: body.manifest, bundles: body.bundles });
  } catch {
    throw invalid('template.import_invalid', 'The validated template archive is inconsistent.');
  }
  const profile = templateProfile(body.profile);
  const digest =
    typeof body.digest === 'string' && /^[0-9a-f]{64}$/i.test(body.digest) ? body.digest : null;
  const workspaceId = requiredUuid(body.workspaceId);
  const idempotencyKey = requiredText(body.idempotencyKey);
  if (
    profile === null ||
    digest === null ||
    workspaceId === null ||
    idempotencyKey === null ||
    (body.origin !== 'user' && body.origin !== 'managed') ||
    !optionalText(body.managedSource)
  ) {
    throw invalid('template.import_invalid', 'The validated template import plan is incomplete.');
  }

  try {
    const validatedProfile = validateTemplateArchive(archive);
    if (
      validatedProfile.key !== profile.key ||
      validatedProfile.name !== profile.name ||
      validatedProfile.description !== profile.description ||
      validatedProfile.includeBody !== profile.includeBody ||
      validatedProfile.includeChildren !== profile.includeChildren
    ) {
      throw invalid(
        'template.import_invalid',
        'The template profile does not match the validated archive manifest.',
      );
    }
  } catch (error) {
    if (error instanceof TemplateHttpContractError) throw error;
    throw invalid('template.import_invalid', 'The validated template archive is inconsistent.');
  }

  return {
    manifest: archive.manifest,
    bundles: archive.bundles,
    profile,
    digest,
    workspaceId,
    origin: body.origin,
    ...(body.managedSource === undefined ? {} : { managedSource: body.managedSource }),
    idempotencyKey,
  };
}

export function parseDraftMetadataPatch(value: unknown): DraftMetadataPatch {
  const body = requestRecord(
    value,
    'template.draft_invalid',
    'A template draft update is required.',
  );
  if (!optionalNullableText(body.title) || !optionalNullableText(body.description)) {
    throw invalid('template.draft_invalid', 'Draft title and description must be text or null.');
  }
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.description === undefined ? {} : { description: body.description }),
  };
}

export function parseBeginDraftRequest(value: unknown): BeginDraftRequest {
  const body = requestRecord(
    value,
    'template.draft_invalid',
    'A template draft request is required.',
  );
  const idempotencyKey = requiredText(body.idempotencyKey);
  if (idempotencyKey === null) {
    throw invalid('template.draft_invalid', 'An idempotency key is required.');
  }
  return { idempotencyKey };
}

export function parseDraftItemPatch(value: unknown): DraftItemPatch {
  const body = requestRecord(
    value,
    'template.draft_item_invalid',
    'A template draft item update is required.',
  );
  if (
    !optionalNullableText(body.title) ||
    !optionalNullableRecord(body.properties) ||
    !optionalNullableRecord(body.schema) ||
    !optionalNullableRecord(body.views)
  ) {
    throw invalid(
      'template.draft_item_invalid',
      'Draft item fields must contain the expected text or object values.',
    );
  }
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.properties === undefined ? {} : { properties: body.properties }),
    ...(body.schema === undefined ? {} : { schema: body.schema }),
    ...(body.views === undefined ? {} : { views: body.views }),
  };
}

export function parseManagedFinalizeRequest(value: unknown): ManagedFinalizeRequest {
  const body = requestRecord(
    value,
    'template.finalize_invalid',
    'A managed template finalization request is required.',
  );
  if (
    !Array.isArray(body.imports) ||
    !Array.isArray(body.activeStableKeys) ||
    !body.activeStableKeys.every((key) => typeof key === 'string')
  ) {
    throw invalid(
      'template.finalize_invalid',
      'Imports and activeStableKeys must be arrays with the expected values.',
    );
  }
  return {
    imports: body.imports.map(parseStagedImport),
    activeStableKeys: body.activeStableKeys,
  };
}

function parseStagedImport(value: unknown): StagedImport {
  const item = asRecord(value);
  const operationId = item?.operationId === null ? null : requiredUuid(item?.operationId);
  const templateId = requiredUuid(item?.templateId);
  const stableKey = requiredText(item?.stableKey);
  if (
    item === null ||
    (operationId === null && item.operationId !== null) ||
    templateId === null ||
    stableKey === null ||
    typeof item.digest !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(item.digest) ||
    typeof item.unchanged !== 'boolean' ||
    !Array.isArray(item.writtenTargetItemIds) ||
    !item.writtenTargetItemIds.every((id) => requiredUuid(id) !== null)
  ) {
    throw invalid('template.finalize_invalid', 'A staged template entry is invalid.');
  }
  return {
    operationId,
    templateId,
    stableKey,
    digest: item.digest,
    unchanged: item.unchanged,
    writtenTargetItemIds: item.writtenTargetItemIds,
  };
}

function templateProfile(value: unknown): TemplateArchiveProfile | null {
  const profile = asRecord(value);
  const key = requiredText(profile?.key);
  const name = requiredText(profile?.name);
  if (
    profile?.kind !== 'template' ||
    profile.version !== 1 ||
    key === null ||
    name === null ||
    typeof profile.description !== 'string' ||
    typeof profile.includeBody !== 'boolean' ||
    typeof profile.includeChildren !== 'boolean'
  ) {
    return null;
  }
  return {
    kind: 'template',
    version: 1,
    key,
    name,
    description: profile.description,
    includeBody: profile.includeBody,
    includeChildren: profile.includeChildren,
  };
}

function requestRecord(value: unknown, code: string, detail: string): Record<string, unknown> {
  const body = asRecord(value);
  if (body === null) throw invalid(code, detail);
  return body;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalUuid(value: unknown): value is string | undefined {
  return value === undefined || requiredUuid(value) !== null;
}

function optionalNullableUuid(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || requiredUuid(value) !== null;
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalNullableText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function optionalNullableRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> | null | undefined {
  return value === undefined || value === null || asRecord(value) !== null;
}

function invalid(code: string, detail: string): TemplateHttpContractError {
  return new TemplateHttpContractError(code, detail);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
