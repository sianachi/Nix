namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// The one hand-written statement personal access tokens need: the pre-authentication resolve
/// behind the exchange endpoint. Everything session-scoped on the table is envelope CRUD and
/// stays in EF Core.
/// </summary>
public static class AccessTokenSql
{
    /// <summary>
    /// Resolves a presented token's lookup half to the row that can judge it, through the
    /// security-definer function the phase's migration created. At most one row; the hash it
    /// returns still has to be compared, in constant time, by the caller.
    /// </summary>
    public const string ResolveForExchange = """
        SELECT token_id, tenant_id, principal_id, external_subject, principal_status,
               secret_hash, scopes, expires_at, revoked_at
        FROM nix_resolve_access_token(@lookup)
        """;
}
