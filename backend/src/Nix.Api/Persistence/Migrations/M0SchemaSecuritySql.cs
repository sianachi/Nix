namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written security DDL applied by the <c>M0Schema</c> migration: row-level security
/// policies, the grant narrowing on <c>audit_event</c>, the payload size bounds, and the
/// pre-authentication identity provider resolver.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is not in the migration file.</b> Everything under <c>Migrations/Generated</c> is
/// written by <c>dotnet ef migrations add</c> and rewritten wholesale by the next scaffold. SQL
/// that lives there is one <c>migrations remove</c> away from being silently deleted - and this
/// SQL is the only thing that turns twelve tables from readable-by-anyone into tenant-isolated.
/// Keeping it in a hand-authored file makes that structural rather than a comment someone has to
/// read. The generated <c>Up</c> calls <see cref="Apply"/>; if a scaffold drops that call, the
/// isolation tests fail immediately.
/// </para>
/// <para>
/// <b>This class is frozen.</b> A migration is a record of what was applied on a particular day,
/// so this file belongs to <c>M0Schema</c> alone and must never be edited to suit a later phase -
/// editing it would retroactively change what an already-applied migration means. The next
/// phase's migration writes its own equivalent.
/// </para>
/// </remarks>
internal static class M0SchemaSecuritySql
{
    /// <summary>
    /// The runtime role. Named here rather than resolved, because a migration records what was
    /// actually granted, to whom, on the day it ran.
    /// </summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Every table the M0 migration creates. Literal, not read from <c>NixTables</c>: adding a
    /// table to that list in a later phase must not change what this migration did.
    /// </summary>
    private static readonly string[] TenantScopedTables =
    [
        "tenant",
        "workspace",
        "identity_provider",
        "principal",
        "principal_group",
        "group_membership",
        "tenant_role",
        "workspace_member",
        "item",
        "item_closure",
        "acl_entry",
        "audit_event",
    ];

