using System.Collections.Immutable;

namespace Nix.Infrastructure.Persistence;

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

    /// <summary>The universal object.</summary>
    public const string Item = "item";

    /// <summary>Derived ancestor-descendant edges of the item tree.</summary>
    public const string ItemClosure = "item_closure";

    /// <summary>Access control entries.</summary>
    public const string AclEntry = "acl_entry";

    /// <summary>Insert-only record of what was done.</summary>
    public const string AuditEvent = "audit_event";

    /// <summary>
    /// Every table that holds customer data, and therefore every table that must carry an
    /// isolation policy.
    /// </summary>
    public static ImmutableArray<string> TenantScoped { get; } =
    [
        Tenant,
        Workspace,
        IdentityProvider,
        Principal,
        PrincipalGroup,
        GroupMembership,
        TenantRole,
        WorkspaceMember,
        Item,
        ItemClosure,
        AclEntry,
        AuditEvent,
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
            [Principal] = FullDml,
            [PrincipalGroup] = FullDml,
            [GroupMembership] = FullDml,
            [TenantRole] = FullDml,
            [WorkspaceMember] = FullDml,
            [Item] = FullDml,
            [ItemClosure] = FullDml,
            [AclEntry] = FullDml,

            // Insert-only: an audit trail the application can rewrite records only what an
            // attacker who reached the application was willing to leave behind.
            [AuditEvent] = ["INSERT"],
        }.ToImmutableDictionary(StringComparer.Ordinal);

}
