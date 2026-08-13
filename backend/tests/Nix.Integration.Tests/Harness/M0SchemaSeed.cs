using System.Globalization;

namespace Nix.Integration.Tests.Harness;

/// <summary>
/// One row in every M0 table, for each of the two tenants.
/// </summary>
/// <remarks>
/// <para>
/// Written as the migrator, which holds <c>BYPASSRLS</c>, because seeding both tenants is exactly
/// the thing the policies are supposed to make impossible for anyone else. Doing it through the
/// application's own path would need two sessions and would make the setup depend on the
/// mechanism under test.
/// </para>
/// <para>
/// One row per table is enough and more would be worse: an isolation test asserts a count of one
/// against a table that holds two rows, and any number larger than that only makes a failure
/// harder to read.
/// </para>
/// </remarks>
internal static class M0SchemaSeed
{
    /// <summary>The rows belonging to the first tenant.</summary>
    public static readonly M0TenantRows Alpha = new(
        TenantId: TestTenants.Alpha,
        WorkspaceId: TestTenants.AlphaWorkspace,
        PrincipalId: TestTenants.AlphaPrincipal,
        GroupId: new Guid("1c1c1c1c-1111-4111-8111-1c1c1c1c1c1c"),
        ProviderId: new Guid("1d1d1d1d-1111-4111-8111-1d1d1d1d1d1d"),
        ItemId: new Guid("1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e"),
        AclEntryId: new Guid("1f1f1f1f-1111-4111-8111-1f1f1f1f1f1f"),
        AuditEventId: new Guid("19191919-1111-4111-8111-191919191919"),
        ContentDocId: new Guid("1d0c1d0c-1111-4111-8111-1d0c1d0c1d0c"),
        Slug: "alpha");

    /// <summary>The rows belonging to the second tenant - the ones that must never be visible.</summary>
    public static readonly M0TenantRows Beta = new(
        TenantId: TestTenants.Beta,
        WorkspaceId: TestTenants.BetaWorkspace,
        PrincipalId: TestTenants.BetaPrincipal,
        GroupId: new Guid("2c2c2c2c-2222-4222-8222-2c2c2c2c2c2c"),
        ProviderId: new Guid("2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d"),
        ItemId: new Guid("2e2e2e2e-2222-4222-8222-2e2e2e2e2e2e"),
        AclEntryId: new Guid("2f2f2f2f-2222-4222-8222-2f2f2f2f2f2f"),
        AuditEventId: new Guid("29292929-2222-4222-8222-292929292929"),
        ContentDocId: new Guid("2d0c2d0c-2222-4222-8222-2d0c2d0c2d0c"),
        Slug: "beta");

    /// <summary>
    /// Seeds both tenants' rows into every M0 table.
    /// </summary>
    /// <param name="fixture">The database fixture.</param>
    /// <returns>A task that completes when both tenants are present.</returns>
    public static async Task SeedBothTenantsAsync(NixPostgresFixture fixture)
    {
        ArgumentNullException.ThrowIfNull(fixture);

        var connection = await fixture.OpenMigratorConnectionAsync();
        await using (connection.ConfigureAwait(false))
        {
            await RawSql.ExecuteAsync(connection, transaction: null, InsertSqlFor(Alpha));
            await RawSql.ExecuteAsync(connection, transaction: null, InsertSqlFor(Beta));
        }
    }

