import { parseStoredViewsObject, type PropertyDefinition, type ViewsSnapshot } from '@nix/export';

export interface ItemMapping {
  readonly sourceId: string;
  readonly itemId: string;
  readonly itemType: string;
}

export interface OperationAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly itemType: string;
  readonly canWrite: boolean;
}

export interface CoreTemplateClient {
  beginCapture(token: string, body: object): Promise<CaptureBegin>;
  beginImport(token: string, body: object): Promise<ImportBegin>;
  beginApplication(token: string, body: object): Promise<ApplicationBegin>;
  authorizeOperationItem(
    token: string,
    operationId: string,
    itemId: string,
  ): Promise<OperationAuthorization>;
  finalize(
    token: string,
    kind: OperationKind,
    operationId: string,
    writtenTargetItemIds: readonly string[],
  ): Promise<FinalizeTemplateResult | FinalizeApplicationResult>;
  abort(token: string, kind: OperationKind, operationId: string): Promise<void>;
  finalizeManaged(
    token: string,
    workspaceId: string,
    imports: readonly ManagedImport[],
    activeStableKeys: readonly string[],
  ): Promise<ManagedFinalizeResult>;
  sweepExpired(token: string, workspaceId: string): Promise<TemplateStageSweep>;
  authorizeImport(token: string, workspaceId: string): Promise<TemplateImportAuthorization>;
  beginDraft(token: string, templateId: string, idempotencyKey: string): Promise<TemplateDraft>;
  getDraft(token: string, templateId: string, operationId: string): Promise<TemplateDraft>;
  patchDraft(
    token: string,
    templateId: string,
    operationId: string,
    body: object,
  ): Promise<TemplateDraft>;
  patchDraftItem(
    token: string,
    templateId: string,
    operationId: string,
    sourceId: string,
    body: object,
  ): Promise<TemplateDraftItem>;
  saveDraft(
    token: string,
    templateId: string,
    operationId: string,
  ): Promise<FinalizeTemplateResult>;
  discardDraft(token: string, templateId: string, operationId: string): Promise<void>;
  authorizeDraftItem(
    token: string,
    templateId: string,
    operationId: string,
    sourceId: string,
  ): Promise<TemplateItemAuthorization>;
  authorizeTemplateItem(
    token: string,
    templateId: string,
    sourceId: string,
  ): Promise<TemplateItemAuthorization>;
  getTemplateExport(token: string, templateId: string): Promise<TemplateExportSnapshot>;
}

export interface TemplateStageSweep {
  readonly removed: number;
  readonly itemIds: readonly string[];
}

export interface FinalizeTemplateResult {
  readonly templateId: string;
}

export interface FinalizeApplicationResult {
  readonly targetItemId: string;
}

export interface ManagedImport {
  readonly operationId: string | null;
  readonly templateId: string;
  readonly stableKey: string;
  readonly digest: string;
  readonly unchanged: boolean;
  readonly writtenTargetItemIds: readonly string[];
}

export interface ManagedFinalizeResult {
  readonly activated: number;
  readonly unchanged: number;
  readonly retired: number;
}

export interface TemplateImportAuthorization {
  readonly workspaceId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly canWrite: boolean;
  readonly canManageTemplates: boolean;
}

export interface TemplateItemAuthorization extends OperationAuthorization {
  readonly templateId: string;
  readonly sourceId: string;
  readonly itemId: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
}

export interface TemplateExportItem {
  readonly sourceId: string;
  readonly parentSourceId: string | null;
  readonly itemId: string;
  readonly itemType: string;
  readonly title: string;
  readonly seq: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly schema: TemplateExportSchema | null;
  readonly views: ViewsSnapshot | null;
  readonly hasBody: boolean;
}

/** Core stores declarations; Collab expands them into the archive snapshot shape. */
export interface TemplateExportSchema {
  readonly properties: readonly PropertyDefinition[];
  readonly inherit: boolean;
  /** Accepted when Core has already supplied the expanded archive representation. */
  readonly declared?: readonly PropertyDefinition[] | undefined;
}

