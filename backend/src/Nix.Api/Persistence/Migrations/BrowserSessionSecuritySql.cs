namespace Nix.Persistence.Migrations;

/// <summary>RLS, grants, invariants and exact resolvers for Core browser sessions.</summary>
public static class BrowserSessionSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Protects the generated browser-session table and creates its narrow resolvers.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit($$"""
            ALTER TABLE browser_session
                ADD CONSTRAINT browser_session_token_hash_valid
                    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
                ADD CONSTRAINT browser_session_expiry_valid
                    CHECK (expires_at > created_at),
                ADD CONSTRAINT browser_session_revocation_valid
                    CHECK (revoked_at IS NULL OR revoked_at >= created_at);

            ALTER TABLE browser_session ENABLE ROW LEVEL SECURITY;
            ALTER TABLE browser_session FORCE ROW LEVEL SECURITY;
            CREATE POLICY browser_session_tenant_isolation ON browser_session
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);

            REVOKE ALL ON browser_session FROM PUBLIC;
            REVOKE ALL ON browser_session FROM {{ApplicationRole}};
            GRANT SELECT, INSERT, UPDATE ON browser_session TO {{ApplicationRole}};

            CREATE FUNCTION nix_resolve_browser_session_by_hash(p_token_hash text)
            RETURNS TABLE (
                session_id uuid,
                tenant_id uuid,
                principal_id uuid,
                principal_status text,
                display_name text,
                expires_at timestamptz)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $$
                SELECT s.session_id,
                       s.tenant_id,
                       s.principal_id,
                       p.status,
                       p.display_name,
                       s.expires_at
                  FROM browser_session s
                  JOIN principal p
                    ON p.tenant_id = s.tenant_id
                   AND p.principal_id = s.principal_id
                 WHERE s.token_hash = p_token_hash
                   AND s.revoked_at IS NULL
                   AND s.expires_at > now()
                   AND p.status = 'active'
                 LIMIT 1
            $$;
            REVOKE ALL ON FUNCTION nix_resolve_browser_session_by_hash(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_browser_session_by_hash(text) TO {{ApplicationRole}};

            CREATE FUNCTION nix_resolve_browser_session_by_id(p_session_id uuid)
            RETURNS TABLE (
                session_id uuid,
                tenant_id uuid,
                principal_id uuid,
                principal_status text,
                display_name text,
                expires_at timestamptz)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $$
                SELECT s.session_id,
                       s.tenant_id,
                       s.principal_id,
                       p.status,
                       p.display_name,
                       s.expires_at
                  FROM browser_session s
                  JOIN principal p
                    ON p.tenant_id = s.tenant_id
                   AND p.principal_id = s.principal_id
                 WHERE s.session_id = p_session_id
                   AND s.revoked_at IS NULL
                   AND s.expires_at > now()
                   AND p.status = 'active'
                 LIMIT 1
            $$;
            REVOKE ALL ON FUNCTION nix_resolve_browser_session_by_id(uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_browser_session_by_id(uuid) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Drops resolver functions before the generated table rollback.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_resolve_browser_session_by_hash(text);
            DROP FUNCTION IF EXISTS nix_resolve_browser_session_by_id(uuid);
            """);
    }
}
