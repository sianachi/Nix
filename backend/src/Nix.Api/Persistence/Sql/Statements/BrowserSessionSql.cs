namespace Nix.Persistence.Sql.Statements;

/// <summary>Exact pre-authentication browser-session resolvers.</summary>
public static class BrowserSessionSql
{
    /// <summary>Resolves one active session from the opaque cookie's SHA-256.</summary>
    public const string ResolveByTokenHash = """
        SELECT session_id, tenant_id, principal_id, principal_status, display_name, expires_at
        FROM nix_resolve_browser_session_by_hash(@token_hash)
        """;

    /// <summary>Resolves one active session named by a Core-signed short token.</summary>
    public const string ResolveById = """
        SELECT session_id, tenant_id, principal_id, principal_status, display_name, expires_at
        FROM nix_resolve_browser_session_by_id(@session_id)
        """;
}
