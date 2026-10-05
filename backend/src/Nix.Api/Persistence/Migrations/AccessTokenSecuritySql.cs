namespace Nix.Persistence.Migrations;

/// <summary>
/// The hand-written half of the personal-access-token migration: the isolation policy on
/// <c>personal_access_token</c>, the runtime role's grants, and the third pre-authentication
/// resolver.
/// </summary>
/// <remarks>
/// Outside <c>Migrations/Generated</c> because that folder is rewritten wholesale by the next
/// scaffold, and this SQL is the only thing that isolates the table. Frozen to its migration: a
/// later phase writes its own equivalent rather than editing this, because a migration is a
/// record of what was applied on a particular day.
/// </remarks>
public static class AccessTokenSecuritySql
{
    /// <summary>The runtime role Core connects as.</summary>
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Emits every statement, in dependency order.
    /// </summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        ProtectTokens(emit);
        GrantTokens(emit);
        CreateResolver(emit);
    }

    /// <summary>Removes what <see cref="Apply"/> created, for the migration's Down.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_resolve_access_token(text);");
    }

    /// <summary>
    /// Puts the tenant isolation policy on <c>personal_access_token</c>.
    /// </summary>
    /// <remarks>
    /// The same shape as every other tenant-scoped table: <c>USING</c> and <c>WITH CHECK</c> both
    /// present, <c>current_setting(..., true)</c> so an unscoped session sees nothing rather than
    /// raising, <c>FORCE</c> so the table owner is subject to it too. Principal ownership - one
    /// principal never reads another's tokens - is enforced in the statements, which take the
    /// acting principal from the session context and never as input, the same way the bookmark
    /// shelf does and for the reason recorded there.
    /// </remarks>
    private static void ProtectTokens(Action<string> emit) =>
        emit("""
            ALTER TABLE personal_access_token ENABLE ROW LEVEL SECURITY;
            ALTER TABLE personal_access_token FORCE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS personal_access_token_tenant_isolation ON personal_access_token;
            CREATE POLICY personal_access_token_tenant_isolation ON personal_access_token
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            """);

    /// <summary>
    /// Narrows the runtime role's privileges to what it is expected to hold.
    /// </summary>
    /// <remarks>
    /// Full DML minus DELETE: tokens are revoked, never deleted by the application - the row is
    /// the audit of what has been able to act as a principal, and an application that can erase
    /// that record can erase evidence. Purging rides the principal's own cascade, which runs as
    /// the owner. <c>NixTables.ExpectedApplicationPrivileges</c> asserts this exact set against
    /// the live catalogue.
    /// </remarks>
    private static void GrantTokens(Action<string> emit) =>
        emit($"""
            REVOKE ALL ON personal_access_token FROM PUBLIC;
            REVOKE ALL ON personal_access_token FROM {ApplicationRole};
            GRANT SELECT, INSERT, UPDATE ON personal_access_token TO {ApplicationRole};
            """);

    /// <summary>
    /// Creates the pre-authentication resolver the exchange endpoint uses.
    /// </summary>
    /// <remarks>
    /// The third of its kind, beside <c>nix_resolve_identity_provider</c> and
    /// <c>nix_resolve_principal</c> (ADR-0003), with the same constraints and deliberately no
    /// wider: exact match on the indexed lookup half, at most one row, no pattern, no listing.
    /// It returns the stored hash rather than judging the token - judging means comparing
    /// hashes in constant time, which is application arithmetic, not SQL. It also returns the
    /// principal's status and subject in the same read, so the exchange is one round trip and
    /// the minted session resolves through the same subject lookup an interactive one does.
    /// </remarks>
    private static void CreateResolver(Action<string> emit) =>
        emit($"""
            CREATE OR REPLACE FUNCTION nix_resolve_access_token(p_lookup text)
            RETURNS TABLE (
                token_id         uuid,
                tenant_id        uuid,
                principal_id     uuid,
                external_subject text,
                principal_status text,
                secret_hash      bytea,
                scopes           text[],
                expires_at       timestamptz,
                revoked_at       timestamptz)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT t.token_id,
                       t.tenant_id,
                       t.principal_id,
                       p.external_subject,
                       p.status,
                       t.secret_hash,
                       t.scopes,
                       t.expires_at,
                       t.revoked_at
                FROM personal_access_token t
                JOIN principal p
                  ON p.tenant_id = t.tenant_id
                 AND p.principal_id = t.principal_id
                WHERE t.lookup = p_lookup
                LIMIT 1;
            $$;

            REVOKE ALL ON FUNCTION nix_resolve_access_token(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_access_token(text) TO {ApplicationRole};
            """);
}
