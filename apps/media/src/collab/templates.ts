import type { ArchiveManifest, ItemBundle, TemplateArchiveProfile } from '@nix/export';

export interface ImportedTemplateRequest {
  readonly manifest: ArchiveManifest;
  readonly bundles: readonly ItemBundle[];
  readonly profile: TemplateArchiveProfile;
  readonly digest: string;
  readonly workspaceId: string;
  readonly origin: 'user' | 'managed';
  readonly managedSource?: string | undefined;
  readonly idempotencyKey: string;
}

export interface TemplateImportAuthorization {
  readonly workspaceId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly canWrite: boolean;
  readonly canManageTemplates: boolean;
}

export interface TemplateValidationResult {
  readonly itemCount: number;
  readonly bodyCount: number;
}

export interface StagedTemplate {
  readonly operationId: string | null;
  readonly templateId: string;
  readonly stableKey: string;
  readonly digest: string;
  readonly unchanged: boolean;
  readonly writtenTargetItemIds: readonly string[];
}

export interface ManagedTemplateResult {
  readonly activated: number;
  readonly unchanged: number;
  readonly retired: number;
}

export interface TemplateStageSweep {
  readonly removed: number;
  readonly itemIds: readonly string[];
}

export interface ManagedFinalizeRequest {
  readonly imports: readonly StagedTemplate[];
  readonly activeStableKeys: readonly string[];
}

export interface TemplateImporter {
  authorizePreview(
    token: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TemplateImportAuthorization>;
  validateTemplate(
    token: string,
    request: ImportedTemplateRequest,
    signal?: AbortSignal,
  ): Promise<TemplateValidationResult>;
  importTemplate(
    token: string,
    request: ImportedTemplateRequest,
    signal?: AbortSignal,
  ): Promise<StagedTemplate>;
  stageTemplate(
    token: string,
    request: ImportedTemplateRequest,
    signal?: AbortSignal,
  ): Promise<StagedTemplate>;
  finalizeManaged(
    token: string,
    workspaceId: string,
    imports: readonly StagedTemplate[],
    activeStableKeys: readonly string[],
    signal?: AbortSignal,
  ): Promise<ManagedTemplateResult>;
  abortStage(token: string, operationId: string, signal?: AbortSignal): Promise<void>;
  sweepExpired(
    token: string,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<TemplateStageSweep>;
}

export class TemplateImportRefusal extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TemplateImportRefusal';
    this.status = status;
    this.code = code;
  }
}

export function createTemplateImporter(options: {
  readonly collabBaseUrl: string;
  readonly internalSecret: string;
  readonly fetch?: typeof globalThis.fetch;
}): TemplateImporter {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function post<T>(
    token: string,
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await doFetch(`${options.collabBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-nix-internal-secret': options.internalSecret,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = record(answer);
      throw new TemplateImportRefusal(
        response.status,
        text(detail.code) || 'template.import_refused',
        text(detail.detail) || 'The template import was refused.',
      );
    }
    return parseAnswer(path, answer, parse);
  }

  async function get<T>(
    token: string,
    path: string,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await doFetch(`${options.collabBaseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-nix-internal-secret': options.internalSecret,
        accept: 'application/json',
      },
      ...(signal === undefined ? {} : { signal }),
    });
    const answer = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = record(answer);
      throw new TemplateImportRefusal(
        response.status,
        text(detail.code) || 'template.import_refused',
        text(detail.detail) || 'The template import was refused.',
      );
    }
    return parseAnswer(path, answer, parse);
  }

  return {
    authorizePreview: (token, workspaceId, signal) =>
      get(
        token,
        `/workspaces/${workspaceId}/templates/import-authorization`,
        parseImportAuthorization,
        signal,
      ),
    validateTemplate: (token, request, signal) =>
      post(token, '/templates/imports/validate', request, parseValidation, signal),
    importTemplate: (token, request, signal) =>
      post(token, '/templates/imports', request, parseStagedTemplate, signal),
    stageTemplate: (token, request, signal) =>
      post(token, '/templates/imports/stage', request, parseStagedTemplate, signal),
    finalizeManaged: (token, workspaceId, imports, activeStableKeys, signal) =>
      post(
        token,
        `/workspaces/${workspaceId}/templates/managed/finalize`,
        { imports, activeStableKeys },
        parseManagedResult,
        signal,
      ),
    sweepExpired: (token, workspaceId, signal) =>
      post(
        token,
        `/workspaces/${workspaceId}/template-stages/expired/sweep`,
        {},
        parseStageSweep,
        signal,
      ),
    async abortStage(token, operationId, signal) {
      const response = await doFetch(`${options.collabBaseUrl}/templates/imports/${operationId}`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
          'x-nix-internal-secret': options.internalSecret,
        },
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok && response.status !== 404) {
        throw new TemplateImportRefusal(
          response.status,
          'template.abort_refused',
          'The staged template import could not be discarded.',
        );
      }
    },
  };
}