    /// <summary>
    /// Emits every security statement, in dependency order.
    /// </summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        AssertApplicationRoleExists(emit);
        ProtectTenantScopedTables(emit);
        RestrictAuditEventToInsertOnly(emit);
        BoundJsonPayloads(emit);
        CreateIdentityProviderResolver(emit);
    }

    /// <summary>
    /// Refuses to continue if the runtime role is absent.
    /// </summary>
    /// <remarks>
    /// Everything below grants to, or revokes from, this role. Applying the migration without it
    /// would leave <c>audit_event</c> writable by whatever role connects next and the resolver
    /// function executable by everyone, so failing here is the only safe response.
    /// </remarks>
    private static void AssertApplicationRoleExists(Action<string> emit) =>
        emit($"""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{ApplicationRole}') THEN
                    RAISE EXCEPTION
                        'the runtime role {ApplicationRole} does not exist; refusing to apply the M0 schema, because its grants and revocations would silently not apply';
                END IF;
            END
            $$;
            """);

    /// <summary>
    /// Puts the tenant isolation policy on every table.
    /// </summary>
    /// <remarks>
    /// The shape is fixed and every table gets exactly it:
    /// <list type="bullet">
    ///   <item><description>
    ///   <c>USING</c> <b>and</b> <c>WITH CHECK</c>. <c>USING</c> alone would hide other tenants'
    ///   rows on read while still permitting an INSERT that plants a row under their id.
    ///   </description></item>
    ///   <item><description>
    ///   <c>current_setting('nix.tenant_id', true)</c> - the <c>true</c> is <c>missing_ok</c>. An
    ///   unset session yields NULL, the comparison yields NULL, no row qualifies, and an unscoped
    ///   query returns nothing instead of raising. Fail closed, quietly.
    ///   </description></item>
    ///   <item><description>
    ///   <c>FORCE ROW LEVEL SECURITY</c>, so the table owner is subject to the policy too. Only
    ///   <c>BYPASSRLS</c> gets past it, and only <c>nix_migrator</c> holds that.
    ///   </description></item>
    /// </list>
    /// <para>
    /// <c>current_setting</c> is STABLE, so where an index leads with <c>tenant_id</c> the planner
    /// hoists this into an index condition and evaluates it once per scan. Where it lands in
    /// filter position instead it costs about 54ns per row - which is why every query should
    /// carry its own explicit <c>tenant_id</c> predicate as well, per the defence-in-depth rule.
    /// </para>
    /// </remarks>
    private static void ProtectTenantScopedTables(Action<string> emit)
    {
        foreach (var table in TenantScopedTables)
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
    /// Narrows the runtime role to INSERT on <c>audit_event</c>.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The database seed grants the runtime role full DML on everything the migrator creates,
    /// which is the right default and the wrong answer for this one table. An audit trail the
    /// application can rewrite records only what an attacker who reached the application was
    /// willing to leave behind, so UPDATE and DELETE are removed - and SELECT with them, per the
    /// table ownership matrix.
    /// </para>
    /// <para>
    /// Consequence worth stating plainly: nothing running as <c>nix_app</c> can read this table.
    /// That is intended for M0, where audit is written and never displayed. The goal that builds
    /// audit export needs a read path that does not simply hand SELECT back - a separate role, or
    /// a security-definer view that filters by tenant - and choosing between those is that goal's
    /// decision, not this migration's.
    /// </para>
    /// </remarks>
    private static void RestrictAuditEventToInsertOnly(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON audit_event FROM {ApplicationRole};
            GRANT INSERT ON audit_event TO {ApplicationRole};
            """);

    /// <summary>
    /// Bounds the size of every client-influenced JSON payload.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A <c>jsonb</c> column read into a .NET <c>string</c> is UTF-16, so a document of N
    /// characters occupies 22 + 2N bytes: anything past roughly 42,000 characters lands on the
    /// large object heap, which is not compacted by default. Every envelope write records a before
    /// and an after image, so the audit path would materialise two of them per mutation. Left
    /// unbounded, a client could put Core's resident memory outside its budget by writing large
    /// item properties in a loop.
    /// </para>
    /// <para>
    /// The numbers are chosen to sit clear of that threshold with room for UTF-16 expansion, not
    /// because 32 KB of properties is a meaningful product limit. What matters is that a bound
    /// exists and the database enforces it: adding one later means a full-table validation scan,
    /// whereas now the tables are empty and it is free.
    /// </para>
    /// </remarks>
    private static void BoundJsonPayloads(Action<string> emit) =>
        emit("""
            ALTER TABLE item ADD CONSTRAINT item_properties_bounded
                CHECK (properties IS NULL OR octet_length(properties::text) <= 32768);

            ALTER TABLE audit_event ADD CONSTRAINT audit_event_payload_bounded
                CHECK (
                    coalesce(octet_length(before::text), 0)
                  + coalesce(octet_length(after::text), 0) <= 65536);
            """);

    /// <summary>
    /// Creates the one function permitted to read <c>identity_provider</c> without a tenant.
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>The bootstrap problem.</b> Authentication resolves a token's <c>iss</c> and <c>aud</c>
    /// against this table to discover which tenant the caller belongs to - so the tenant is the
    /// output of the lookup, and cannot also be its precondition. But the table carries the same
    /// tenant-keyed policy as everything else, and the runtime role has no <c>BYPASSRLS</c>. Read
    /// directly, the query correctly returns nothing, forever.
    /// </para>
    /// <para>
    /// <b>Why a function rather than an exception to the policy.</b> The alternatives are worse in
    /// ways that are hard to undo: granting <c>BYPASSRLS</c> to the runtime role removes isolation
    /// everywhere to solve it in one place, and a permissive policy on the table would let any
    /// authenticated session enumerate every tenant's issuers. This function is
    /// <c>SECURITY DEFINER</c>, so it runs as its owner (<c>nix_migrator</c>) and sees past the
    /// policy - but only through this one hole, whose shape is fixed here: an exact match on both
    /// <c>issuer</c> and <c>audience</c>, enabled registrations only, at most one row, and no
    /// parameter that can widen it. There is no pattern match and no way to list.
    /// </para>
    /// <para>
    /// <c>search_path</c> is pinned because a <c>SECURITY DEFINER</c> function that resolves
    /// unqualified names through a caller-controlled search path is the classic privilege
    /// escalation. <c>EXECUTE</c> is revoked from PUBLIC and granted only to the runtime role.
    /// </para>
    /// <para>
    /// The returned row deliberately excludes nothing sensitive and includes nothing surplus: it
    /// is what token validation needs to verify a signature and establish a session, and no more.
    /// </para>
    /// </remarks>
    private static void CreateIdentityProviderResolver(Action<string> emit) =>
        emit($"""
            CREATE OR REPLACE FUNCTION nix_resolve_identity_provider(
                p_issuer   text,
                p_audience text)
            RETURNS TABLE (
                provider_id        uuid,
                tenant_id          uuid,
                issuer             text,
                audience           text,
                jwks_uri           text,
                allowed_algorithms text[])
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.provider_id,
                       p.tenant_id,
                       p.issuer,
                       p.audience,
                       p.jwks_uri,
                       p.allowed_algorithms
                FROM identity_provider p
                WHERE p.issuer = p_issuer
                  AND p.audience = p_audience
                  AND p.enabled
                LIMIT 1;
            $$;

            REVOKE ALL ON FUNCTION nix_resolve_identity_provider(text, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_identity_provider(text, text) TO {ApplicationRole};
            """);
}