    private static string InsertSqlFor(M0TenantRows rows)
    {
        // Insertion order follows the foreign keys: the tenant, then what hangs off it, then the
        // item, then what hangs off the item.
        var tenant = Literal(rows.TenantId);
        var workspace = Literal(rows.WorkspaceId);
        var principal = Literal(rows.PrincipalId);
        var group = Literal(rows.GroupId);
        var provider = Literal(rows.ProviderId);
        var item = Literal(rows.ItemId);
        var acl = Literal(rows.AclEntryId);
        var auditEvent = Literal(rows.AuditEventId);
        var contentDoc = Literal(rows.ContentDocId);
        var slug = rows.Slug;

        return $"""
            INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
            VALUES ({tenant}, '{slug}', 'shared', now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({workspace}, {tenant}, '{slug} workspace', 30, 10, 1073741824, now());

            INSERT INTO principal
                (principal_id, tenant_id, external_subject, kind, display_name, email, status,
                 deprovisioned_at)
            VALUES ({principal}, {tenant}, '{slug}-subject', 'user', '{slug} user',
                    '{slug}@example.test', 'active', NULL);

            INSERT INTO principal_group (group_id, tenant_id, name, external_id)
            VALUES ({group}, {tenant}, '{slug} group', '{slug}-external');

            INSERT INTO identity_provider
                (provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms, enabled)
            VALUES ({provider}, {tenant}, 'https://issuer.{slug}.test', 'nix-api',
                    'https://issuer.{slug}.test/keys', ARRAY['RS256']::text[], true);

            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({group}, {principal}, {tenant}, 'directory');

            INSERT INTO tenant_role
                (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
            VALUES ({tenant}, 'principal', {principal}, 'admin', {principal}, now());

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({workspace}, 'principal', {principal}, {tenant}, 'editor', {principal}, now());

            INSERT INTO item
                (id, tenant_id, workspace_id, type, parent_id, seq, properties, lifecycle_state,
                 purge_after, created_by, last_modified_by, created_at, last_modified_at)
            VALUES ({item}, {tenant}, {workspace}, 'folder', NULL, 1000, NULL, 'active', NULL,
                    {principal}, {principal}, now(), now());

            INSERT INTO item_closure (descendant_id, ancestor_id, tenant_id, workspace_id, depth)
            VALUES ({item}, {item}, {tenant}, {workspace}, 0);

            INSERT INTO acl_entry
                (acl_entry_id, item_id, tenant_id, workspace_id, subject_type, subject_id, role,
                 effect, breaks_inheritance)
            VALUES ({acl}, {item}, {tenant}, {workspace}, 'principal', {principal}, 'editor',
                    'allow', false);

            INSERT INTO audit_event
                (event_id, tenant_id, workspace_id, actor_id, on_behalf_of, action, subject_id,
                 subject_type, before, after, actor_ip, occurred_at)
            VALUES ({auditEvent}, {tenant}, {workspace}, {principal}, NULL, 'item.created',
                    {item}, 'item', NULL, jsonb_build_object('type', 'folder'),
                    '203.0.113.10'::inet, now());

            INSERT INTO content_doc
                (doc_id, tenant_id, item_id, workspace_id, schema_version, head_seq, created_at)
            VALUES ({contentDoc}, {tenant}, {item}, {workspace}, 1, 1, now());

            -- One update, so the log is not empty and the isolation theory has a row to filter.
            -- The bytes are not a real CRDT payload: nothing in Core interprets them, and the
            -- collaboration service's own tests use real ones.
            INSERT INTO content_update
                (doc_id, seq, tenant_id, update_bytes, actor_id, client_id, created_at)
            VALUES ({contentDoc}, 1, {tenant}, '\\x0102'::bytea, {principal}, '{slug}-client', now());

            INSERT INTO content_snapshot
                (doc_id, seq, tenant_id, yjs_state, prosemirror_json, plaintext, created_at)
            VALUES ({contentDoc}, 1, {tenant}, '\\x0102'::bytea, NULL, '{slug} note body', now());

            INSERT INTO item_search (tenant_id, item_id, seq, updated_at, body_vector)
            VALUES ({tenant}, {item}, 1, now(), to_tsvector('english', '{slug} note body'));

            -- A self-edge, which extraction never produces: a document linking to itself is
            -- dropped precisely so it cannot appear in its own backlinks panel. It is used here
            -- because the seed holds exactly one item per tenant and every isolation theory in
            -- this suite asserts a count of one against each table - seeding a second item to
            -- make this edge realistic would change what ten other test classes see. What is
            -- being proved here is that the row carries a tenant and the policy honours it,
            -- and a self-edge proves that as well as any other pair would.
            INSERT INTO item_link (tenant_id, source_item_id, target_item_id, occurrences, seq)
            VALUES ({tenant}, {item}, {item}, 1, 1);

            -- One library per principal, and the seeded principal gets theirs. Present so the
            -- isolation theories have a row to see and a row to try to relabel; the contents are
            -- opaque to Core, so an empty array says as much as anything else would.
            INSERT INTO canvas_library (principal_id, tenant_id, library_items, updated_at)
            VALUES ({principal}, {tenant}, '[]'::jsonb, now());

            -- The seeded principal keeps the seeded item. Present for the same reason the library
            -- above is: the isolation theories need a row to see and a row to try to relabel. The
            -- seed holds one item per tenant, so this is the only pair there is to make.
            INSERT INTO bookmark (principal_id, tenant_id, item_id, created_at)
            VALUES ({principal}, {tenant}, {item}, now());
            """;
    }

    private static string Literal(Guid value) =>
        $"'{value.ToString("D", CultureInfo.InvariantCulture)}'::uuid";
}

/// <summary>
/// The identifiers of one tenant's seeded rows.
/// </summary>
/// <param name="TenantId">The tenant.</param>
/// <param name="WorkspaceId">Its workspace.</param>
/// <param name="PrincipalId">Its principal.</param>
/// <param name="GroupId">Its group.</param>
/// <param name="ProviderId">Its registered issuer.</param>
/// <param name="ItemId">Its one item.</param>
/// <param name="AclEntryId">The access control entry on that item.</param>
/// <param name="AuditEventId">The audit event recording the item's creation.</param>
/// <param name="ContentDocId">The document body of that item.</param>
/// <param name="Slug">A short name, used to make seeded text distinguishable in failures.</param>
internal sealed record M0TenantRows(
    Guid TenantId,
    Guid WorkspaceId,
    Guid PrincipalId,
    Guid GroupId,
    Guid ProviderId,
    Guid ItemId,
    Guid AclEntryId,
    Guid AuditEventId,
    Guid ContentDocId,
    string Slug);
