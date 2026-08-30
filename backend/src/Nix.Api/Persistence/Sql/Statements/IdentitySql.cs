namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The two pre-authentication lookups, and the only reads in the system that are not tenant-scoped.
/// </summary>
/// <remarks>
/// <para>
/// Both run before a session context exists, which is why the first goes through
/// <c>nix_resolve_identity_provider</c> - the security-definer function the M0 migration created
/// (ADR-0003) - rather than reading <c>identity_provider</c> directly. A direct read would
/// correctly return nothing, because the runtime role holds no <c>BYPASSRLS</c> and the table's
/// policy filters on a tenant nobody has established yet.
/// </para>
/// <para>
/// The principal lookup is different: by the time it runs the tenant is known, so it is an ordinary
/// tenant-scoped read that happens to run inside the transaction that just published the context.
/// </para>
/// </remarks>
public static class IdentitySql
{
    /// <summary>
    /// Resolves a token's issuer and audience to the tenant that registered them.
    /// </summary>
    /// <remarks>
    /// The function matches on both values exactly and returns at most one row; there is no
    /// pattern, no wildcard and no way to list. Index dependency: none of ours - the function's
    /// body uses <c>IX_identity_provider_issuer_audience</c>.
    /// </remarks>
    public const string ResolveProvider = """
        SELECT provider_id, tenant_id, issuer, audience, jwks_uri, allowed_algorithms,
               jit_provisioning_enabled, userinfo_uri
        FROM nix_resolve_identity_provider(@issuer, @audience)
        """;

    /// <summary>
    /// Finds a principal by the issuer's subject claim, within the tenant already resolved.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Returns the status rather than filtering on it. "No such principal" and "this principal is
    /// deprovisioned" are different answers and the caller refuses both - but only one of them
    /// should be logged as a revoked session still presenting a valid token, and a query that
    /// filtered them together would throw that distinction away.
    /// </para>
    /// <para>
    /// Index dependency: the function's body uses <c>IX_principal_tenant_id_external_subject</c>,
    /// which is unique, so this is a single index seek.
    /// </para>
    /// </remarks>
    public const string FindPrincipalByExternalIdentity = """
        SELECT principal_id, tenant_id, status, display_name
        FROM nix_resolve_external_principal(@tenant_id, @external_issuer, @external_subject)
        """;

    /// <summary>Resolves a Core-issued session by tenant and principal ID.</summary>
    public const string FindPrincipalById = """
        SELECT principal_id, tenant_id, status, display_name
        FROM nix_resolve_principal_by_id(@tenant_id, @principal_id)
        """;
}
