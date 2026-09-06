import { vi } from 'vitest';
import { item, STUB_WORKSPACE_ID } from './resources/items';
import type { StubItem } from './resources/items';

/**
 * A stand-in for Core, for tests about what the application renders.
 *
 * The shell asks Core two things on every mount - who the caller is, and what is in the workspace -
 * so without this every suite would be a suite about failed requests. Stubbing at `fetch` rather
 * than at the hook keeps the hooks under test: the request they build, the parse they do and the
 * states they move through are all still exercised.
 *
 * Each test that cares states what it wants back. The default is the boring case: a signed-in
 * ordinary member with an empty workspace.
 */

/**
 * The id a created item is given.
 *
 * Uuid-shaped, because every route in this stub matches `[0-9a-f-]{36}` and a readable id like
 * `created-1` is not hex - a freshly created item would be unreadable by id, which is exactly the
 * path a create test walks next.
 */
function createdId(sequence: number): string {
  return `cccccccc-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** The workspace every stub item belongs to, matching what the app reads from its environment. */
export interface StubWorkspace {
  readonly id: string;
  readonly name: string;
  readonly versionRetentionDays: number;
  readonly storageQuotaBytes: string;
  readonly createdAt: string;
  readonly kind: 'personal' | 'shared';
  readonly canRename: boolean;
  readonly canManageMembers: boolean;
  readonly canLeave: boolean;
  readonly canUseDailyNotes: boolean;
  readonly pendingInvitationId: string | null;
  readonly lifecycleState: 'active' | 'archived' | 'purging';
  readonly archivedAt: string | null;
}

export const STUB_WORKSPACE: StubWorkspace = {
  id: STUB_WORKSPACE_ID,
  name: "Test Person's workspace",
  versionRetentionDays: 90,
  storageQuotaBytes: '10737418240',
  createdAt: '2026-08-30T09:00:00.000Z',
  kind: 'personal',
  canRename: true,
  canManageMembers: true,
  canLeave: false,
  canUseDailyNotes: true,
  pendingInvitationId: null,
  lifecycleState: 'active',
  archivedAt: null,
};

/** A container's views, keyed by the item that offers them. */
export type StubViews = Readonly<Record<string, { views: readonly unknown[]; default: string }>>;
export type StubSchemas = Readonly<
  Record<
    string,
    {
      properties: readonly unknown[];
      declared: readonly unknown[];
      inherit: boolean;
    }
  >
>;

export interface StubTemplate {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly origin: 'seed' | 'user' | 'managed';
  readonly revision: number;
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  readonly fieldCount: number;
  readonly viewCount: number;
  readonly childCount: number;
  readonly viewKinds: readonly string[];
  readonly capabilities: {
    readonly canEdit: boolean;
    readonly canDelete: boolean;
    readonly canExport: boolean;
    readonly canApply: boolean;
  };
  readonly updatedAt: string;
  readonly root?: Readonly<Record<string, unknown>>;
}

const TEMPLATE_WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
export const STUB_TEMPLATE_IMPORT_ID = 'a9000000-0000-4000-8000-000000000001';
const STUB_TEMPLATE_PREVIEW_OPERATION_ID = 'a9000000-0000-4000-8000-000000000002';
const STUB_TEMPLATE_COMMIT_OPERATION_ID = 'a9000000-0000-4000-8000-000000000003';
const STUB_TEMPLATE_IMPORT_DIGEST = 'a'.repeat(64);

function seedTemplate(id: string, title: string, kind: string, fieldCount: number): StubTemplate {
  return {
    id,
    workspaceId: TEMPLATE_WORKSPACE_ID,
    title,
    description: `A ready-to-use ${title.toLocaleLowerCase()} structure.`,
    origin: 'seed',
    revision: 1,
    includeBody: false,
    includeChildren: false,
    fieldCount,
    viewCount: 1,
    childCount: 0,
    viewKinds: [kind],
    capabilities: { canEdit: false, canDelete: false, canExport: true, canApply: true },
    updatedAt: '2026-08-16T09:00:00.000Z',
  };
}

export const STUB_TEMPLATES: readonly StubTemplate[] = [
  seedTemplate('a1111111-1111-4111-8111-111111111111', 'Kanban', 'board', 2),
  seedTemplate('a2222222-2222-4222-8222-222222222222', 'Calendar', 'calendar', 2),
  seedTemplate('a3333333-3333-4333-8333-333333333333', 'List', 'list', 1),
];

export interface StubOptions {
  readonly workspaces?: readonly StubWorkspace[];
  readonly workspacesFail?: boolean;
  readonly workspacesPartial?: boolean;
  readonly isTenantAdministrator?: boolean;
  readonly displayName?: string;
  readonly email?: string | null;
  readonly items?: readonly StubItem[];
  /** Makes the profile request fail, for tests about what the menu does then. */
  readonly profileFails?: boolean;

  /** The caller's personal access tokens, newest first, dead ones included - it is an audit. */
  readonly accessTokens?: readonly StubAccessToken[];

  /** Makes the token list read fail. */
  readonly tokensFail?: boolean;

  /**
   * Makes every token mint fail with this problem, for tests about the two refusals the endpoint
   * can give: 422 `tokens.invalid` and 409 `tokens.limit_reached`.
   */
  readonly createTokenProblem?: {
    readonly status: number;
    readonly code: string;
    readonly detail: string;
  };

  /** Who holds a role in the workspace, as the members read reports them. */
  readonly members?: readonly StubMember[];
  readonly invitations?: readonly StubInvitation[];
  readonly invitees?: readonly StubInvitee[];

  /** Makes the members read fail. */
  readonly membersFail?: boolean;
  /** Makes the invitations read fail independently of the members read. */
  readonly invitationsFail?: boolean;
  /** Makes member role/removal mutations fail while leaving both lists readable. */
  readonly memberMutationFails?: boolean;
  /** Makes leaving a workspace fail while preserving membership. */
  readonly leaveFails?: boolean;
  /** Makes the tree request fail. */
  readonly treeFails?: boolean;

  /** Makes every search fail, for tests about what the palette says then. */
  readonly searchFails?: boolean;

  /** Makes every backlinks read fail. */
  readonly backlinksFail?: boolean;

  /**
   * Makes the workspace graph read fail with `404 workspaces.not_found` - the refusal Core gives
   * for a workspace the caller may not see.
   */
  readonly graphFails?: boolean;

  /**
   * Makes the graph route answer a bodyless 404, the way a server running a build older than the
   * endpoint does. Distinct from `graphFails` on purpose: the two are the same status and mean
   * completely different things, and telling them apart is the view's job.
   */
  readonly graphRouteMissing?: boolean;

  /**
   * The reference edges the graph read reports, stated rather than derived: this stub knows
   * nothing about document contents, and the real edges are extracted from them by the
   * collaboration service. Same reasoning as `backlinks` above.
   */
  readonly graphLinks?: readonly { readonly sourceId: string; readonly targetId: string }[];

  /**
   * Makes the graph read claim it hit a ceiling, so a test can assert the view says so. The
   * payload is not actually truncated - what is under test is whether the flag reaches the reader,
   * not whether the server can count.
   */
  readonly graphTruncated?: { readonly nodes?: boolean; readonly links?: boolean };

  /**
   * The dated entries the collated calendar read reports.
   *
   * Stated rather than derived from `items`, for the reason `backlinks` and `graphLinks` are: this
   * stub knows nothing about container views or schemas, and which property carries an item's date
   * is resolved server-side from the container's stored views.
   */
  readonly calendarEntries?: readonly {
    readonly itemId: string;
    readonly title: string | null;
    readonly containerId: string;
    readonly containerTitle: string | null;
    readonly dateProperty: string;
    readonly value: string;
    readonly kind: 'date' | 'timestamp';

    /** Whether a recurrence rule produced this one; omitted means a stored entry. */
    readonly generated?: boolean;

    /** An occurrence's completion state; null for a stored entry, which cannot be "done". */
    readonly completed?: boolean | null;
  }[];

  /** Containers the calendar read reports as offering a calendar it could place nothing on. */
  readonly calendarUnplaceable?: readonly {
    readonly containerId: string;
    readonly containerTitle: string | null;
    readonly reason: string;

    /** Set for an item-level reason: a repeating item this calendar could not draw. */
    readonly itemId?: string | null;

    /** That item's title, when it has one. */
    readonly itemTitle?: string | null;
  }[];

  /** What the caller has kept, as the shelf read reports it. */
  readonly bookmarks?: readonly {
    readonly itemId: string;
    readonly title: string | null;
    readonly type: string;
    readonly workspaceId: string;
    readonly keptAt: string;
  }[];

  /** How many kept items the shelf read says it cannot show. */
  readonly bookmarksHidden?: number;

  /** Makes the shelf read fail. */
  readonly bookmarksFail?: boolean;

  /** Makes the calendar read fail with the refusal Core gives for an invisible workspace. */
  readonly calendarFails?: boolean;

  /** Makes the calendar read claim it hit its entry ceiling. */
  readonly calendarTruncated?: boolean;

  /**
   * Which items link to which, keyed by the target.
   *
   * Stated rather than derived from document contents: this stub knows nothing about documents,
   * and the edges are extracted from them by the collaboration service in the real system.
   */
  readonly backlinks?: Readonly<Record<string, readonly string[]>>;

  /** Makes every create fail, with this as the problem detail. */
  readonly createRefusal?: string;

  /** Makes every delete fail, rather than the ordinary always-succeeds stub behavior. */
  readonly removeFails?: boolean;

  /** Makes every restore fail, rather than the ordinary always-succeeds stub behavior. */
  readonly restoreFails?: boolean;

  /**
   * Views per item. Anything not listed offers none, which is what an item nobody has configured
   * reports and therefore what most tests want.
   */
  readonly views?: StubViews;
  /** Effective and declared property schemas per item. */
  readonly schemas?: StubSchemas;
  /** Workspace templates. The defaults are the three installed starter templates. */
  readonly templates?: readonly StubTemplate[];
  /** Makes the template library request fail. */
  readonly templatesFail?: boolean;
  /** Holds the template catalog response until a test releases it. */
  readonly templateCatalogGate?: Promise<void>;
  /** Makes the import commit report that its bytes no longer match the validated preview. */
  readonly templateFileChanged?: boolean;
  /** Replays an existing durable import whose preview operation is still queued. */
  readonly templateImportReplayPreviewQueued?: boolean;
  /** Refuses the first preview request after the durable import and upload are accepted. */
  readonly templateImportPreviewFailsOnce?: boolean;
  /** Refuses the first commit request while leaving the durable preview retryable. */
  readonly templateImportCommitFailsOnce?: boolean;
  /** Refuses the first cancellation request while leaving the durable import unchanged. */
  readonly templateImportCancelFailsOnce?: boolean;
  /** Makes template export refuse the archive used by the duplicate flow. */
  readonly templateDuplicateFails?: boolean;
  /** Makes duplicate import fail after Core has accepted the durable import identity. */
  readonly templateDuplicateCommitFails?: boolean;
  /** Drops the first duplicate commit response after Core has completed the durable import. */
  readonly templateDuplicateResponseLostOnce?: boolean;
  /** Makes a recovered staged-edit draft report that it has expired or been replaced. */
  readonly templateDraftUnavailable?: boolean;
  /** Makes beginning a staged edit report that another draft is still active. */
  readonly templateDraftConflict?: boolean;
  /** Whether the caller may create, capture, import, apply, or manage workspace templates. */
  readonly canManageTemplates?: boolean;
  /** Whether template preflight permits the requested create or merge. */
  readonly templatePreflightCanApply?: boolean;
  /** Conflict explanations returned by template preflight. */
  readonly templatePreflightConflicts?: readonly string[];
}

/** A personal access token as `GET /api/v1/me/tokens` reports one - metadata, never the secret. */
export interface StubAccessToken {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
}

/** A role grant as `GET /api/v1/workspaces/{id}/members` reports one. */
export interface StubMember {
  readonly subjectType: 'principal';
  readonly subjectId: string;
  readonly subjectDisplayName: string;
  readonly email?: string | null;
  readonly role: string;
  readonly grantedAt: string;
  readonly canChangeRole?: boolean;
  readonly canRemove?: boolean;
  readonly assignableRoles?: readonly ('owner' | 'editor' | 'viewer')[];
}

export interface StubInvitation {
  readonly id: string;
  readonly emailNormalized: string;
  readonly targetPrincipalId: string | null;
  readonly role: 'owner' | 'editor' | 'viewer';
  readonly status: 'pending' | 'accepted' | 'revoked';
  readonly invitedByPrincipalId: string;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly acceptedByPrincipalId: string | null;
  readonly revokedAt: string | null;
}

export interface StubInvitee {
  readonly principalId: string;
  readonly displayName: string;
  readonly email: string;
}

const DEFAULT_INVITEE: StubInvitee = {
  principalId: '77777777-bbbb-4bbb-8bbb-777777777777',
  displayName: 'New Person',
  email: 'new.person@example.com',
};

/** The id a minted stub token is given. Uuid-shaped, for the reason `createdId` gives. */
function mintedTokenId(sequence: number): string {
  return `dddddddd-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

/** Installs the stub. `vi.unstubAllGlobals` in the global teardown removes it. */
/** What a test can read back about what the application wrote. */
export interface StubWrites {
  /** Every property PATCH, in the order it was sent. */
  readonly properties: readonly { itemId: string; properties: Record<string, unknown> }[];
  /** Every atomic structured-item request, in the order it was sent. */
  readonly structuredItems: readonly Record<string, unknown>[];
  /** Every template-item PATCH, in the order it was sent. */
  readonly templateItems: readonly {
    templateId: string;
    sourceId: string;
    body: Record<string, unknown>;
  }[];
  /** Expected digests sent with durable template import commits. */
  readonly templateImports: readonly string[];
  /** Attempt identities sent when durable template imports begin. */
  readonly templateImportIdempotencyKeys: readonly string[];
  /** Durable import identities and states returned for each begin request. */
  readonly templateImportBegins: readonly {
    importId: string;
    status: string;
    hasUploadCapability: boolean;
  }[];
  /** Durable template import identities explicitly cancelled by the client. */
  readonly templateImportCancellations: readonly string[];
  /** Durable template import identities committed by the client. */
  readonly templateImportCommitIds: readonly string[];
  /** Durable template import identities read by the client. */
  readonly templateImportReads: readonly string[];
  /** Template IDs exported for duplication, in request order. */
  readonly templateExports: readonly string[];
  /** Exact archive objects uploaded through a template import capability. */
  readonly templateUploadBodies: readonly Blob[];
  /** Every template preflight request, in the order it was sent. */
  readonly templatePreflights: readonly Record<string, unknown>[];
  /** Every template application request, in the order it was sent. */
  readonly templateApplications: readonly Record<string, unknown>[];
}

export function stubCoreApi(options: StubOptions = {}): StubWrites {
  const {
    workspaces = [STUB_WORKSPACE],
    workspacesFail = false,
    workspacesPartial = false,
    isTenantAdministrator = false,
    displayName = 'Test Person',
    email = 'test@example.test',
    items = [],
    profileFails = false,
    accessTokens = [],
    tokensFail = false,
    createTokenProblem,
    members = [],
    invitations = [],
    invitees = [DEFAULT_INVITEE],
    membersFail = false,
    invitationsFail = false,
    memberMutationFails = false,
    leaveFails = false,
    treeFails = false,
    searchFails = false,
    backlinksFail = false,
    backlinks = {},
    graphFails = false,
    graphRouteMissing = false,
    graphLinks = [],
    graphTruncated = {},
    calendarEntries = [],
    calendarUnplaceable = [],
    bookmarks = [],
    bookmarksHidden = 0,
    bookmarksFail = false,
    calendarFails = false,
    calendarTruncated = false,
    views = {},
    schemas = {},
    createRefusal,
    removeFails = false,
    restoreFails = false,
    templates = STUB_TEMPLATES,
    templatesFail = false,
    templateCatalogGate,
    templateFileChanged = false,
    templateImportReplayPreviewQueued = false,
    templateImportPreviewFailsOnce = false,
    templateImportCommitFailsOnce = false,
    templateImportCancelFailsOnce = false,
    templateDuplicateFails = false,
    templateDuplicateCommitFails = false,
    templateDuplicateResponseLostOnce = false,
    templateDraftUnavailable = false,
    templateDraftConflict = false,
    canManageTemplates = true,
    templatePreflightCanApply = true,
    templatePreflightConflicts = [],
  } = options;

  // The items the stub knows about. Mutable, because a create has to be visible to the reads that
  // follow it - a stub whose POST returns an item that the next GET has never heard of tests the
  // opposite of what a creation test means to.
  const known = [...items];
  let knownWorkspaces = [...workspaces];
  let heldMembers = members.map((member) => ({
    ...member,
    email: member.email ?? null,
    canChangeRole: member.canChangeRole ?? true,
    canRemove: member.canRemove ?? true,
    assignableRoles: member.assignableRoles ?? ['owner', 'editor', 'viewer'],
  }));
  let heldInvitations = [...invitations];
  let heldInvitees = [...invitees];
  let knownTemplates = [...templates];
  let exportedTemplate: StubTemplate | null = null;
  const templateDrafts = new Map<
    string,
    {
      templateId: string;
      title: string;
      description: string | null;
      root: Readonly<Record<string, unknown>>;
    }
  >();

  // The shelf the stub holds. Mutable, because keeping something has to be visible to the read that
  // follows it - a stub whose PUT is forgotten by the next GET tests the opposite of what a
  // bookmarking test means to.
  let kept = [...bookmarks];

  // The tokens the stub holds, newest first as the endpoint promises. Mutable for the reason
  // `known` is: a mint has to be visible to the list read that follows it, and a revocation has to
  // flip the row's `revokedAt` rather than remove it - the real endpoint keeps dead tokens because
  // the list is an audit, and a stub that dropped them would let the interface hide them unnoticed.
  let heldTokens = [...accessTokens];

  // Every property PATCH the application made, in order, for tests about what a write actually
  // sent rather than about what the view drew afterwards.
  const propertyWrites: { itemId: string; properties: Record<string, unknown> }[] = [];
  const structuredItemWrites: Record<string, unknown>[] = [];
  const templateItemWrites: {
    templateId: string;
    sourceId: string;
    body: Record<string, unknown>;
  }[] = [];
  const templateImportWrites: string[] = [];
  const templateImportIdempotencyKeys: string[] = [];
  const templateImportBegins: {
    importId: string;
    status: string;
    hasUploadCapability: boolean;
  }[] = [];
  const templateImportCancellations: string[] = [];
  const templateImportCommitIds: string[] = [];
  const templateImportReads: string[] = [];
  const templateExportWrites: string[] = [];
  const templateUploadBodies: Blob[] = [];
  const templatePreflightWrites: Record<string, unknown>[] = [];
  const templateApplicationWrites: Record<string, unknown>[] = [];
  let durableTemplateImportSequence = 0;
  let durableTemplateImportId = STUB_TEMPLATE_IMPORT_ID;
  let durableTemplateIdempotencyKey: string | null = null;
  let durableTemplateWorkspaceId = STUB_WORKSPACE_ID;
  let durableTemplateImportStatus = 'pending_upload';
  let durableTemplatePreview: Readonly<Record<string, unknown>> | null = null;
  let durableTemplateResult: Readonly<Record<string, unknown>> | null = null;
  let refuseNextTemplatePreview = templateImportPreviewFailsOnce;
  let refuseNextTemplateCommit = templateImportCommitFailsOnce;
  let refuseNextTemplateCancellation = templateImportCancelFailsOnce;

  function nextTemplateImportId(): string {
    durableTemplateImportSequence += 1;
    return `a9000000-0000-4000-8000-${String(durableTemplateImportSequence).padStart(12, '0')}`;
  }

  /** The four fields every item listing projects, as Core returns them. */
  function digest(item: StubItem): {
    id: string;
    workspaceId: string;
    type: string;
    title: string | null;
  } {
    return {
      id: item.id,
      workspaceId: item.workspaceId,
      type: item.type,
      title: item.title.length === 0 ? null : item.title,
    };
  }

  function normalizeProperties(properties: readonly unknown[]): readonly unknown[] {
    return properties.map((property) =>
      typeof property === 'object' && property !== null
        ? {
            ...property,
            options:
              'options' in property && Array.isArray(property.options) ? property.options : [],
          }
        : property,
    );
  }

  function importedTemplate(): StubTemplate {
    const imported: StubTemplate = {
      ...(exportedTemplate ?? {
        id: 'a7777777-7777-4777-8777-777777777777',
        workspaceId: TEMPLATE_WORKSPACE_ID,
        title: 'Imported template',
        description: 'Validated from disk.',
        origin: 'user',
        revision: 1,
        includeBody: true,
        includeChildren: true,
        fieldCount: 0,
        viewCount: 0,
        childCount: 0,
        viewKinds: [],
        capabilities: {
          canEdit: true,
          canDelete: true,
          canExport: true,
          canApply: true,
        },
        updatedAt: '2026-08-16T09:00:00.000Z',
      }),
      id: 'a7777777-7777-4777-8777-777777777777',
      title: exportedTemplate === null ? 'Imported template' : exportedTemplate.title,
      origin: 'user',
      revision: 1,
      capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
      updatedAt: '2026-08-16T10:00:00.000Z',
    };
    knownTemplates = [
      ...knownTemplates.filter((template) => template.id !== imported.id),
      imported,
    ];
    exportedTemplate = null;
    return imported;
  }

  function templateImportPreview(): Readonly<Record<string, unknown>> {
    return {
      profile: {
        kind: 'template',
        version: 1,
        key: 'imported-template',
        name: 'Imported template',
        description: 'Validated from disk.',
        includeBody: true,
        includeChildren: true,
      },
      digest: STUB_TEMPLATE_IMPORT_DIGEST,
      rootItemType: 'note',
      itemCount: 3,
      bodyCount: 3,
      viewCount: 1,
    };
  }

  function completedTemplateOperation(id: string, kind: string): Readonly<Record<string, unknown>> {
    return {
      id,
      kind,
      status: 'completed',
      result: null,
      errorCode: null,
      errorDetail: null,
      attempts: 1,
      cancellationRequested: false,
      createdAt: '2026-09-01T10:00:00.000Z',
      completedAt: '2026-09-01T10:00:01.000Z',
    };
  }

  function durableTemplateImport(): Readonly<Record<string, unknown>> {
    return {
      id: durableTemplateImportId,
      workspaceId: durableTemplateWorkspaceId,
      status: durableTemplateImportStatus,
      previewOperationId:
        durableTemplatePreview === null && durableTemplateImportStatus !== 'preview_queued'
          ? null
          : STUB_TEMPLATE_PREVIEW_OPERATION_ID,
      commitOperationId: durableTemplateResult === null ? null : STUB_TEMPLATE_COMMIT_OPERATION_ID,
      preview: durableTemplatePreview,
      result: durableTemplateResult,
      failureCode: null,
      expiresAt: '2026-09-01T12:00:00.000Z',
      completedAt: durableTemplateImportStatus === 'completed' ? '2026-09-01T10:00:02.000Z' : null,
    };
  }

  // What has been written back. Seeded from the options so a test can start with an item already
  // configured, and updated by every PUT so the read that follows one agrees with it.
  const stored: {
    views: Record<string, { views: readonly unknown[]; default: string }>;
    schema: Record<
      string,
      { properties: readonly unknown[]; declared: readonly unknown[]; inherit: boolean }
    >;
  } = { views: { ...views }, schema: { ...schemas } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const requestHeaders = new Headers(init?.headers ?? request?.headers);
      const requestBody =
        init?.body ??
        (request === null || method === 'GET' || method === 'HEAD'
          ? undefined
          : requestHeaders.get('content-type')?.includes('application/json') === true
            ? await request.clone().text()
            : await request.clone().blob());
      const parsedUrl = new URL(url, globalThis.location.origin);

      if (parsedUrl.pathname === '/auth/token' && method === 'POST') {
        return Promise.resolve(
          json({
            accessToken: 'core-session-token',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }),
        );
      }

      if (parsedUrl.pathname === '/api/v1/exports/formats' && method === 'GET') {
        return Promise.resolve(
          json({
            formats: [
              {
                format: 'nix',
                label: 'Archive',
                extension: 'nix',
                mediaType: 'application/vnd.nix.archive+zip',
                lossless: true,
                declaredLoss: [],
              },
              {
                format: 'markdown',
                label: 'Markdown',
                extension: 'md',
                mediaType: 'text/markdown; charset=utf-8',
                lossless: false,
                declaredLoss: ['Views and interactive metadata are represented as text.'],
              },
              {
                format: 'docx',
                label: 'Word',
                extension: 'docx',
                mediaType:
                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                lossless: false,
                declaredLoss: ['Interactive workspace behavior is flattened into a document.'],
              },
              {
                format: 'pdf',
                label: 'PDF',
                extension: 'pdf',
                mediaType: 'application/pdf',
                lossless: false,
                declaredLoss: [
                  'Interactive workspace behavior is flattened into fixed pages.',
                  'Characters outside printable ASCII are replaced by the built-in PDF font.',
                ],
              },
            ],
            observedAt: '2026-09-01T09:00:00+00:00',
          }),
        );
      }

      if (parsedUrl.pathname === '/api/v1/workspaces' && method === 'GET') {
        if (workspacesPartial) {
          return Promise.resolve(
            parsedUrl.searchParams.has('cursor')
              ? json({ detail: 'The remaining workspaces could not be loaded.' }, 500)
              : json({ items: knownWorkspaces.slice(0, 1), nextCursor: 'next-page' }),
          );
        }
        return Promise.resolve(
          workspacesFail
            ? json({ code: 'workspaces.unavailable' }, 500)
            : json({ items: knownWorkspaces, nextCursor: null }),
        );
      }

      if (parsedUrl.pathname === '/api/v1/workspaces' && method === 'POST') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          name?: string;
        };
        const created: StubWorkspace = {
          ...STUB_WORKSPACE,
          id: `eeeeeeee-0000-4000-8000-${String(knownWorkspaces.length + 1).padStart(12, '0')}`,
          name: body.name ?? 'Untitled workspace',
          kind: 'shared',
          canLeave: false,
          canUseDailyNotes: false,
        };
        knownWorkspaces.push(created);
        return Promise.resolve(json(created, 201));
      }

      const workspaceDetail = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})$/.exec(parsedUrl.pathname);
      if (workspaceDetail !== null && method === 'GET') {
        const workspace = knownWorkspaces.find((entry) => entry.id === workspaceDetail[1]);
        return Promise.resolve(
          workspace === undefined ? json({ code: 'workspaces.not_found' }, 404) : json(workspace),
        );
      }
      if (workspaceDetail !== null && method === 'PATCH') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          name?: string;
        };
        const workspace = knownWorkspaces.find((entry) => entry.id === workspaceDetail[1]);
        if (workspace === undefined) {
          return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        }
        const renamed = { ...workspace, name: body.name ?? workspace.name };
        knownWorkspaces = knownWorkspaces.map((entry) =>
          entry.id === renamed.id ? renamed : entry,
        );
        return Promise.resolve(json(renamed));
      }
      if (workspaceDetail !== null && method === 'DELETE') {
        const workspace = knownWorkspaces.find((entry) => entry.id === workspaceDetail[1]);
        if (workspace?.lifecycleState !== 'archived') {
          return Promise.resolve(json({ code: 'workspaces.purge_refused' }, 409));
        }
        knownWorkspaces = knownWorkspaces.map((entry) =>
          entry.id === workspace.id ? { ...entry, lifecycleState: 'purging' as const } : entry,
        );
        return Promise.resolve(new Response(null, { status: 202 }));
      }
      const archiveWorkspace = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/archive$/.exec(
        parsedUrl.pathname,
      );
      if (archiveWorkspace !== null && method === 'POST') {
        const workspace = knownWorkspaces.find((entry) => entry.id === archiveWorkspace[1]);
        if (workspace === undefined) return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        const archived = {
          ...workspace,
          lifecycleState: 'archived' as const,
          archivedAt: '2026-09-06T12:00:00.000Z',
        };
        knownWorkspaces = knownWorkspaces.map((entry) =>
          entry.id === archived.id ? archived : entry,
        );
        return Promise.resolve(json(archived));
      }
      const restoreWorkspace = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/restore$/.exec(
        parsedUrl.pathname,
      );
      if (restoreWorkspace !== null && method === 'POST') {
        const workspace = knownWorkspaces.find((entry) => entry.id === restoreWorkspace[1]);
        if (workspace === undefined) return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        const restored = { ...workspace, lifecycleState: 'active' as const, archivedAt: null };
        knownWorkspaces = knownWorkspaces.map((entry) =>
          entry.id === restored.id ? restored : entry,
        );
        return Promise.resolve(json(restored));
      }

      const leaveWorkspace = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/leave$/.exec(
        parsedUrl.pathname,
      );
      if (leaveWorkspace !== null && method === 'POST') {
        if (leaveFails) {
          return Promise.resolve(json({ detail: 'The workspace could not be left.' }, 409));
        }
        knownWorkspaces = knownWorkspaces.filter((entry) => entry.id !== leaveWorkspace[1]);
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      const invitationList = /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/invitations$/.exec(
        parsedUrl.pathname,
      );
      if (invitationList !== null && method === 'GET') {
        return Promise.resolve(
          invitationsFail
            ? json({ detail: 'Workspace invitations could not be loaded.' }, 500)
            : json({ items: heldInvitations, nextCursor: null }),
        );
      }
      if (invitationList !== null && method === 'POST') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          principalId?: string;
          role?: 'owner' | 'editor' | 'viewer';
        };
        const target = heldInvitees.find((entry) => entry.principalId === body.principalId);
        if (target === undefined) {
          return Promise.resolve(json({ detail: 'The selected person cannot be invited.' }, 409));
        }
        const created: StubInvitation = {
          id: `ffffffff-0000-4000-8000-${String(heldInvitations.length + 1).padStart(12, '0')}`,
          emailNormalized: target.email.toLocaleLowerCase(),
          targetPrincipalId: target.principalId,
          role: body.role ?? 'viewer',
          status: 'pending',
          invitedByPrincipalId: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
          invitedAt: '2026-08-30T09:00:00.000Z',
          acceptedAt: null,
          acceptedByPrincipalId: null,
          revokedAt: null,
        };
        heldInvitations.push(created);
        heldMembers.push({
          subjectType: 'principal',
          subjectId: target.principalId,
          subjectDisplayName: target.displayName,
          email: target.email,
          role: body.role === 'owner' ? 'editor' : (body.role ?? 'viewer'),
          grantedAt: '2026-08-30T09:00:00.000Z',
          canChangeRole: false,
          canRemove: false,
          assignableRoles: [],
        });
        heldInvitees = heldInvitees.filter((entry) => entry.principalId !== target.principalId);
        return Promise.resolve(json(created, 201));
      }

      const inviteeList = /^\/api\/v1\/workspaces\/[0-9a-f-]{36}\/invitees$/.exec(
        parsedUrl.pathname,
      );
      if (inviteeList !== null && method === 'GET') {
        return Promise.resolve(json({ items: heldInvitees, nextCursor: null }));
      }

      const invitationDetail =
        /^\/api\/v1\/workspaces\/[0-9a-f-]{36}\/invitations\/([0-9a-f-]{36})$/.exec(
          parsedUrl.pathname,
        );
      if (invitationDetail !== null && method === 'DELETE') {
        heldInvitations = heldInvitations.map((entry) =>
          entry.id === invitationDetail[1]
            ? { ...entry, status: 'revoked', revokedAt: '2026-08-30T10:00:00.000Z' }
            : entry,
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      const invitationResponse =
        /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/invitations\/([0-9a-f-]{36})\/(accept|decline)$/.exec(
          parsedUrl.pathname,
        );
      if (invitationResponse !== null && method === 'POST') {
        const invitation = heldInvitations.find((entry) => entry.id === invitationResponse[2]);
        if (invitation?.status !== 'pending') {
          return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        }
        const accepted = invitationResponse[3] === 'accept';
        heldInvitations = heldInvitations.map((entry) =>
          entry.id === invitation.id
            ? {
                ...entry,
                status: accepted ? 'accepted' : 'revoked',
                acceptedAt: accepted ? '2026-08-30T10:00:00.000Z' : null,
                acceptedByPrincipalId: accepted ? invitation.targetPrincipalId : null,
                revokedAt: accepted ? null : '2026-08-30T10:00:00.000Z',
              }
            : entry,
        );
        if (!accepted && invitation.targetPrincipalId !== null) {
          heldMembers = heldMembers.filter(
            (entry) => entry.subjectId !== invitation.targetPrincipalId,
          );
          knownWorkspaces = knownWorkspaces.filter((entry) => entry.id !== invitationResponse[1]);
        } else {
          knownWorkspaces = knownWorkspaces.map((entry) =>
            entry.id === invitationResponse[1] ? { ...entry, pendingInvitationId: null } : entry,
          );
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      const memberDetail = /^\/api\/v1\/workspaces\/[0-9a-f-]{36}\/members\/([0-9a-f-]{36})$/.exec(
        parsedUrl.pathname,
      );
      if (memberDetail !== null && method === 'PATCH') {
        if (memberMutationFails) {
          return Promise.resolve(json({ detail: 'The member change was refused.' }, 409));
        }
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          role?: string;
        };
        heldMembers = heldMembers.map((entry) =>
          entry.subjectId === memberDetail[1] ? { ...entry, role: body.role ?? entry.role } : entry,
        );
        const changed = heldMembers.find((entry) => entry.subjectId === memberDetail[1]);
        return Promise.resolve(
          changed === undefined ? json({ code: 'members.not_found' }, 404) : json(changed),
        );
      }
      if (memberDetail !== null && method === 'DELETE') {
        if (memberMutationFails) {
          return Promise.resolve(json({ detail: 'The member could not be removed.' }, 409));
        }
        heldMembers = heldMembers.filter((entry) => entry.subjectId !== memberDetail[1]);
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      const dailyNote =
        /^\/api\/v1\/workspaces\/([0-9a-f-]{36})\/daily-notes\/(\d{4}-\d{2}-\d{2})$/.exec(
          parsedUrl.pathname,
        );
      if (dailyNote !== null && method === 'PUT') {
        const date = dailyNote[2] ?? '';
        const existing = known.find((entry) => entry.title === date);
        if (existing !== undefined) return Promise.resolve(json({ itemId: existing.id }));
        const created = item({ id: createdId(known.length), title: date });
        known.push(created);
        return Promise.resolve(json({ itemId: created.id }));
      }

      // Rescheduling from the collated calendar. The stub records what was written so a test can
      // assert the *value*, which is the whole risk in a drag: the day is easy and the time is not.
      const propertyWrite = /\/api\/v1\/items\/([0-9a-f-]{36})\/properties$/.exec(url);
      if (propertyWrite !== null && method === 'PATCH') {
        const body: unknown = typeof requestBody === 'string' ? JSON.parse(requestBody) : {};
        const written =
          typeof body === 'object' && body !== null && 'properties' in body
            ? (body.properties as Record<string, unknown>)
            : {};

        propertyWrites.push({ itemId: propertyWrite[1] ?? '', properties: written });
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      // Ordered before the /me route below, which would otherwise swallow it.
      if (parsedUrl.pathname === '/api/v1/me/bookmarks') {
        return Promise.resolve(
          bookmarksFail
            ? json({ code: 'bookmarks.unavailable' }, 500)
            : json({ items: kept, hidden: bookmarksHidden }),
        );
      }

      // Keeping and releasing. The stub holds the shelf in memory so a test can press a control and
      // then assert on what the next read says, which is the whole round trip the store makes.
      const bookmarkWrite = /\/api\/v1\/items\/([0-9a-f-]{36})\/bookmark$/.exec(parsedUrl.pathname);
      if (bookmarkWrite !== null && (method === 'PUT' || method === 'DELETE')) {
        const itemId = bookmarkWrite[1] ?? '';
        if (method === 'PUT') {
          if (!kept.some((entry) => entry.itemId === itemId)) {
            const item = known.find((candidate) => candidate.id === itemId);
            kept.unshift({
              itemId,
              title: item?.title ?? 'Untitled',
              type: item?.type ?? 'note',
              workspaceId: STUB_WORKSPACE_ID,
              keptAt: '2026-03-17T09:00:00+00:00',
            });
          }
        } else {
          kept = kept.filter((entry) => entry.itemId !== itemId);
        }

        return Promise.resolve(new Response(null, { status: 204 }));
      }

      // Revoking one token. Ordered, like every /me/tokens route, before the /me route below,
      // which matches by `includes` and would otherwise swallow them all. Flips the row rather
      // than removing it, exactly as the endpoint does, and answers 204 regardless - it is
      // idempotent and scoped to the caller on the real server.
      const revokeToken = /\/api\/v1\/me\/tokens\/([0-9a-f-]{36})$/.exec(parsedUrl.pathname);
      if (revokeToken !== null && method === 'DELETE') {
        heldTokens = heldTokens.map((token) =>
          token.id === revokeToken[1] && token.revokedAt === null
            ? { ...token, revokedAt: '2026-08-16T12:00:00+00:00' }
            : token,
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url.endsWith('/api/v1/me/tokens')) {
        if (method === 'POST') {
          if (createTokenProblem !== undefined) {
            return Promise.resolve(
              json(
                { code: createTokenProblem.code, detail: createTokenProblem.detail },
                createTokenProblem.status,
              ),
            );
          }

          const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
            name?: string;
            scopes?: readonly string[];
            expiresInDays?: number;
          };

          // The expiry honours the requested days against a fixed creation instant, so a test can
          // assert the expiry the interface renders follows the choice the form sent.
          const createdAtMs = Date.parse('2026-08-16T12:00:00+00:00');
          const minted: StubAccessToken = {
            id: mintedTokenId(heldTokens.length),
            name: body.name ?? '',
            scopes: body.scopes ?? [],
            createdAt: '2026-08-16T12:00:00+00:00',
            expiresAt: new Date(
              createdAtMs + (body.expiresInDays ?? 0) * 24 * 60 * 60 * 1000,
            ).toISOString(),
            revokedAt: null,
            lastUsedAt: null,
          };

          // Newest first, as the endpoint promises, so a creation test's next read sees the new
          // token at the top.
          heldTokens = [minted, ...heldTokens];
          return Promise.resolve(json({ token: `stub-secret-${minted.id}`, details: minted }, 201));
        }

        return Promise.resolve(
          tokensFail ? json({ code: 'tokens.unavailable' }, 500) : json({ tokens: heldTokens }),
        );
      }

      // The workspace's members. One page with no cursor: pagination is the reader's concern and
      // walking it is covered by the page shape, not by this stub growing pages.
      if (
        /^\/api\/v1\/workspaces\/[0-9a-f-]{36}\/members$/.test(parsedUrl.pathname) &&
        method === 'GET'
      ) {
        return Promise.resolve(
          membersFail
            ? json({ code: 'workspaces.not_found' }, 404)
            : json({ items: heldMembers, nextCursor: null }),
        );
      }

      if (url.includes('/api/v1/me')) {
        return Promise.resolve(
          profileFails
            ? json({ code: 'identity.principal_not_found' }, 404)
            : json({
                id: '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b',
                tenantId: '11111111-1111-4111-8111-111111111111',
                displayName,
                email,
                isTenantAdministrator,
              }),
        );
      }

      if (/\/api\/v1\/workspaces\/[0-9a-f-]{36}\/templates$/.test(url) && method === 'GET') {
        const response = templatesFail
          ? json({ detail: 'The template library could not be loaded.' }, 500)
          : json({
              templates: knownTemplates.map((template) => {
                const summary: { root?: Readonly<Record<string, unknown>> } = { ...template };
                Reflect.deleteProperty(summary, 'root');
                return summary;
              }),
              capabilities: { canManage: canManageTemplates },
            });
        return templateCatalogGate === undefined
          ? Promise.resolve(response)
          : templateCatalogGate.then(() => response);
      }

      const templatePreflight = /\/api\/v1\/templates\/([0-9a-f-]{36})\/preflight$/.exec(url);
      if (templatePreflight !== null && method === 'POST') {
        const template = knownTemplates.find((candidate) => candidate.id === templatePreflight[1]);
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as Record<
          string,
          unknown
        > & { mode?: 'merge' | 'create' };
        templatePreflightWrites.push(body);
        return Promise.resolve(
          template === undefined
            ? json({}, 404)
            : json({
                templateId: template.id,
                mode: body.mode ?? 'create',
                additions: {
                  fields: template.fieldCount,
                  views: template.viewCount,
                  items: template.childCount,
                },
                conflicts: templatePreflightConflicts,
                canApply: templatePreflightCanApply,
              }),
        );
      }

      const templateDraftSave =
        /\/collab\/templates\/([0-9a-f-]{36})\/drafts\/([0-9a-f-]{36})\/save$/.exec(url);
      if (templateDraftSave !== null && method === 'POST') {
        const operationId = templateDraftSave[2] ?? '';
        const draft = templateDrafts.get(operationId);
        if (draft === undefined) return Promise.resolve(json({}, 404));
        knownTemplates = knownTemplates.map((candidate) =>
          candidate.id === draft.templateId
            ? {
                ...candidate,
                title: draft.title,
                description: draft.description,
                root: draft.root,
                revision: candidate.revision + 1,
              }
            : candidate,
        );
        templateDrafts.delete(operationId);
        return Promise.resolve(json({ templateId: draft.templateId }));
      }

      const templateDraftItem =
        /\/collab\/templates\/([0-9a-f-]{36})\/drafts\/([0-9a-f-]{36})\/items\/([0-9a-f-]{36})$/.exec(
          url,
        );
      if (templateDraftItem !== null && method === 'PATCH') {
        const operationId = templateDraftItem[2] ?? '';
        const draft = templateDrafts.get(operationId);
        if (draft === undefined) return Promise.resolve(json({}, 404));
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as Record<
          string,
          unknown
        >;
        const sourceId = templateDraftItem[3] ?? '';
        const root = updateTemplateRoot(draft.root, sourceId, body);
        templateDrafts.set(operationId, { ...draft, root });
        templateItemWrites.push({
          templateId: draft.templateId,
          sourceId,
          body,
        });
        return Promise.resolve(json(findTemplateRootItem(root, sourceId) ?? root));
      }

      const templateDraft = /\/collab\/templates\/([0-9a-f-]{36})\/drafts\/([0-9a-f-]{36})$/.exec(
        url,
      );
      if (templateDraft !== null) {
        const operationId = templateDraft[2] ?? '';
        if (method === 'GET' && templateDraftUnavailable) {
          return Promise.resolve(
            json(
              {
                code: 'template.operation_stale',
                detail: 'The staged template draft is no longer available.',
              },
              409,
            ),
          );
        }
        const draft = templateDrafts.get(operationId);
        if (draft === undefined) return Promise.resolve(json({}, 404));
        if (method === 'DELETE') {
          templateDrafts.delete(operationId);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const next =
          method === 'PATCH'
            ? {
                ...draft,
                ...(JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
                  title?: string;
                  description?: string | null;
                }),
              }
            : draft;
        templateDrafts.set(operationId, next);
        return Promise.resolve(
          json({
            operationId,
            templateId: next.templateId,
            title: next.title,
            description: next.description,
            expiresAt: '2026-08-17T09:00:00.000Z',
            root: next.root,
          }),
        );
      }

      const beginTemplateDraft = /\/collab\/templates\/([0-9a-f-]{36})\/drafts$/.exec(url);
      if (beginTemplateDraft !== null && method === 'POST') {
        if (templateDraftConflict) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                code: 'template.draft_pending',
                detail: 'A draft opened in another tab must be finished or discarded first.',
              }),
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        const template = knownTemplates.find((candidate) => candidate.id === beginTemplateDraft[1]);
        if (template === undefined) return Promise.resolve(json({}, 404));
        const operationId = 'a9999999-0000-4000-8000-000000000001';
        const draft = {
          templateId: template.id,
          title: template.title,
          description: template.description,
          root: template.root ?? templateRoot(template),
        };
        templateDrafts.set(operationId, draft);
        return Promise.resolve(
          json(
            {
              operationId,
              templateId: template.id,
              title: draft.title,
              description: draft.description,
              expiresAt: '2026-08-17T09:00:00.000Z',
              root: draft.root,
            },
            201,
          ),
        );
      }

      const templateById = /\/api\/v1\/templates\/([0-9a-f-]{36})$/.exec(url);
      if (templateById !== null) {
        const template = knownTemplates.find((candidate) => candidate.id === templateById[1]);
        if (template === undefined) return Promise.resolve(json({}, 404));
        if (method === 'DELETE') {
          knownTemplates = knownTemplates.filter((candidate) => candidate.id !== template.id);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (method === 'PATCH') {
          return Promise.resolve(
            json(
              {
                code: 'method_not_allowed',
                detail: 'Template metadata changes use a staged draft.',
              },
              405,
            ),
          );
        }
        return Promise.resolve(
          json({ ...template, root: template.root ?? templateRoot(template) }),
        );
      }

      if (url.endsWith('/collab/templates/captures') && method === 'POST') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          title?: string;
          description?: string | null;
          workspaceId?: string;
          includeBody?: boolean;
          includeChildren?: boolean;
        };
        const captured: StubTemplate = {
          id: 'a4444444-4444-4444-8444-444444444444',
          workspaceId: body.workspaceId ?? TEMPLATE_WORKSPACE_ID,
          title: body.title ?? 'Captured template',
          description: body.description ?? null,
          origin: 'user',
          revision: 1,
          includeBody: body.includeBody ?? false,
          includeChildren: body.includeChildren ?? false,
          fieldCount: 0,
          viewCount: 0,
          childCount: 0,
          viewKinds: [],
          capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
          updatedAt: '2026-08-16T09:00:00.000Z',
        };
        knownTemplates.push(captured);
        return Promise.resolve(
          json(
            {
              templateId: captured.id,
              operationId: 'a5555555-5555-4555-8555-555555555555',
              writtenTargetItemIds: [],
            },
            201,
          ),
        );
      }

      const templateExport = /\/collab\/templates\/([0-9a-f-]{36})\/export$/.exec(url);
      if (templateExport !== null && method === 'GET') {
        if (templateDuplicateFails) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Template unavailable',
                status: 409,
                code: 'templates.export_unavailable',
                detail: 'This managed template is unavailable.',
              }),
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        exportedTemplate =
          knownTemplates.find((template) => template.id === templateExport[1]) ?? null;
        templateExportWrites.push(templateExport[1] ?? '');
        return Promise.resolve(
          new Response(new Blob(['template archive']), {
            headers: {
              'content-type': 'application/zip',
              'content-disposition': 'attachment; filename="template.nix"',
            },
          }),
        );
      }

      if (url.endsWith('/collab/templates/applications') && method === 'POST') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as Record<
          string,
          unknown
        > & {
          templateId?: string;
          mode?: 'merge' | 'create';
          targetItemId?: string;
          parentItemId?: string | null;
          title?: string;
        };
        templateApplicationWrites.push(body);
        const targetItemId = body.targetItemId ?? createdId(known.length);
        if (body.mode === 'create') {
          known.push(
            item({
              id: targetItemId,
              title: body.title ?? 'From template',
              parentId: body.parentItemId ?? null,
            }),
          );
        }
        return Promise.resolve(
          json(
            {
              applicationId: 'a6666666-6666-4666-8666-666666666666',
              operationId: 'a6666666-6666-4666-8666-666666666666',
              templateId: body.templateId ?? '',
              targetItemId,
              alreadyApplied: false,
              createdItems: [],
              writtenTargetItemIds: [],
            },
            201,
          ),
        );
      }

      if (parsedUrl.pathname === '/api/v1/template-imports' && method === 'POST') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          workspaceId?: string;
          idempotencyKey?: string;
        };
        const requestedIdempotencyKey = body.idempotencyKey ?? '';
        const resumesDurableImport =
          requestedIdempotencyKey.length > 0 &&
          requestedIdempotencyKey === durableTemplateIdempotencyKey;
        if (!resumesDurableImport) {
          durableTemplateImportId = nextTemplateImportId();
          durableTemplateIdempotencyKey = requestedIdempotencyKey;
          durableTemplateWorkspaceId = body.workspaceId ?? STUB_WORKSPACE_ID;
          durableTemplateImportStatus = templateImportReplayPreviewQueued
            ? 'preview_queued'
            : 'pending_upload';
          durableTemplatePreview = null;
          durableTemplateResult = null;
        }
        templateImportIdempotencyKeys.push(requestedIdempotencyKey);
        const canUpload = durableTemplateImportStatus === 'pending_upload';
        templateImportBegins.push({
          importId: durableTemplateImportId,
          status: durableTemplateImportStatus,
          hasUploadCapability: canUpload,
        });
        return Promise.resolve(
          json({
            id: durableTemplateImportId,
            status: durableTemplateImportStatus,
            uploadUrl: canUpload
              ? `${globalThis.location.origin}/object-capabilities/template-imports/${durableTemplateImportId}`
              : null,
            capabilityExpiresAt: canUpload ? '2026-09-01T10:10:00.000Z' : null,
            expiresAt: '2026-09-01T12:00:00.000Z',
          }),
        );
      }

      const templateImportCapability =
        /^\/object-capabilities\/template-imports\/([0-9a-f-]{36})$/.exec(parsedUrl.pathname);
      if (templateImportCapability !== null && method === 'PUT') {
        if (requestBody instanceof Blob) templateUploadBodies.push(requestBody);
        return Promise.resolve(new Response(null, { status: 200 }));
      }

      const durableTemplateImportRoute = /^\/api\/v1\/template-imports\/([0-9a-f-]{36})$/.exec(
        parsedUrl.pathname,
      );
      if (durableTemplateImportRoute !== null) {
        durableTemplateImportId = durableTemplateImportRoute[1] ?? durableTemplateImportId;
        if (method === 'GET') {
          templateImportReads.push(durableTemplateImportId);
          return Promise.resolve(json(durableTemplateImport()));
        }
        if (method === 'DELETE') {
          templateImportCancellations.push(durableTemplateImportId);
          if (refuseNextTemplateCancellation) {
            refuseNextTemplateCancellation = false;
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  title: 'Template import unavailable',
                  status: 503,
                  code: 'template.cancel_unavailable',
                  detail: 'The durable template import could not be cancelled yet.',
                }),
                { status: 503, headers: { 'content-type': 'application/problem+json' } },
              ),
            );
          }
          durableTemplateImportStatus = 'cancelled';
          return Promise.resolve(new Response(null, { status: 204 }));
        }
      }

      const durableTemplatePreviewRoute =
        /^\/api\/v1\/template-imports\/([0-9a-f-]{36})\/preview$/.exec(parsedUrl.pathname);
      if (durableTemplatePreviewRoute !== null && method === 'POST') {
        durableTemplateImportId = durableTemplatePreviewRoute[1] ?? durableTemplateImportId;
        if (refuseNextTemplatePreview) {
          refuseNextTemplatePreview = false;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Template validation unavailable',
                status: 503,
                code: 'template.preview_unavailable',
                detail: 'Template validation is temporarily unavailable.',
              }),
              { status: 503, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        durableTemplatePreview = templateImportPreview();
        durableTemplateImportStatus = 'preview_ready';
        return Promise.resolve(
          json(
            completedTemplateOperation(
              STUB_TEMPLATE_PREVIEW_OPERATION_ID,
              'template-import.preview',
            ),
            202,
          ),
        );
      }

      const durableTemplateCommitRoute =
        /^\/api\/v1\/template-imports\/([0-9a-f-]{36})\/commit$/.exec(parsedUrl.pathname);
      if (durableTemplateCommitRoute !== null && method === 'POST') {
        durableTemplateImportId = durableTemplateCommitRoute[1] ?? durableTemplateImportId;
        templateImportCommitIds.push(durableTemplateImportId);
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          expectedDigest?: string;
        };
        const expectedDigest = body.expectedDigest ?? '';
        templateImportWrites.push(expectedDigest);
        if (refuseNextTemplateCommit) {
          refuseNextTemplateCommit = false;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Template import unavailable',
                status: 503,
                code: 'template.commit_unavailable',
                detail: 'Template publication is temporarily unavailable.',
              }),
              { status: 503, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        if (templateDuplicateCommitFails) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Template unavailable',
                status: 409,
                code: 'templates.import_unavailable',
                detail: 'This managed template is unavailable.',
              }),
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        if (templateFileChanged) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Template file changed',
                status: 409,
                code: 'template.file_changed',
                detail:
                  'The selected file changed after preview. Preview it again before importing.',
              }),
              { status: 409, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }
        const imported = importedTemplate();
        durableTemplateImportStatus = 'completed';
        durableTemplateResult = {
          operationId: null,
          templateId: imported.id,
          stableKey: 'imported-template',
          digest: expectedDigest,
          unchanged: false,
          writtenTargetItemIds: [],
        };
        if (templateDuplicateResponseLostOnce && templateImportWrites.length === 1) {
          return Promise.reject(new TypeError('The response was lost.'));
        }
        return Promise.resolve(
          json(
            completedTemplateOperation(STUB_TEMPLATE_COMMIT_OPERATION_ID, 'template-import.commit'),
            202,
          ),
        );
      }

      const templateImportOperation = /^\/api\/v1\/operations\/([0-9a-f-]{36})$/.exec(
        parsedUrl.pathname,
      );
      if (templateImportOperation !== null && method === 'GET') {
        const operationId = templateImportOperation[1] ?? '';
        if (
          operationId === STUB_TEMPLATE_PREVIEW_OPERATION_ID &&
          durableTemplateImportStatus === 'preview_queued'
        ) {
          durableTemplatePreview = templateImportPreview();
          durableTemplateImportStatus = 'preview_ready';
        }
        return Promise.resolve(
          json(
            completedTemplateOperation(
              operationId,
              operationId === STUB_TEMPLATE_COMMIT_OPERATION_ID
                ? 'template-import.commit'
                : 'template-import.preview',
            ),
          ),
        );
      }

      // Views and schema are read per item and degrade to nothing when absent, which is the
      // ordinary case rather than an error - see useContainer.
      //
      // Writes are kept, because a stub that answered a PUT with 200 and then served the old value
      // on the next GET would make "apply a template" appear to work and change nothing - which is
      // precisely the shape of bug a test here exists to catch.
      const viewsFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/views$/.exec(url);
      if (viewsFor !== null) {
        const id = viewsFor[1] ?? '';

        if (method === 'PUT') {
          const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
            views?: readonly unknown[];
            default?: string | null;
          };

          stored.views[id] = {
            views: body.views ?? [],
            default: body.default ?? 'document',
          };
        }

        const offered = stored.views[id];
        return Promise.resolve(
          json(
            offered === undefined
              ? { views: [], unrenderable: [], default: 'document' }
              : { views: offered.views, unrenderable: [], default: offered.default },
          ),
        );
      }

      const schemaFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/schema$/.exec(url);
      if (schemaFor !== null) {
        const id = schemaFor[1] ?? '';

        if (method === 'PUT') {
          const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
            properties?: readonly unknown[];
            inherit?: boolean;
          };

          const properties = normalizeProperties(body.properties ?? []);
          stored.schema[id] = {
            properties,
            declared: properties,
            inherit: body.inherit ?? true,
          };
        }

        return Promise.resolve(
          json(stored.schema[id] ?? { properties: [], declared: [], inherit: true }),
        );
      }

      const appendSetupFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/view-setups$/.exec(url);
      if (appendSetupFor !== null && method === 'POST') {
        const id = appendSetupFor[1] ?? '';
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          properties?: readonly unknown[];
          views?: readonly unknown[];
          makeDefault?: boolean;
        };
        const currentSchema = stored.schema[id] ?? {
          properties: [],
          declared: [],
          inherit: true,
        };
        const currentViews = stored.views[id] ?? { views: [], default: 'document' };
        const addedViews = body.views ?? [];
        const properties = normalizeProperties(body.properties ?? []);
        stored.schema[id] = {
          ...currentSchema,
          properties: [...currentSchema.properties, ...properties],
          declared: [...currentSchema.declared, ...properties],
        };
        stored.views[id] = {
          views: [...currentViews.views, ...addedViews],
          default:
            body.makeDefault === true && addedViews.length > 0
              ? ((addedViews[0] as { id?: string }).id ?? currentViews.default)
              : currentViews.default,
        };
        const configured = known.find((candidate) => candidate.id === id);
        return Promise.resolve(
          configured === undefined
            ? json({ detail: 'The item could not be found.' }, 404)
            : json({ item: configured, publicForm: null }),
        );
      }

      // Undoing a delete. Answered from the same `known` list a delete never actually removes an
      // item from - only the client's own state drops it, optimistically, the moment the request
      // is sent - so restoring just hands the item back.
      const restoreFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/restore$/.exec(url);
      if (restoreFor !== null && method === 'POST') {
        if (restoreFails) {
          return Promise.resolve(json({ detail: 'The item could not be restored.' }, 500));
        }
        const found = known.find((candidate) => candidate.id === restoreFor[1]);
        return Promise.resolve(found === undefined ? json({}, 404) : json(found));
      }

      // A single item by id, which is what revealing a deep link walks up through and what a
      // delete or a plain read both address.
      const single = /\/api\/v1\/items\/([0-9a-f-]{36})$/.exec(url);
      if (single !== null) {
        if (method === 'DELETE' && removeFails) {
          return Promise.resolve(json({ detail: 'The item could not be deleted.' }, 500));
        }
        if (method === 'DELETE') {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        const found = known.find((candidate) => candidate.id === single[1]);
        return Promise.resolve(found === undefined ? json({}, 404) : json(found));
      }

      if (
        method === 'POST' &&
        /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/structured-items$/.test(url)
      ) {
        if (createRefusal !== undefined) {
          return Promise.resolve(json({ detail: createRefusal }, 422));
        }

        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          title?: string;
          type?: string;
          parentId?: string | null;
          schema?: { properties?: readonly unknown[]; inherit?: boolean };
          views?: { views?: readonly unknown[]; default?: string };
          publishInteractiveFormViewId?: string | null;
          [key: string]: unknown;
        };
        structuredItemWrites.push(body);
        const created = item({
          id: createdId(known.length),
          title: body.title ?? 'Untitled',
          type: body.type ?? 'note',
          parentId: body.parentId ?? null,
          properties: { title: body.title ?? 'Untitled' },
        });
        known.push(created);
        const properties = normalizeProperties(body.schema?.properties ?? []);
        stored.schema[created.id] = {
          properties,
          declared: properties,
          inherit: body.schema?.inherit ?? true,
        };
        stored.views[created.id] = {
          views: body.views?.views ?? [],
          default: body.views?.default ?? 'document',
        };
        return Promise.resolve(json({ item: created, publicForm: null }, 201));
      }

      // Creating. Dispatched on the method, which this stub used not to look at - so a POST fell
      // through to the listing below and came back as a page envelope, and the caller built an item
      // with an undefined id. That is why no test could assert a create had worked.
      if (method === 'POST' && /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/items$/.test(url)) {
        if (createRefusal !== undefined) {
          return Promise.resolve(json({ detail: createRefusal }, 422));
        }

        // `BodyInit` is a union that includes Blob and FormData, neither of which stringifies to
        // anything useful. Every caller here sends JSON text, so narrowing to it says so.
        const raw = typeof requestBody === 'string' ? requestBody : '{}';
        const body = JSON.parse(raw) as {
          title?: string;
          type?: string;
          parentId?: string | null;
          properties?: Record<string, unknown>;
        };

        const created = item({
          id: createdId(known.length),
          title: body.title ?? 'Untitled',
          type: body.type ?? 'note',
          parentId: body.parentId ?? null,
          properties: { title: body.title ?? 'Untitled', ...body.properties },
        });

        known.push(created);
        return Promise.resolve(json(created, 201));
      }

      // Search, reference resolution and backlinks all read the same seeded items, so a test that
      // stubs a workspace gets a working palette and a working picker without saying anything more.
      const calendarWindow =
        /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/calendar\?from=([^&]+)&to=([^&]+)/.exec(url);
      if (calendarWindow !== null) {
        if (calendarFails) {
          return Promise.resolve(json({ code: 'workspaces.not_found' }, 404));
        }

        return Promise.resolve(
          json({
            workspaceId: STUB_WORKSPACE_ID,
            from: decodeURIComponent(calendarWindow[1] ?? ''),
            to: decodeURIComponent(calendarWindow[2] ?? ''),
            // Filled in rather than demanded of every caller: an entry is a stored one unless a
            // test says otherwise, so the ordinary fixture stays about what it is testing.
            entries: calendarEntries.map((entry) => ({
              generated: false,
              completed: null,
              ...entry,
            })),
            unplaceable: calendarUnplaceable.map((row) => ({
              itemId: null,
              itemTitle: null,
              ...row,
            })),
            entryLimit: 2000,
            entriesTruncated: calendarTruncated,
            // Recurrence is off by default in the stub: a series is a fact about a rule, and a
            // test that wants one says so rather than every stubbed workspace repeating.
            seriesTruncated: false,
          }),
        );
      }

      if (/\/api\/v1\/workspaces\/[0-9a-f-]{36}\/graph$/.test(url)) {
        if (graphRouteMissing) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }

        if (graphFails) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                title: 'Workspace not found',
                status: 404,
                code: 'workspaces.not_found',
              }),
              { status: 404, headers: { 'content-type': 'application/problem+json' } },
            ),
          );
        }

        return Promise.resolve(
          json({
            workspaceId: STUB_WORKSPACE_ID,
            nodes: known.map((entry) => ({
              id: entry.id,
              parentId: entry.parentId,
              type: entry.type,
              title: entry.title.length === 0 ? null : entry.title,
            })),
            links: graphLinks,
            nodeLimit: 2000,
            linkLimit: 4000,
            nodesTruncated: graphTruncated.nodes ?? false,
            linksTruncated: graphTruncated.links ?? false,
          }),
        );
      }

      // Ordered before the tree route below because a backlinks url contains "/items" too.
      const backlinksFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/backlinks/.exec(url);
      if (backlinksFor !== null) {
        const target = backlinksFor[1] ?? '';
        const sources = (backlinks[target] ?? []).flatMap((sourceId) => {
          const source = known.find((candidate) => candidate.id === sourceId);
          return source === undefined ? [] : [{ source: digest(source), occurrences: 1 }];
        });

        return Promise.resolve(
          backlinksFail
            ? json({ detail: 'The backlinks could not be read.' }, 500)
            : json({ backlinks: sources, limit: 25, truncated: false }),
        );
      }

      if (url.includes('/api/v1/search/references')) {
        const ids = (/ids=([^&]*)/.exec(url)?.[1] ?? '')
          .split(',')
          .filter((id) => id.length > 0)
          .map((id) => decodeURIComponent(id));

        return Promise.resolve(
          json({
            references: ids.map((id) => {
              // Absent from the seeded workspace stands in for every reason the server refuses to
              // distinguish: deleted, never existed, and not visible to this caller.
              const item = known.find((candidate) => candidate.id === id);
              return item === undefined
                ? { id, readable: false, item: null }
                : { id, readable: true, item: digest(item) };
            }),
          }),
        );
      }

      if (url.includes('/api/v1/search')) {
        if (searchFails) {
          return Promise.resolve(json({ detail: 'The search could not be run.' }, 500));
        }

        const needle = decodeURIComponent(/q=([^&]*)/.exec(url)?.[1] ?? '').toLowerCase();
        const results =
          needle.length === 0
            ? []
            : known
                .filter((candidate) => candidate.title.toLowerCase().includes(needle))
                .map(digest);

        return Promise.resolve(json({ query: needle, results, limit: 20, truncated: false }));
      }

      if (url.includes('/items')) {
        if (treeFails) {
          return Promise.resolve(json({ detail: 'The tree could not be loaded.' }, 500));
        }

        // The tree fetches one parent at a time, so a request naming a parent gets that parent's
        // children and a request naming none gets the roots.
        const parent = /parentId=([^&]+)/.exec(url)?.[1] ?? null;
        return Promise.resolve(
          json({
            items: known.filter((candidate) => candidate.parentId === parent),
            nextCursor: null,
          }),
        );
      }

      return Promise.resolve(json({}, 404));
    }),
  );

  return {
    properties: propertyWrites,
    structuredItems: structuredItemWrites,
    templateItems: templateItemWrites,
    templateImports: templateImportWrites,
    templateImportIdempotencyKeys,
    templateImportBegins,
    templateImportCancellations,
    templateImportCommitIds,
    templateImportReads,
    templateExports: templateExportWrites,
    templateUploadBodies,
    templatePreflights: templatePreflightWrites,
    templateApplications: templateApplicationWrites,
  };
}

