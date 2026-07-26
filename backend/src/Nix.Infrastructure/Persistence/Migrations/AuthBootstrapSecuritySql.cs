namespace Nix.Infrastructure.Persistence.Migrations;

/// <summary>
/// The second and last pre-authentication lookup: resolving a token's subject to a principal.
/// </summary>
/// <remarks>
/// <para>
/// <b>The same bootstrap problem as ADR-0003, one level down.</b> Once the issuer has been resolved
/// the tenant is known, but knowing it is not the same as having established it: the session
/// context is published with <c>SET LOCAL</c> inside a transaction, and it cannot be published
/// without a principal - which is precisely what this lookup exists to find. Read directly,
/// <c>principal</c> returns nothing, because its policy filters on a tenant no session has set.
/// </para>
/// <para>
/// So this is the same shape of answer, with the same constraints, and deliberately no wider:
/// exact match on tenant and subject, at most one row, no pattern, no listing. It returns the
/// status rather than filtering on it, because "no such principal" and "this principal is
/// deprovisioned" are different refusals and only one of them is worth an alert.
/// </para>
/// <para>
/// ADR-0002 anticipated that authentication would need a migration slot of its own for exactly
/// this kind of narrowing. This is it.
/// </para>
/// </remarks>
internal static class AuthBootstrapSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Emits the function and its grants.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit($"""
            CREATE OR REPLACE FUNCTION nix_resolve_principal(
                p_tenant_id       uuid,
                p_external_subject text)
            RETURNS TABLE (
                principal_id uuid,
                tenant_id    uuid,
                status       text,
                display_name text)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.principal_id, p.tenant_id, p.status, p.display_name
                FROM principal p
                WHERE p.tenant_id = p_tenant_id
                  AND p.external_subject = p_external_subject
                LIMIT 1;
            $$;

            REVOKE ALL ON FUNCTION nix_resolve_principal(uuid, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_principal(uuid, text) TO {ApplicationRole};
            """);
    }

    /// <summary>Removes the function.</summary>
    /// <param name="emit">Sends one statement batch to the migration.</param>
    internal static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("DROP FUNCTION IF EXISTS nix_resolve_principal(uuid, text);");
    }
}
