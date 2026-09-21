namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for <c>content_version</c>: the same tenant isolation policy as
/// <c>content_snapshot</c>, the same grant split between the application and the collaboration
/// service, and the bound on a version's name.
/// </summary>
/// <remarks>
/// A separate file rather than an edit to <see cref="ContentSecuritySql"/>, for the reason that
/// file states about itself: it is frozen to the migration that applied it, and later phases add
/// their own equivalent. Follows the same shape because the table follows the same rules - one
/// more content table, isolated and owned the same way.
/// </remarks>
internal static class ContentVersionSecuritySql
{
    /// <summary>The runtime role the API connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    private const string Table = "content_version";

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        ProtectTable(emit);
        SplitGrants(emit);
        BoundName(emit);
    }

    /// <summary>
    /// Puts the tenant isolation policy on the table.
    /// </summary>
    /// <remarks>
    /// The same shape as the other content tables: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the owner is subject to it too.
    /// </remarks>
    private static void ProtectTable(Action<string> emit) =>
        emit($"""
            ALTER TABLE {Table} ENABLE ROW LEVEL SECURITY;
            ALTER TABLE {Table} FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS {Table}_tenant_isolation ON {Table};
            CREATE POLICY {Table}_tenant_isolation ON {Table}
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Read-only for the application, read-write for the collaboration service.
    /// </summary>
    /// <remarks>
    /// Naming a version means pinning a snapshot, which means reading the log and possibly
    /// writing a new snapshot row - the same reason the other content tables are collab-owned.
    /// Core only ever lists and displays names; it never mints one.
    /// </remarks>
    private static void SplitGrants(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON {Table} FROM {ApplicationRole};
            GRANT SELECT ON {Table} TO {ApplicationRole};

            GRANT SELECT, INSERT, UPDATE, DELETE ON {Table} TO {CollaborationRole};
            """);

    /// <summary>
    /// Bounds the length of a version's name.
    /// </summary>
    /// <remarks>
    /// The contract's own rule (1 to 120 characters), enforced at the database as the backstop
    /// for a client that reaches it another way - the same reasoning as
    /// <c>content_update_bounded</c> and <c>content_snapshot_bounded</c>.
    /// </remarks>
    private static void BoundName(Action<string> emit) =>
        emit($"""
            ALTER TABLE {Table} ADD CONSTRAINT content_version_name_bounded
                CHECK (char_length(name) BETWEEN 1 AND 120);
            """);
}