function json(body: unknown, status = 200): Response {
  const responseBody =
    status >= 400 && typeof body === 'object' && body !== null
      ? { title: 'Request failed', status, code: 'test.refused', ...body }
      : body;
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    },
  });
}

function templateRoot(template: StubTemplate): Readonly<Record<string, unknown>> {
  const kind = template.viewKinds[0] ?? 'list';
  return {
    sourceId: `b${template.id.slice(1)}`,
    itemType: 'note',
    title: template.title,
    seq: 1000,
    properties: { title: template.title },
    schema: { properties: [], declared: [], inherit: true },
    views: {
      default: 'primary',
      views: [
        {
          id: 'primary',
          name: template.title,
          kind,
          columns: [],
          groupBy: null,
          groupOrder: [],
          dateProperty: null,
          sortBy: null,
          sortDescending: false,
          mode: null,
          coverProperty: null,
          endDateProperty: null,
          cardSize: null,
          filters: [],
          companionViewId: null,
          companionPlacement: null,
          interactiveForm: null,
        },
      ],
    },
    children: [],
    hasBody: template.includeBody,
  };
}

function updateTemplateRoot(
  item: Readonly<Record<string, unknown>>,
  sourceId: string,
  change: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (item.sourceId === sourceId) return { ...item, ...change };
  const sourceChildren = Array.isArray(item.children) ? (item.children as readonly unknown[]) : [];
  const children = sourceChildren.map((child) =>
    typeof child === 'object' && child !== null
      ? updateTemplateRoot(child as Readonly<Record<string, unknown>>, sourceId, change)
      : child,
  );
  return { ...item, children };
}

function findTemplateRootItem(
  item: Readonly<Record<string, unknown>>,
  sourceId: string,
): Readonly<Record<string, unknown>> | null {
  if (item.sourceId === sourceId) return item;
  if (!Array.isArray(item.children)) return null;
  for (const child of item.children) {
    if (typeof child !== 'object' || child === null) continue;
    const found = findTemplateRootItem(child as Readonly<Record<string, unknown>>, sourceId);
    if (found !== null) return found;
  }
  return null;
}
