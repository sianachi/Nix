namespace Nix.Persistence.Migrations;

/// <summary>
/// Hand-written security DDL for the content tables: isolation policies, the grant split between
/// the application and the collaboration service, and the bound on update payloads.
/// </summary>
/// <remarks>
/// <para>
/// Outside <c>Migrations/Generated</c> because that folder is rewritten wholesale by the next
/// scaffold, and this SQL is the only thing that isolates these tables. Frozen to its migration:
/// a later phase writes its own equivalent rather than editing this, because a migration is a
/// record of what was applied on a particular day.
/// </para>
/// <para>
/// The interesting part is the grant split. Everything the M0 schema created is read-write for the
/// application; content is not.
/// </para>
/// </remarks>
internal static class ContentSecuritySql
{
    /// <summary>The runtime role the API connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>The role the collaboration service connects as.</summary>
    private const string CollaborationRole = "nix_collab";

    /// <summary>Tables this migration creates, all tenant-scoped.</summary>
    private static readonly string[] ContentTables =
    [
        "content_doc",
        "content_update",
        "content_snapshot",
    ];

    /// <summary>Emits every statement, in dependency order.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        AssertRolesExist(emit);
        ProtectContentTables(emit);
        SplitGrants(emit);
        BoundUpdatePayloads(emit);
    }

    /// <summary>
    /// Refuses to continue if either role is missing.
    /// </summary>
    /// <remarks>
    /// Both are granted to below. Applying this migration without them would leave the content
    /// tables carrying whatever the schema default happens to be, which is the opposite of the
    /// split this file exists to establish.
    /// </remarks>
    private static void AssertRolesExist(Action<string> emit) =>
        emit($"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{ApplicationRole}') THEN
                    RAISE EXCEPTION 'the runtime role {ApplicationRole} does not exist; refusing to apply the content schema';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{CollaborationRole}') THEN
                    RAISE EXCEPTION 'the collaboration role {CollaborationRole} does not exist; run deploy/seed/seed.sh before migrating';
                END IF;
            END
            $$;
            """);

    /// <summary>
    /// Puts the tenant isolation policy on each content table.
    /// </summary>
    /// <remarks>
    /// The same shape as every M0 table, and for the same reasons: <c>USING</c> and
    /// <c>WITH CHECK</c> both present so a read filter cannot be mistaken for a write guard;
    /// <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than raising;
    /// <c>FORCE</c> so the owner is subject to it too.
    ///
    /// This matters more here than elsewhere. Two services now reach these tables under two roles,
    /// so the policy is the one thing guaranteeing that neither can read across tenants regardless
    /// of which one has the bug.
    /// </remarks>
    private static void ProtectContentTables(Action<string> emit)
    {
        foreach (var table in ContentTables)
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;

                DROP POLICY IF EXISTS {table}_tenant_isolation ON {table};
                CREATE POLICY {table}_tenant_isolation ON {table}
                    USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                    WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
                """);
        }
    }

    /// <summary>
    /// Read-only for the application, read-write for the collaboration service.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Per the table ownership matrix. The reasoning is worth stating because the split looks
    /// arbitrary otherwise: an update can only be validated by <i>applying</i> it and inspecting
    /// what comes out, which needs a CRDT runtime that Core does not have and should not grow.
    /// Core therefore serves content and never authors it, and a bug in Core cannot corrupt a
    /// document.
    /// </para>
    /// <para>
    /// The seed's default privileges grant the application full DML on anything the migrator
    /// creates, so the narrowing has to be explicit here - the default is wrong for these three.
    /// </para>
    /// </remarks>
    private static void SplitGrants(Action<string> emit)
    {
        foreach (var table in ContentTables)
        {
            emit($"""
                REVOKE ALL ON {table} FROM {ApplicationRole};
                GRANT SELECT ON {table} TO {ApplicationRole};

                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {CollaborationRole};
                """);
        }
    }

    /// <summary>
    /// Bounds the size of a single update and of a materialised snapshot.
    /// </summary>
    /// <remarks>
    /// <para>
    /// An update arrives from a browser, so its size is client-controlled. Unbounded, one request
    /// could pin an arbitrary amount of memory in the service that has to apply it before it can
    /// decide whether to keep it - validation means merging, and merging means holding the payload.
    /// </para>
    /// <para>
    /// A megabyte is far above any real keystroke batch and far below anything that threatens the
    /// service. The collaboration service enforces the same ceiling before it applies anything;
    /// this is the backstop for a client that reaches the database another way.
    /// </para>
    /// </remarks>
    private static void BoundUpdatePayloads(Action<string> emit) =>
        emit("""
            ALTER TABLE content_update ADD CONSTRAINT content_update_bounded
                CHECK (octet_length(update_bytes) <= 1048576);

            ALTER TABLE content_snapshot ADD CONSTRAINT content_snapshot_bounded
                CHECK (octet_length(yjs_state) <= 16777216);
            """);
}