export interface TemplatePropertySchemaResponse {
  readonly properties: readonly PropertyDefinition[];
  readonly declared: readonly PropertyDefinition[];
  readonly inherit: boolean;
}

export interface TemplateDraftItem {
  readonly sourceId: string;
  readonly itemType: string;
  readonly title: string;
  readonly seq: string;
  readonly properties: Readonly<Record<string, unknown>> | null;
  readonly schema: TemplatePropertySchemaResponse | null;
  readonly views: ViewsSnapshot | null;
  readonly hasBody: boolean;
  readonly children: readonly TemplateDraftItem[];
}

export interface TemplateDraft {
  readonly operationId: string;
  readonly templateId: string;
  readonly title: string;
  readonly description: string | null;
  readonly expiresAt: string;
  readonly root: TemplateDraftItem;
  readonly itemMappings: readonly ItemMapping[];
  readonly bodyCopies: readonly { sourceItemId: string; targetItemId: string; itemType: string }[];
}

export interface TemplateExportSnapshot {
  readonly templateId: string;
  readonly workspaceId: string;
  readonly stableKey: string;
  readonly title: string;
  readonly description: string | null;
  readonly origin: 'user' | 'seed' | 'managed';
  readonly revision: number;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly items: readonly TemplateExportItem[];
}

export type OperationKind = 'captures' | 'imports' | 'applications';

export interface CaptureBegin {
  readonly operationId: string;
  readonly templateId: string;
  readonly bodyCopies: readonly { sourceItemId: string; targetItemId: string; itemType: string }[];
  readonly itemMappings: readonly ItemMapping[];
}

export interface ImportBegin {
  readonly operationId: string | null;
  readonly templateId: string;
  readonly unchanged: boolean;
  readonly bodyWrites: readonly { sourceId: string; targetItemId: string; itemType: string }[];
  readonly itemMappings: readonly ItemMapping[];
}

export interface ApplicationBegin {
  readonly applicationId: string;
  readonly templateId: string;
  readonly targetItemId: string;
  readonly alreadyApplied: boolean;
  readonly createdItems: readonly ItemMapping[];
  readonly bodyCopies: readonly { sourceItemId: string; targetItemId: string; itemType: string }[];
  readonly itemMappings: readonly ItemMapping[];
}

export class CoreTemplateError extends Error {
  public readonly status: number;
  public readonly code: string;

  public constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CoreTemplateError';
    this.status = status;
    this.code = code;
  }
}

