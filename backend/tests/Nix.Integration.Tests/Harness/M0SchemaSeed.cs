using System.Globalization;
using Nix.Domain.Identity;

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
        InvitationId: new Guid("15151515-1111-4111-8111-151515151515"),
        ItemId: new Guid("1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e"),
        AclEntryId: new Guid("1f1f1f1f-1111-4111-8111-1f1f1f1f1f1f"),
        AuditEventId: new Guid("19191919-1111-4111-8111-191919191919"),
        ContentDocId: new Guid("1d0c1d0c-1111-4111-8111-1d0c1d0c1d0c"),
        TemplateId: new Guid("1a1a1a1a-1111-4111-8111-1a1a1a1a1a1a"),
        TemplateOperationId: new Guid("1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b"),
        TemplateApplicationId: new Guid("18181818-1111-4111-8111-181818181818"),
        TemplateSourceId: new Guid("17171717-1111-4111-8111-171717171717"),
        Slug: "alpha");

    /// <summary>The rows belonging to the second tenant - the ones that must never be visible.</summary>
    public static readonly M0TenantRows Beta = new(
        TenantId: TestTenants.Beta,
        WorkspaceId: TestTenants.BetaWorkspace,
        PrincipalId: TestTenants.BetaPrincipal,
        GroupId: new Guid("2c2c2c2c-2222-4222-8222-2c2c2c2c2c2c"),
        ProviderId: new Guid("2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d"),
        InvitationId: new Guid("25252525-2222-4222-8222-252525252525"),
        ItemId: new Guid("2e2e2e2e-2222-4222-8222-2e2e2e2e2e2e"),
        AclEntryId: new Guid("2f2f2f2f-2222-4222-8222-2f2f2f2f2f2f"),
        AuditEventId: new Guid("29292929-2222-4222-8222-292929292929"),
        ContentDocId: new Guid("2d0c2d0c-2222-4222-8222-2d0c2d0c2d0c"),
        TemplateId: new Guid("2a2a2a2a-2222-4222-8222-2a2a2a2a2a2a"),
        TemplateOperationId: new Guid("2b2b2b2b-2222-4222-8222-2b2b2b2b2b2b"),
        TemplateApplicationId: new Guid("28282828-2222-4222-8222-282828282828"),
        TemplateSourceId: new Guid("27272727-2222-4222-8222-272727272727"),
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
        var invitation = Literal(rows.InvitationId);
        var browserSession = invitation;
        var item = Literal(rows.ItemId);
        var acl = Literal(rows.AclEntryId);
        var auditEvent = Literal(rows.AuditEventId);
        var contentDoc = Literal(rows.ContentDocId);
        var template = Literal(rows.TemplateId);
        var templateOperation = Literal(rows.TemplateOperationId);
        var templateApplication = Literal(rows.TemplateApplicationId);
        var templateSource = Literal(rows.TemplateSourceId);
        var slug = rows.Slug;
        var browserSessionHash = new string(slug == "alpha" ? 'a' : 'b', BrowserSession.TokenHashLength);

        return $"""
            INSERT INTO tenant (tenant_id, name, isolation_mode, created_at)
            VALUES ({tenant}, '{slug}', 'shared', now());

            INSERT INTO workspace
                (workspace_id, tenant_id, name, version_retention_days, coalesce_window_min,
                 storage_quota_bytes, created_at)
            VALUES ({workspace}, {tenant}, '{slug} workspace', 30, 10, 1073741824, now());

            INSERT INTO principal
                (principal_id, tenant_id, external_issuer, external_subject, kind, display_name,
                 email, email_normalized, email_verified, status, deprovisioned_at)
            VALUES ({principal}, {tenant}, 'https://issuer.{slug}.test', '{slug}-subject', 'user',
                    '{slug} user', '{slug}@example.test', '{slug}@example.test', true,
                    'active', NULL);

            INSERT INTO browser_session
                (session_id, tenant_id, principal_id, token_hash, created_at, expires_at, revoked_at)
            VALUES ({browserSession}, {tenant}, {principal}, '{browserSessionHash}', now(),
                    now() + interval '8 hours', NULL);

            INSERT INTO principal_group (group_id, tenant_id, name, external_id)
            VALUES ({group}, {tenant}, '{slug} group', '{slug}-external');

            INSERT INTO identity_provider
                (provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms, enabled,
                 jit_provisioning_enabled, userinfo_uri)
            VALUES ({provider}, {tenant}, 'https://issuer.{slug}.test', 'nix-api',
                    'https://issuer.{slug}.test/keys', ARRAY['RS256']::text[], true, false,
                    'https://issuer.{slug}.test/userinfo');

            INSERT INTO group_membership (group_id, principal_id, tenant_id, source)
            VALUES ({group}, {principal}, {tenant}, 'directory');

            INSERT INTO tenant_role
                (tenant_id, subject_type, subject_id, role, granted_by, granted_at)
            VALUES ({tenant}, 'principal', {principal}, 'admin', {principal}, now());

            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            VALUES ({workspace}, 'principal', {principal}, {tenant}, 'editor', {principal}, now());

            INSERT INTO workspace_invitation
                (invitation_id, tenant_id, workspace_id, email_normalized, role,
                 invited_by_principal_id, status, invited_at)
            VALUES ({invitation}, {tenant}, {workspace}, 'pending-{slug}@example.test', 'viewer',
                    {principal}, 'pending', now());

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

            -- One published capability so the generic tenant-isolation theories exercise the
            -- public link table exactly as they do every other tenant-scoped table.
            INSERT INTO public_form_link
                (id, tenant_id, workspace_id, item_id, view_id, nonce,
                 submission_principal_id, published_by, published_at, revoked_at)
            VALUES ({auditEvent}, {tenant}, {workspace}, {item}, 'form', '{slug}-nonce',
                    {principal}, {principal}, now(), NULL);

            -- One credential the seeded principal issued, so the isolation theories exercise the
            -- token table exactly as they do every other tenant-scoped table. The hash is an
            -- arbitrary constant: no test exchanges this row, and a secret that never existed
            -- cannot leak. The lookup embeds the slug so the two tenants' rows stay unique under
            -- the global index.
            INSERT INTO personal_access_token
                (token_id, tenant_id, principal_id, name, lookup, secret_hash, scopes,
                 created_at, expires_at, revoked_at, last_used_at)
            VALUES ({group}, {tenant}, {principal}, '{slug} seeded token', 'seed{slug}0000',
                    '\\x0304'::bytea, ARRAY['read']::text[], now(), now() + interval '30 days',
                    NULL, NULL);

            -- A provisioning catalog and its operation/application mappings exercise the five
            -- template tables without adding a second item to this deliberately one-row seed.
            INSERT INTO workspace_template
                (template_id, tenant_id, workspace_id, root_item_id, pending_root_item_id,
                 stable_key, profile_key, origin, title, description, include_body,
                 include_children, managed_source, source_digest, state, revision, created_by,
                 last_modified_by, created_at, last_modified_at)
            VALUES ({template}, {tenant}, {workspace}, NULL, NULL,
                    '{slug}-template', '{slug}-template', 'user', '{slug} template', NULL,
                    false, false, NULL, NULL, 'provisioning', 1, {principal}, {principal},
                    now(), now());

            INSERT INTO template_operation
                (operation_id, tenant_id, workspace_id, template_id, kind, idempotency_key,
                 source_item_id, actor_id, draft_title, draft_description, managed_source,
                 source_digest, state, created_at, expires_at, finalized_at)
            VALUES ({templateOperation}, {tenant}, {workspace}, {template}, 'capture',
                    '{slug}-operation', {item}, {principal}, '{slug} template', NULL, NULL, NULL,
                    'provisioning', now(), now() + interval '1 hour', NULL);

            INSERT INTO template_operation_item
                (operation_id, template_source_id, tenant_id, source_item_id, target_item_id,
                 item_type, body_required)
            VALUES ({templateOperation}, {templateSource}, {tenant}, {item}, {item}, 'folder',
                    false);

            INSERT INTO template_application
                (application_id, tenant_id, workspace_id, template_id, target_item_id,
                 parent_item_id, requested_title, mode, idempotency_key, actor_id, state,
                 created_at, expires_at, finalized_at)
            VALUES ({templateApplication}, {tenant}, {workspace}, {template}, {item}, NULL, NULL,
                    'merge', '{slug}-application', {principal}, 'provisioning', now(),
                    now() + interval '1 hour', NULL);

            INSERT INTO template_application_item
                (application_id, template_source_id, tenant_id, source_item_id, item_type,
                 target_item_id, is_root, created, body_required)
            VALUES ({templateApplication}, {templateSource}, {tenant}, {item}, 'folder', {item},
                    true, false, false);

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
/// <param name="InvitationId">Its pending workspace invitation.</param>
/// <param name="ItemId">Its one item.</param>
/// <param name="AclEntryId">The access control entry on that item.</param>
/// <param name="AuditEventId">The audit event recording the item's creation.</param>
/// <param name="ContentDocId">The document body of that item.</param>
/// <param name="TemplateId">The tenant's template catalog row.</param>
/// <param name="TemplateOperationId">The tenant's staged template operation.</param>
/// <param name="TemplateApplicationId">The tenant's staged template application.</param>
/// <param name="TemplateSourceId">The stable source identity used by both mappings.</param>
/// <param name="Slug">A short name, used to make seeded text distinguishable in failures.</param>
internal sealed record M0TenantRows(
    Guid TenantId,
    Guid WorkspaceId,
    Guid PrincipalId,
    Guid GroupId,
    Guid ProviderId,
    Guid InvitationId,
    Guid ItemId,
    Guid AclEntryId,
    Guid AuditEventId,
    Guid ContentDocId,
    Guid TemplateId,
    Guid TemplateOperationId,
    Guid TemplateApplicationId,
    Guid TemplateSourceId,
    string Slug);