export function parseManagedFinalizeRequest(value: unknown): ManagedFinalizeRequest {
  try {
    const body = requiredRecord(value);
    if (!Array.isArray(body.imports) || !Array.isArray(body.activeStableKeys)) {
      throw new Error('arrays');
    }
    return {
      imports: body.imports.map(parseStagedTemplate),
      activeStableKeys: body.activeStableKeys.map(requiredText),
    };
  } catch (error) {
    if (error instanceof TemplateImportRefusal) throw error;
    throw new TemplateImportRefusal(
      400,
      'template.finalize_invalid',
      'Imports and activeStableKeys must be arrays with the expected values.',
    );
  }
}

function parseAnswer<T>(path: string, value: unknown, parse: (value: unknown) => T): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof TemplateImportRefusal) throw error;
    throw new TemplateImportRefusal(
      502,
      'template.collab_contract_invalid',
      `Collaboration returned an invalid template response for ${path}.`,
    );
  }
}

function parseImportAuthorization(value: unknown): TemplateImportAuthorization {
  const body = requiredRecord(value);
  return {
    workspaceId: requiredUuid(body.workspaceId),
    tenantId: requiredUuid(body.tenantId),
    principalId: requiredUuid(body.principalId),
    canWrite: requiredBoolean(body.canWrite),
    canManageTemplates: requiredBoolean(body.canManageTemplates),
  };
}

function parseValidation(value: unknown): TemplateValidationResult {
  const body = requiredRecord(value);
  return {
    itemCount: requiredInteger(body.itemCount),
    bodyCount: requiredInteger(body.bodyCount),
  };
}

function parseStagedTemplate(value: unknown): StagedTemplate {
  const body = requiredRecord(value);
  return {
    operationId: nullableUuid(body.operationId),
    templateId: requiredUuid(body.templateId),
    stableKey: requiredText(body.stableKey),
    digest: requiredDigest(body.digest),
    unchanged: requiredBoolean(body.unchanged),
    writtenTargetItemIds: requiredArray(body.writtenTargetItemIds, requiredUuid),
  };
}

function parseManagedResult(value: unknown): ManagedTemplateResult {
  const body = requiredRecord(value);
  return {
    activated: requiredInteger(body.activated),
    unchanged: requiredInteger(body.unchanged),
    retired: requiredInteger(body.retired),
  };
}

function parseStageSweep(value: unknown): TemplateStageSweep {
  const body = requiredRecord(value);
  return {
    removed: requiredInteger(body.removed),
    itemIds: requiredArray(body.itemIds, requiredUuid),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('object');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('text');
  return value;
}

function requiredUuid(value: unknown): string {
  const candidate = requiredText(value);
  if (!UUID.test(candidate)) throw new Error('uuid');
  return candidate;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : requiredUuid(value);
}

function requiredDigest(value: unknown): string {
  const candidate = requiredText(value);
  if (!/^[0-9a-f]{64}$/i.test(candidate)) throw new Error('digest');
  return candidate;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('boolean');
  return value;
}

function requiredInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error('integer');
  return value;
}

function requiredArray<T>(value: unknown, parse: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error('array');
  return value.map(parse);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