export function createCoreTemplateClient(options: {
  readonly coreBaseUrl: string;
  readonly internalSecret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): CoreTemplateClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function send<T>(
    token: string,
    path: string,
    init: RequestInit,
    parse: (value: unknown) => T,
  ): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(`${options.coreBaseUrl}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'x-nix-internal-secret': options.internalSecret,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CoreTemplateError(
        503,
        'template.core_unavailable',
        'Core did not answer the template operation.',
      );
    }

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = record(body);
      throw new CoreTemplateError(
        response.status,
        text(problem.code) || 'template.operation_refused',
        text(problem.detail) || 'Core refused the template operation.',
      );
    }
    try {
      return parse(body);
    } catch (error) {
      if (error instanceof CoreTemplateError) throw error;
      throw new CoreTemplateError(
        502,
        'template.core_contract_invalid',
        `Core returned an invalid template response for ${path}.`,
      );
    }
  }

  return {
    beginCapture: (token, body) =>
      send(
        token,
        '/internal/templates/captures/begin',
        { method: 'POST', body: JSON.stringify(body) },
        parseCaptureBegin,
      ),
    beginImport: (token, body) =>
      send(
        token,
        '/internal/templates/imports/begin',
        { method: 'POST', body: JSON.stringify(body) },
        parseImportBegin,
      ),
    beginApplication: (token, body) =>
      send(
        token,
        '/internal/templates/applications/begin',
        { method: 'POST', body: JSON.stringify(body) },
        parseApplicationBegin,
      ),
    authorizeOperationItem: (token, operationId, itemId) =>
      send(
        token,
        `/internal/template-operations/${operationId}/items/${itemId}/authorization`,
        { method: 'GET' },
        parseOperationAuthorization,
      ),
    finalize(token, kind, operationId, writtenTargetItemIds) {
      const path = `/internal/templates/${kind}/${operationId}/finalize`;
      const request = { method: 'POST', body: JSON.stringify({ writtenTargetItemIds }) };
      return kind === 'applications'
        ? send(token, path, request, parseFinalizeApplication)
        : send(token, path, request, parseFinalizeTemplate);
    },
    async abort(token, kind, operationId) {
      await send(
        token,
        `/internal/templates/${kind}/${operationId}`,
        { method: 'DELETE' },
        parseNoContent,
      );
    },
    finalizeManaged: (token, workspaceId, imports, activeStableKeys) =>
      send(
        token,
        `/internal/workspaces/${workspaceId}/templates/managed/finalize`,
        { method: 'POST', body: JSON.stringify({ imports, activeStableKeys }) },
        parseManagedFinalize,
      ),
    sweepExpired: (token, workspaceId) =>
      send(
        token,
        `/internal/workspaces/${workspaceId}/template-stages/expired/sweep`,
        { method: 'POST', body: '{}' },
        parseStageSweep,
      ),
    authorizeImport: (token, workspaceId) =>
      send(
        token,
        `/internal/workspaces/${workspaceId}/templates/import-authorization`,
        { method: 'GET' },
        parseImportAuthorization,
      ),
    beginDraft: (token, templateId, idempotencyKey) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts`,
        { method: 'POST', body: JSON.stringify({ idempotencyKey }) },
        parseTemplateDraft,
      ),
    getDraft: (token, templateId, operationId) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}`,
        { method: 'GET' },
        parseTemplateDraft,
      ),
    patchDraft: (token, templateId, operationId, body) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}`,
        { method: 'PATCH', body: JSON.stringify(body) },
        parseTemplateDraft,
      ),
    patchDraftItem: (token, templateId, operationId, sourceId, body) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}/items/${sourceId}`,
        { method: 'PATCH', body: JSON.stringify(body) },
        parseTemplateDraftItem,
      ),
    saveDraft: (token, templateId, operationId) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}/save`,
        { method: 'POST' },
        parseFinalizeTemplate,
      ),
    async discardDraft(token, templateId, operationId) {
      await send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}`,
        { method: 'DELETE' },
        parseNoContent,
      );
    },
    authorizeDraftItem: (token, templateId, operationId, sourceId) =>
      send(
        token,
        `/internal/templates/${templateId}/drafts/${operationId}/items/${sourceId}/authorization`,
        { method: 'GET' },
        parseTemplateItemAuthorization,
      ),
    authorizeTemplateItem: (token, templateId, sourceId) =>
      send(
        token,
        `/internal/templates/${templateId}/items/${sourceId}/authorization`,
        { method: 'GET' },
        parseTemplateItemAuthorization,
      ),
    getTemplateExport: (token, templateId) =>
      send(
        token,
        `/internal/templates/${templateId}/export`,
        { method: 'GET' },
        parseTemplateExport,
      ),
  };
}

function parseCaptureBegin(value: unknown): CaptureBegin {
  const body = requiredRecord(value);
  return {
    operationId: requiredUuid(body.operationId),
    templateId: requiredUuid(body.templateId),
    itemMappings: requiredArray(body.itemMappings, parseItemMapping),
    bodyCopies: requiredArray(body.bodyCopies, parseBodyCopy),
  };
}

function parseImportBegin(value: unknown): ImportBegin {
  const body = requiredRecord(value);
  return {
    operationId: nullableUuid(body.operationId),
    templateId: requiredUuid(body.templateId),
    unchanged: requiredBoolean(body.unchanged),
    itemMappings: requiredArray(body.itemMappings, parseItemMapping),
    bodyWrites: requiredArray(body.bodyWrites, parseBodyWrite),
  };
}

function parseApplicationBegin(value: unknown): ApplicationBegin {
  const body = requiredRecord(value);
  return {
    applicationId: requiredUuid(body.applicationId),
    templateId: requiredUuid(body.templateId),
    targetItemId: requiredUuid(body.targetItemId),
    alreadyApplied: requiredBoolean(body.alreadyApplied),
    createdItems: requiredArray(body.createdItems, parseItemMapping),
    itemMappings: requiredArray(body.itemMappings, parseItemMapping),
    bodyCopies: requiredArray(body.bodyCopies, parseBodyCopy),
  };
}

function parseOperationAuthorization(value: unknown): OperationAuthorization {
  const body = requiredRecord(value);
  return {
    tenantId: requiredUuid(body.tenantId),
    principalId: requiredUuid(body.principalId),
    workspaceId: requiredUuid(body.workspaceId),
    itemType: requiredText(body.itemType),
    canWrite: requiredBoolean(body.canWrite),
  };
}

function parseTemplateItemAuthorization(value: unknown): TemplateItemAuthorization {
  const body = requiredRecord(value);
  return {
    templateId: requiredUuid(body.templateId),
    sourceId: requiredUuid(body.sourceId),
    itemId: requiredUuid(body.itemId),
    tenantId: requiredUuid(body.tenantId),
    principalId: requiredUuid(body.principalId),
    workspaceId: requiredUuid(body.workspaceId),
    itemType: requiredText(body.itemType),
    canRead: requiredBoolean(body.canRead),
    canWrite: requiredBoolean(body.canWrite),
  };
}

function parseFinalizeTemplate(value: unknown): FinalizeTemplateResult {
  return { templateId: requiredUuid(requiredRecord(value).templateId) };
}

function parseFinalizeApplication(value: unknown): FinalizeApplicationResult {
  return { targetItemId: requiredUuid(requiredRecord(value).targetItemId) };
}

function parseManagedFinalize(value: unknown): ManagedFinalizeResult {
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

function parseTemplateDraft(value: unknown): TemplateDraft {
  const body = requiredRecord(value);
  return {
    operationId: requiredUuid(body.operationId),
    templateId: requiredUuid(body.templateId),
    title: requiredText(body.title, true),
    description: nullableText(body.description),
    expiresAt: requiredDate(body.expiresAt),
    root: parseTemplateDraftItem(body.root),
    itemMappings: requiredArray(body.itemMappings, parseItemMapping),
    bodyCopies: requiredArray(body.bodyCopies, parseBodyCopy),
  };
}

function parseTemplateDraftItem(value: unknown): TemplateDraftItem {
  const body = requiredRecord(value);
  const sourceId = requiredUuid(body.sourceId);
  if (body.views === undefined) throw new Error('views');
  return {
    sourceId,
    itemType: requiredText(body.itemType),
    title: requiredText(body.title, true),
    seq: requiredIntegerText(body.seq),
    properties: nullableRecord(body.properties),
    schema: body.schema === null ? null : parseTemplatePropertySchemaResponse(body.schema),
    views: parseStoredViewsObject(body.views, sourceId),
    hasBody: requiredBoolean(body.hasBody),
    children: requiredArray(body.children, parseTemplateDraftItem),
  };
}

function parseTemplatePropertySchemaResponse(value: unknown): TemplatePropertySchemaResponse {
  const body = requiredRecord(value);
  return {
    properties: requiredArray(body.properties, parseProperty),
    declared: requiredArray(body.declared, parseProperty),
    inherit: requiredBoolean(body.inherit),
  };
}

function parseTemplateExport(value: unknown): TemplateExportSnapshot {
  const body = requiredRecord(value);
  const origin = body.origin;
  if (origin !== 'user' && origin !== 'seed' && origin !== 'managed') throw new Error('origin');
  return {
    templateId: requiredUuid(body.templateId),
    workspaceId: requiredUuid(body.workspaceId),
    stableKey: requiredText(body.stableKey),
    title: requiredText(body.title, true),
    description: nullableText(body.description),
    origin,
    revision: requiredInteger(body.revision),
    includeBody: requiredBoolean(body.includeBody),
    includeChildren: requiredBoolean(body.includeChildren),
    items: requiredArray(body.items, parseTemplateExportItem),
  };
}

function parseTemplateExportItem(value: unknown): TemplateExportItem {
  const body = requiredRecord(value);
  const sourceId = requiredUuid(body.sourceId);
  if (body.views === undefined) throw new Error('views');
  return {
    sourceId,
    parentSourceId: nullableUuid(body.parentSourceId),
    itemId: requiredUuid(body.itemId),
    itemType: requiredText(body.itemType),
    title: requiredText(body.title, true),
    seq: requiredIntegerText(body.seq),
    properties: requiredRecord(body.properties),
    schema: body.schema === null ? null : parseTemplateExportSchema(body.schema),
    views: parseStoredViewsObject(body.views, sourceId),
    hasBody: requiredBoolean(body.hasBody),
  };
}

function parseTemplateExportSchema(value: unknown): TemplateExportSchema {
  const body = requiredRecord(value);
  return {
    properties: requiredArray(body.properties, parseProperty),
    inherit: requiredBoolean(body.inherit),
    ...(body.declared === undefined
      ? {}
      : { declared: requiredArray(body.declared, parseProperty) }),
  };
}

function parseProperty(value: unknown): PropertyDefinition {
  const body = requiredRecord(value);
  return {
    key: requiredText(body.key),
    label: requiredText(body.label, true),
    type: requiredText(body.type),
    options: requiredArray(body.options, (option) => requiredText(option, true)),
    required: requiredBoolean(body.required),
  };
}

function parseItemMapping(value: unknown): ItemMapping {
  const body = requiredRecord(value);
  return {
    sourceId: requiredUuid(body.sourceId),
    itemId: requiredUuid(body.itemId),
    itemType: requiredText(body.itemType),
  };
}

function parseBodyCopy(value: unknown): {
  sourceItemId: string;
  targetItemId: string;
  itemType: string;
} {
  const body = requiredRecord(value);
  return {
    sourceItemId: requiredUuid(body.sourceItemId),
    targetItemId: requiredUuid(body.targetItemId),
    itemType: requiredText(body.itemType),
  };
}

function parseBodyWrite(value: unknown): {
  sourceId: string;
  targetItemId: string;
  itemType: string;
} {
  const body = requiredRecord(value);
  return {
    sourceId: requiredUuid(body.sourceId),
    targetItemId: requiredUuid(body.targetItemId),
    itemType: requiredText(body.itemType),
  };
}

function parseNoContent(): undefined {
  return undefined;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('object');
  return value as Record<string, unknown>;
}

function nullableRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value === null ? null : requiredRecord(value);
}

function requiredText(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) throw new Error('text');
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return requiredText(value, true);
}

function requiredUuid(value: unknown): string {
  const candidate = requiredText(value);
  if (!UUID.test(candidate)) throw new Error('uuid');
  return candidate;
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : requiredUuid(value);
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

function requiredIntegerText(value: unknown): string {
  const candidate = requiredText(value);
  if (!/^-?\d+$/.test(candidate)) throw new Error('integer text');
  return candidate;
}

function requiredDate(value: unknown): string {
  const candidate = requiredText(value);
  if (Number.isNaN(Date.parse(candidate))) throw new Error('date');
  return candidate;
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
