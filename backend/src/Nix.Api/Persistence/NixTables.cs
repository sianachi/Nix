using System.Collections.Immutable;

namespace Nix.Persistence;

/// <summary>
/// The physical table names of the M0 schema, and which of them are tenant-scoped.
/// </summary>
/// <remarks>
/// <para>
/// Three places need to agree on these strings: the entity configurations that map to them, the
/// hand-written SQL that queries them, and the integration suite that checks each one carries a
/// row-level security policy. Spelling them once means a rename cannot leave a table silently
/// unprotected because the test's copy of the name no longer matches anything.
/// </para>
/// <para>
/// <see cref="TenantScoped"/> is the list the isolation tests iterate. A new table that holds
/// customer data belongs in it; a new table that does not is the rare exception and should be
/// argued for, because "every row carries a tenant" is what makes the policies uniform.
/// </para>
/// </remarks>
public static class NixTables
{
    /// <summary>The column every tenant-scoped table carries, and every policy filters on.</summary>
    public const string TenantIdColumn = "tenant_id";

    /// <summary>Customer organisations.</summary>
    public const string Tenant = "tenant";

    /// <summary>Containers inside a tenant.</summary>
    public const string Workspace = "workspace";

    /// <summary>Registered OIDC issuers.</summary>
    public const string IdentityProvider = "identity_provider";

    /// <summary>Core-owned browser sessions.</summary>
    public const string BrowserSession = "browser_session";

    /// <summary>Identities provisioned from an issuer.</summary>
    public const string Principal = "principal";

    /// <summary>Named sets of principals.</summary>
    public const string PrincipalGroup = "principal_group";

    /// <summary>Principal-to-group membership.</summary>
    public const string GroupMembership = "group_membership";

    /// <summary>Tenant-wide role grants.</summary>
    public const string TenantRole = "tenant_role";

    /// <summary>Workspace-level role grants.</summary>
    public const string WorkspaceMember = "workspace_member";

    /// <summary>Durable workspace invitation history.</summary>
    public const string WorkspaceInvitation = "workspace_invitation";

    /// <summary>The universal object.</summary>
    public const string Item = "item";

    /// <summary>Derived ancestor-descendant edges of the item tree.</summary>
    public const string ItemClosure = "item_closure";

    /// <summary>Access control entries.</summary>
    public const string AclEntry = "acl_entry";

    /// <summary>Insert-only record of what was done.</summary>
    public const string AuditEvent = "audit_event";

    /// <summary>The body of a native item.</summary>
    public const string ContentDoc = "content_doc";

    /// <summary>Append-only log of conflict-free updates. The source of truth for content.</summary>
    public const string ContentUpdate = "content_update";

    /// <summary>Materialisations of the update log. Derived, rebuildable, never authoritative.</summary>
    public const string ContentSnapshot = "content_snapshot";

    /// <summary>Item-to-item reference edges, extracted from documents. Derived, rebuildable.</summary>
    public const string ItemLink = "item_link";

    /// <summary>The searchable text of each item's document. Derived, rebuildable.</summary>
    public const string ItemSearch = "item_search";

    /// <summary>A principal's personal set of reusable Excalidraw shapes.</summary>
    public const string CanvasLibrary = "canvas_library";

    /// <summary>One row per item a principal has kept.</summary>
    public const string Bookmark = "bookmark";

    /// <summary>One revocable capability per published item view.</summary>
    public const string PublicFormLink = "public_form_link";

    /// <summary>One credential a principal issued for a non-browser client.</summary>
    public const string PersonalAccessToken = "personal_access_token";

    /// <summary>Workspace-visible catalog entries backed by hidden item trees.</summary>
    public const string WorkspaceTemplate = "workspace_template";

    /// <summary>Staged capture/import protocols.</summary>
    public const string TemplateOperation = "template_operation";

    /// <summary>Complete mappings for staged capture/import bodies.</summary>
    public const string TemplateOperationItem = "template_operation_item";

    /// <summary>Idempotent template applications.</summary>
    public const string TemplateApplication = "template_application";

    /// <summary>Stable source-to-target mappings for applications.</summary>
    public const string TemplateApplicationItem = "template_application_item";

    /// <summary>Backend-owned asynchronous worker jobs.</summary>
    public const string WorkerJob = "worker_job";

    /// <summary>Backend-owned durable events for rebuildable derived data.</summary>
    public const string WorkerOutboxEvent = "worker_outbox_event";

