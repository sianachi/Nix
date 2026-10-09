namespace Nix.Persistence.Migrations;

/// <summary>Durable single-use CLI approvals and revocation inherited from their browser session.</summary>
public static class CliLoginSecuritySql
{
    /// <summary>Creates capability-only tables and exact pre-authentication functions.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            CREATE TABLE cli_login_pairing (
                device_hash text PRIMARY KEY CHECK (device_hash ~ '^[0-9a-f]{64}$'),
                user_hash text UNIQUE NOT NULL CHECK (user_hash ~ '^[0-9a-f]{64}$'),
                created_at timestamptz NOT NULL DEFAULT now(),
                expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
                source_session_id uuid REFERENCES browser_session(session_id) ON DELETE CASCADE,
                approved_at timestamptz,
                denied_at timestamptz,
                consumed_at timestamptz,
                CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
                CHECK (approved_at IS NULL OR (source_session_id IS NOT NULL AND denied_at IS NULL))
            );
            CREATE INDEX "IX_cli_login_pairing_expiry" ON cli_login_pairing(expires_at);
            CREATE TABLE cli_session_link (
                session_id uuid PRIMARY KEY REFERENCES browser_session(session_id) ON DELETE CASCADE,
                source_session_id uuid NOT NULL REFERENCES browser_session(session_id) ON DELETE NO ACTION,
                CHECK (session_id <> source_session_id)
            );
            CREATE INDEX "IX_cli_session_link_source" ON cli_session_link(source_session_id);
            ALTER TABLE cli_login_pairing ENABLE ROW LEVEL SECURITY;
            ALTER TABLE cli_login_pairing FORCE ROW LEVEL SECURITY;
            ALTER TABLE cli_session_link ENABLE ROW LEVEL SECURITY;
            ALTER TABLE cli_session_link FORCE ROW LEVEL SECURITY;
            REVOKE ALL ON cli_login_pairing, cli_session_link FROM PUBLIC, nix_app;

            CREATE FUNCTION nix_start_cli_login(p_device_hash text, p_user_hash text) RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            BEGIN
                IF p_device_hash !~ '^[0-9a-f]{64}$' OR p_user_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
                -- A transaction lock makes the global bound hold across concurrent Core instances.
                PERFORM pg_advisory_xact_lock(197074, 1);
                DELETE FROM cli_login_pairing WHERE expires_at <= now();
                IF (SELECT count(*) FROM cli_login_pairing) >= 1024 THEN RETURN false; END IF;
                INSERT INTO cli_login_pairing(device_hash, user_hash) VALUES (p_device_hash, p_user_hash);
                RETURN true;
            END $$;

            CREATE FUNCTION nix_find_pending_cli_login(p_user_hash text) RETURNS timestamptz
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT expires_at FROM cli_login_pairing WHERE user_hash = p_user_hash
                   AND expires_at > now() AND approved_at IS NULL AND denied_at IS NULL AND consumed_at IS NULL
            $$;

            CREATE FUNCTION nix_decide_cli_login(p_user_hash text, p_browser_hash text, p_approve boolean) RETURNS boolean
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE source_id uuid;
            BEGIN
                SELECT s.session_id INTO source_id FROM browser_session s
                  JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                 WHERE s.token_hash = p_browser_hash AND s.revoked_at IS NULL AND s.expires_at > now()
                   AND p.status = 'active' AND p.kind = 'user'
                   AND NOT EXISTS (SELECT 1 FROM cli_session_link l WHERE l.session_id = s.session_id)
                 FOR SHARE OF s, p;
                IF source_id IS NULL THEN RETURN false; END IF;
                UPDATE cli_login_pairing SET source_session_id = source_id,
                    approved_at = CASE WHEN p_approve THEN now() ELSE NULL END,
                    denied_at = CASE WHEN p_approve THEN NULL ELSE now() END
                 WHERE user_hash = p_user_hash AND expires_at > now()
                   AND approved_at IS NULL AND denied_at IS NULL AND consumed_at IS NULL;
                RETURN FOUND;
            END $$;

            CREATE FUNCTION nix_redeem_cli_login(p_device_hash text, p_session_id uuid, p_refresh_hash text)
            RETURNS TABLE (state text, session_id uuid, tenant_id uuid, principal_id uuid,
                principal_status text, display_name text, expires_at timestamptz)
            LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
            DECLARE pairing cli_login_pairing%ROWTYPE; source browser_session%ROWTYPE; person principal%ROWTYPE;
            BEGIN
                SELECT * INTO pairing FROM cli_login_pairing c WHERE c.device_hash = p_device_hash FOR UPDATE;
                IF NOT FOUND OR pairing.expires_at <= now() OR pairing.consumed_at IS NOT NULL THEN
                    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
                    RETURN;
                END IF;
                IF pairing.denied_at IS NOT NULL THEN
                    RETURN QUERY SELECT 'denied'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
                    RETURN;
                END IF;
                IF pairing.approved_at IS NULL THEN
                    RETURN QUERY SELECT 'pending'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
                    RETURN;
                END IF;
                SELECT s.* INTO source FROM browser_session s WHERE s.session_id = pairing.source_session_id
                   AND s.revoked_at IS NULL AND s.expires_at > now()
                   AND NOT EXISTS (SELECT 1 FROM cli_session_link l WHERE l.session_id = s.session_id)
                 FOR SHARE;
                IF FOUND THEN
                    SELECT p.* INTO person FROM principal p WHERE p.tenant_id = source.tenant_id
                       AND p.principal_id = source.principal_id AND p.status = 'active' AND p.kind = 'user' FOR SHARE;
                END IF;
                IF source.session_id IS NULL OR person.principal_id IS NULL OR p_refresh_hash !~ '^[0-9a-f]{64}$' THEN
                    RETURN QUERY SELECT 'expired'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::timestamptz;
                    RETURN;
                END IF;
                INSERT INTO browser_session(session_id, tenant_id, principal_id, token_hash, created_at, expires_at)
                    VALUES(p_session_id, source.tenant_id, source.principal_id, p_refresh_hash, now(), source.expires_at);
                INSERT INTO cli_session_link(session_id, source_session_id) VALUES(p_session_id, source.session_id);
                UPDATE cli_login_pairing SET consumed_at = now() WHERE device_hash = p_device_hash;
                RETURN QUERY SELECT 'approved'::text, p_session_id, source.tenant_id, source.principal_id,
                    person.status, person.display_name, source.expires_at;
            END $$;

            CREATE OR REPLACE FUNCTION nix_resolve_browser_session_by_id(p_session_id uuid)
            RETURNS TABLE (session_id uuid, tenant_id uuid, principal_id uuid, principal_status text,
                display_name text, expires_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT s.session_id, s.tenant_id, s.principal_id, p.status, p.display_name, s.expires_at
                  FROM browser_session s JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                  LEFT JOIN cli_session_link l ON l.session_id = s.session_id
                  LEFT JOIN browser_session parent ON parent.session_id = l.source_session_id
                 WHERE s.session_id = p_session_id AND s.revoked_at IS NULL AND s.expires_at > now()
                   AND p.status = 'active'
                   AND (l.session_id IS NULL OR (p.kind = 'user' AND parent.revoked_at IS NULL AND parent.expires_at > now()
                       AND parent.tenant_id = s.tenant_id AND parent.principal_id = s.principal_id))
                 LIMIT 1
            $$;
            CREATE OR REPLACE FUNCTION nix_resolve_browser_session_by_hash(p_token_hash text)
            RETURNS TABLE (session_id uuid, tenant_id uuid, principal_id uuid, principal_status text,
                display_name text, expires_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT s.session_id, s.tenant_id, s.principal_id, p.status, p.display_name, s.expires_at
                  FROM browser_session s JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                 WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active'
                   AND NOT EXISTS (SELECT 1 FROM cli_session_link l WHERE l.session_id = s.session_id)
                 LIMIT 1
            $$;
            CREATE FUNCTION nix_resolve_cli_session(p_refresh_hash text)
            RETURNS TABLE (session_id uuid, tenant_id uuid, principal_id uuid, principal_status text,
                display_name text, expires_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT standing.* FROM browser_session s JOIN cli_session_link l ON l.session_id = s.session_id
                  CROSS JOIN LATERAL nix_resolve_browser_session_by_id(s.session_id) standing
                 WHERE s.token_hash = p_refresh_hash LIMIT 1
            $$;
            CREATE FUNCTION nix_revoke_cli_session(p_refresh_hash text) RETURNS void
            LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                UPDATE browser_session s SET revoked_at = now() FROM cli_session_link l
                 WHERE s.token_hash = p_refresh_hash AND l.session_id = s.session_id AND s.revoked_at IS NULL
            $$;
            REVOKE ALL ON FUNCTION nix_start_cli_login(text, text), nix_find_pending_cli_login(text),
                nix_decide_cli_login(text, text, boolean), nix_redeem_cli_login(text, uuid, text),
                nix_resolve_cli_session(text), nix_revoke_cli_session(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_start_cli_login(text, text), nix_find_pending_cli_login(text),
                nix_decide_cli_login(text, text, boolean), nix_redeem_cli_login(text, uuid, text),
                nix_resolve_cli_session(text), nix_revoke_cli_session(text) TO nix_app;
            """);
    }

    /// <summary>Removes the CLI boundary while restoring ordinary browser resolvers safely.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        // Existing signed CLI tokens must die during rollback, before their linkage disappears.
        emit("""
            UPDATE browser_session SET revoked_at = now() WHERE revoked_at IS NULL
                AND session_id IN (SELECT session_id FROM cli_session_link);
            DROP FUNCTION nix_start_cli_login(text, text), nix_find_pending_cli_login(text),
                nix_decide_cli_login(text, text, boolean), nix_redeem_cli_login(text, uuid, text),
                nix_resolve_cli_session(text), nix_revoke_cli_session(text);
            DROP TABLE cli_login_pairing, cli_session_link;
            """);
        // Replacing resolver bodies after dropping links avoids maintaining a second copy of the baseline.
        emit("""
            CREATE OR REPLACE FUNCTION nix_resolve_browser_session_by_id(p_session_id uuid)
            RETURNS TABLE (session_id uuid, tenant_id uuid, principal_id uuid, principal_status text, display_name text, expires_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT s.session_id, s.tenant_id, s.principal_id, p.status, p.display_name, s.expires_at
                  FROM browser_session s JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                 WHERE s.session_id = p_session_id AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active' LIMIT 1
            $$;
            CREATE OR REPLACE FUNCTION nix_resolve_browser_session_by_hash(p_token_hash text)
            RETURNS TABLE (session_id uuid, tenant_id uuid, principal_id uuid, principal_status text, display_name text, expires_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
                SELECT s.session_id, s.tenant_id, s.principal_id, p.status, p.display_name, s.expires_at
                  FROM browser_session s JOIN principal p ON p.tenant_id = s.tenant_id AND p.principal_id = s.principal_id
                 WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active' LIMIT 1
            $$;
            """);
    }
}