    /// <summary>
    /// Every table that holds customer data, and therefore every table that must carry an
    /// isolation policy.
    /// </summary>
    public static ImmutableArray<string> TenantScoped { get; } =
    [
        Tenant,
        Workspace,
        IdentityProvider,
        BrowserSession,
        Principal,
        PrincipalGroup,
        GroupMembership,
        TenantRole,
        WorkspaceMember,
        WorkspaceInvitation,
        Item,
        ItemClosure,
        AclEntry,
        AuditEvent,
        ContentDoc,
        ContentUpdate,
        ContentSnapshot,
        ItemLink,
        ItemSearch,
        CanvasLibrary,
        Bookmark,
        PublicFormLink,
        PersonalAccessToken,
        WorkspaceTemplate,
        TemplateOperation,
        TemplateOperationItem,
        TemplateApplication,
        TemplateApplicationItem,
        WorkerJob,
        WorkerOutboxEvent,
    ];

    /// <summary>
    /// Read and write, sorted the way <c>information_schema.table_privileges</c> reports them.
    /// </summary>
    /// <remarks>
    /// Declared before the dictionary that reads it. Static property initializers run in
    /// declaration order, so the other way round leaves this one still <c>default</c> - an
    /// <c>ImmutableArray</c> that throws on enumeration rather than reading as empty.
    /// </remarks>
    private static ImmutableArray<string> FullDml { get; } = ["DELETE", "INSERT", "SELECT", "UPDATE"];

    /// <summary>Read without write, sorted the way the catalogue reports it.</summary>
    private static ImmutableArray<string> ReadOnly { get; } = ["SELECT"];

    /// <summary>Read, create and transition, but never erase history.</summary>
    private static ImmutableArray<string> RevocableHistory { get; } = ["INSERT", "SELECT", "UPDATE"];

    /// <summary>
    /// The privileges the runtime role is expected to hold on each table, from the development
    /// document's table ownership matrix.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Written out per table rather than assumed, because the database seed's
    /// <c>ALTER DEFAULT PRIVILEGES</c> makes grants fail <i>open</i>: a table a migration forgets
    /// to narrow arrives with full DML for the application. Stating the intended set here and
    /// asserting it against <c>information_schema</c> turns that from a silent default into a
    /// failing test.
    /// </para>
    /// <para>
    /// The matrix is not uniform and gets less so: <c>audit_event</c> is insert-only now, and the
    /// M1 content tables are read-only for Core because the collaboration service owns writing
    /// them. A table added without a line here fails the grants test rather than inheriting
    /// whatever the default happened to be.
    /// </para>
    /// </remarks>
    public static ImmutableDictionary<string, ImmutableArray<string>> ExpectedApplicationPrivileges { get; } =
        new Dictionary<string, ImmutableArray<string>>(StringComparer.Ordinal)
        {
            [Tenant] = FullDml,
            [Workspace] = FullDml,
            [IdentityProvider] = FullDml,
            [BrowserSession] = ["INSERT", "SELECT", "UPDATE"],
            [Principal] = FullDml,
            [PrincipalGroup] = FullDml,
            [GroupMembership] = FullDml,
            [TenantRole] = FullDml,
            [WorkspaceMember] = FullDml,
            [WorkspaceInvitation] = RevocableHistory,
            [Item] = FullDml,

            // A bookmark is personal state the application both reads and writes on the reader's
            // behalf: keeping one is the whole feature, and there is no other service that owns it.
            [Bookmark] = FullDml,
            [PublicFormLink] = FullDml,
            [WorkspaceTemplate] = FullDml,
            [TemplateOperation] = FullDml,
            [TemplateOperationItem] = FullDml,
            [TemplateApplication] = FullDml,
            [TemplateApplicationItem] = FullDml,
            [WorkerJob] = FullDml,
            [WorkerOutboxEvent] = FullDml,
            [ItemClosure] = FullDml,
            [AclEntry] = FullDml,

            // Insert-only: an audit trail the application can rewrite records only what an
            // attacker who reached the application was willing to leave behind.
            [AuditEvent] = ["INSERT"],

            // Read-only for the application, per the table ownership matrix. Content is written by
            // the collaboration service, which is the only thing that can validate an update -
            // doing so means applying it, which needs a CRDT runtime. Core serves what is there
            // and never authors it, so a bug in Core cannot corrupt a document.
            [ContentDoc] = ReadOnly,
            [ContentUpdate] = ReadOnly,
            [ContentSnapshot] = ReadOnly,

            // Read-only for the same reason as the content tables, one step further along: an edge
            // and a search vector are extracted from a materialised document, and materialising a
            // document needs the CRDT runtime only the collaboration service has. Core reads what
            // was derived and never derives it.
            [ItemLink] = ReadOnly,
            [ItemSearch] = ReadOnly,

            // A principal's own library, read and written by Core alone - nothing else ever
            // touches it.
            [CanvasLibrary] = FullDml,

            // Revoked, never deleted: the rows are the audit of what has been able to act as a
            // principal, and an application that can erase that record can erase evidence.
            // Purging rides the principal's own cascade, which does not need this grant.
            [PersonalAccessToken] = ["INSERT", "SELECT", "UPDATE"],
        }.ToImmutableDictionary(StringComparer.Ordinal);

}
