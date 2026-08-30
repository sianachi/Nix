namespace Nix.Persistence.Migrations;

/// <summary>Security, invariants, resolver replacement, and deterministic legacy backfill.</summary>
public static class PersonalWorkspaceFoundationSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Applies the hand-written part of the personal-workspace foundation.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        BackfillExternalIssuers(emit);
        BackfillSeededPersonalWorkspace(emit);
        AddConstraintsAndIndexes(emit);
        ProtectInvitationHistory(emit);
        ReplaceResolvers(emit);
    }

    /// <summary>Removes functions and constraints before the generated down migration.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit($"""
            DO $$
            DECLARE duplicate_ids text;
            BEGIN
                SELECT string_agg(duplicate.principal_id::text, ', ' ORDER BY duplicate.principal_id)
                  INTO duplicate_ids
                  FROM principal duplicate
                  JOIN (
                      SELECT tenant_id, external_subject
                        FROM principal
                       GROUP BY tenant_id, external_subject
                      HAVING count(*) > 1
                  ) collision
                    ON collision.tenant_id = duplicate.tenant_id
                   AND collision.external_subject = duplicate.external_subject;

                IF duplicate_ids IS NOT NULL THEN
                    RAISE EXCEPTION
                        'cannot revert issuer-qualified identity while principal IDs share a legacy subject: %',
                        duplicate_ids;
                END IF;
            END
            $$;

            DROP INDEX IF EXISTS ix_workspace_member_direct_owner;
            ALTER TABLE workspace_member
                DROP CONSTRAINT IF EXISTS workspace_member_role_known;
            ALTER TABLE acl_entry
                DROP CONSTRAINT IF EXISTS acl_entry_role_known;
            ALTER TABLE principal
                DROP CONSTRAINT IF EXISTS principal_external_identity_bounded,
                DROP CONSTRAINT IF EXISTS principal_external_subject_bounded,
                DROP CONSTRAINT IF EXISTS principal_email_bounded,
                DROP CONSTRAINT IF EXISTS principal_verified_email_consistent,
                DROP CONSTRAINT IF EXISTS principal_email_normalized_bounded;
            ALTER TABLE identity_provider
                DROP CONSTRAINT IF EXISTS identity_provider_jit_has_userinfo,
                DROP CONSTRAINT IF EXISTS identity_provider_userinfo_uri_bounded;
            DROP TRIGGER IF EXISTS workspace_invitation_transition_guard ON workspace_invitation;
            DROP FUNCTION IF EXISTS nix_guard_workspace_invitation_transition();

            DROP FUNCTION IF EXISTS nix_resolve_external_principal(uuid, text, text);
            DROP FUNCTION IF EXISTS nix_resolve_principal_by_id(uuid, uuid);
            DROP FUNCTION IF EXISTS nix_resolve_identity_provider(text, text);
            DROP FUNCTION IF EXISTS nix_resolve_access_token(text);

            CREATE FUNCTION nix_resolve_identity_provider(p_issuer text, p_audience text)
            RETURNS TABLE (
                provider_id uuid,
                tenant_id uuid,
                issuer text,
                audience text,
                jwks_uri text,
                allowed_algorithms text[])
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.provider_id, p.tenant_id, p.issuer, p.audience, p.jwks_uri,
                       p.allowed_algorithms
                  FROM identity_provider p
                 WHERE p.issuer = p_issuer AND p.audience = p_audience AND p.enabled
                 LIMIT 1
            $$;
            REVOKE ALL ON FUNCTION nix_resolve_identity_provider(text, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_identity_provider(text, text) TO {ApplicationRole};

            CREATE FUNCTION nix_resolve_principal(p_tenant_id uuid, p_external_subject text)
            RETURNS TABLE (principal_id uuid, tenant_id uuid, status text, display_name text)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.principal_id, p.tenant_id, p.status, p.display_name
                  FROM principal p
                 WHERE p.tenant_id = p_tenant_id
                   AND p.external_subject = p_external_subject
                 LIMIT 1
            $$;
            REVOKE ALL ON FUNCTION nix_resolve_principal(uuid, text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_principal(uuid, text) TO {ApplicationRole};

            CREATE FUNCTION nix_resolve_access_token(p_lookup text)
            RETURNS TABLE (
                token_id uuid, tenant_id uuid, principal_id uuid, external_subject text,
                principal_status text, secret_hash bytea, scopes text[], expires_at timestamptz,
                revoked_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT t.token_id, t.tenant_id, t.principal_id, p.external_subject, p.status,
                       t.secret_hash, t.scopes, t.expires_at, t.revoked_at
                  FROM personal_access_token t
                  JOIN principal p ON p.tenant_id = t.tenant_id
                                  AND p.principal_id = t.principal_id
                 WHERE t.lookup = p_lookup
                 LIMIT 1
            $$;
            REVOKE ALL ON FUNCTION nix_resolve_access_token(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_access_token(text) TO {ApplicationRole};
            """);
    }

    private static void BackfillExternalIssuers(Action<string> emit) =>
        emit("""
            WITH deterministic_issuer AS (
                SELECT tenant_id, min(issuer) AS issuer
                  FROM identity_provider
                 GROUP BY tenant_id
                HAVING count(DISTINCT issuer) = 1
            )
            UPDATE principal p
               SET external_issuer = d.issuer
              FROM deterministic_issuer d
             WHERE p.tenant_id = d.tenant_id
               AND p.external_issuer IS NULL
               AND p.kind = 'user';

            WITH deterministic_issuer AS (
                SELECT tenant_id, min(issuer) AS issuer
                  FROM identity_provider
                 GROUP BY tenant_id
                HAVING count(DISTINCT issuer) = 1
            )
            UPDATE principal p
               SET external_issuer = d.issuer
              FROM deterministic_issuer d
             WHERE p.tenant_id = d.tenant_id
               AND p.tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid
               AND p.principal_id = 'a2000000-0000-4000-8000-000000000004'::uuid
               AND p.kind = 'service'
               AND p.external_issuer IS NULL;

            DO $$
            DECLARE ambiguous_ids text;
            BEGIN
                SELECT string_agg(p.principal_id::text, ', ' ORDER BY p.principal_id)
                  INTO ambiguous_ids
                  FROM principal p
                 WHERE EXISTS (
                           SELECT 1 FROM identity_provider provider
                            WHERE provider.tenant_id = p.tenant_id)
                   AND p.external_issuer IS NULL
                   AND (
                       p.kind = 'user'
                       OR (
                           p.kind = 'service'
                           AND NOT (
                               p.tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid
                               AND p.principal_id = 'a2000000-0000-4000-8000-000000000004'::uuid)
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM public_form_link form_link
                                WHERE form_link.tenant_id = p.tenant_id
                                  AND form_link.submission_principal_id = p.principal_id)));

                IF ambiguous_ids IS NOT NULL THEN
                    RAISE EXCEPTION
                        'external issuer mapping is ambiguous for principal IDs: %; map external_issuer explicitly before retrying',
                        ambiguous_ids;
                END IF;
            END
            $$;
            """);

    private static void BackfillSeededPersonalWorkspace(Action<string> emit) =>
        emit("""
            INSERT INTO workspace_member
                (workspace_id, subject_type, subject_id, tenant_id, role, granted_by, granted_at)
            SELECT w.workspace_id,
                   'principal',
                   p.principal_id,
                   w.tenant_id,
                   'owner',
                   p.principal_id,
                   now()
              FROM workspace w
              JOIN principal p
                ON p.tenant_id = w.tenant_id
               AND p.principal_id = 'a2000000-0000-4000-8000-000000000001'::uuid
             WHERE w.workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
               AND w.tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid
            ON CONFLICT (workspace_id, subject_type, subject_id) DO UPDATE
                SET role = 'owner',
                    granted_by = EXCLUDED.granted_by,
                    granted_at = EXCLUDED.granted_at
              WHERE workspace_member.role <> 'owner';

            UPDATE workspace w
               SET personal_owner_principal_id = 'a2000000-0000-4000-8000-000000000001'::uuid
             WHERE w.workspace_id = 'a1000000-0000-4000-8000-000000000001'::uuid
               AND w.tenant_id = 'a0000000-0000-4000-8000-000000000001'::uuid
               AND EXISTS (
                   SELECT 1
                     FROM workspace_member m
                    WHERE m.workspace_id = w.workspace_id
                      AND m.tenant_id = w.tenant_id
                      AND m.subject_type = 'principal'
                      AND m.subject_id = 'a2000000-0000-4000-8000-000000000001'::uuid
                      AND m.role = 'owner');
            """);

    private static void AddConstraintsAndIndexes(Action<string> emit) =>
        emit("""
            ALTER TABLE identity_provider
                ADD CONSTRAINT identity_provider_jit_has_userinfo
                CHECK (NOT jit_provisioning_enabled OR userinfo_uri IS NOT NULL),
                ADD CONSTRAINT identity_provider_userinfo_uri_bounded
                CHECK (userinfo_uri IS NULL OR octet_length(userinfo_uri) BETWEEN 1 AND 2048);

            ALTER TABLE principal
                ADD CONSTRAINT principal_external_identity_bounded
                CHECK (external_issuer IS NULL OR octet_length(external_issuer) <= 1024),
                ADD CONSTRAINT principal_external_subject_bounded
                CHECK (octet_length(external_subject) <= 1024),
                ADD CONSTRAINT principal_email_bounded
                CHECK (email IS NULL OR octet_length(email) <= 1024),
                ADD CONSTRAINT principal_verified_email_consistent
                CHECK (
                    (NOT email_verified AND email_normalized IS NULL)
                 OR (email_verified AND email IS NOT NULL AND email_normalized IS NOT NULL)),
                ADD CONSTRAINT principal_email_normalized_bounded
                CHECK (email_normalized IS NULL OR octet_length(email_normalized) BETWEEN 1 AND 320);

            ALTER TABLE workspace_member
                ADD CONSTRAINT workspace_member_role_known
                CHECK (role IN ('owner', 'editor', 'commenter', 'viewer'));

            ALTER TABLE acl_entry
                ADD CONSTRAINT acl_entry_role_known
                CHECK (role IN ('owner', 'editor', 'commenter', 'viewer'));

            ALTER TABLE workspace_invitation
                ADD CONSTRAINT workspace_invitation_role_known
                CHECK (role IN ('owner', 'editor', 'commenter', 'viewer')),
                ADD CONSTRAINT workspace_invitation_status_known
                CHECK (status IN ('pending', 'accepted', 'revoked')),
                ADD CONSTRAINT workspace_invitation_transition_consistent
                CHECK (
                    (status = 'pending' AND accepted_at IS NULL
                                        AND accepted_by_principal_id IS NULL
                                        AND revoked_at IS NULL)
                 OR (status = 'accepted' AND accepted_at IS NOT NULL
                                         AND accepted_by_principal_id IS NOT NULL
                                         AND revoked_at IS NULL)
                 OR (status = 'revoked' AND accepted_at IS NULL
                                        AND accepted_by_principal_id IS NULL
                                        AND revoked_at IS NOT NULL));

            CREATE INDEX ix_workspace_member_direct_owner
                ON workspace_member (tenant_id, workspace_id, subject_id)
                WHERE subject_type = 'principal' AND role = 'owner';

            CREATE FUNCTION nix_guard_workspace_invitation_transition()
            RETURNS trigger
            LANGUAGE plpgsql
            SET search_path = public, pg_temp
            AS $$
            BEGIN
                IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
                    RAISE EXCEPTION 'workspace invitation identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.invitation_id IS DISTINCT FROM OLD.invitation_id
                   OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
                   OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
                   OR NEW.role IS DISTINCT FROM OLD.role
                   OR NEW.invited_by_principal_id IS DISTINCT FROM OLD.invited_by_principal_id
                   OR NEW.invited_at IS DISTINCT FROM OLD.invited_at THEN
                    RAISE EXCEPTION 'workspace invitation identity is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
                    RAISE EXCEPTION 'accepted and revoked workspace invitations are terminal'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF OLD.status = 'pending'
                   AND NEW.status NOT IN ('pending', 'accepted', 'revoked') THEN
                    RAISE EXCEPTION 'invalid workspace invitation transition'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END
            $$;

            CREATE TRIGGER workspace_invitation_transition_guard
                BEFORE UPDATE ON workspace_invitation
                FOR EACH ROW EXECUTE FUNCTION nix_guard_workspace_invitation_transition();
            REVOKE ALL ON FUNCTION nix_guard_workspace_invitation_transition() FROM PUBLIC;
            """);

    private static void ProtectInvitationHistory(Action<string> emit) =>
        emit($"""
            ALTER TABLE workspace_invitation ENABLE ROW LEVEL SECURITY;
            ALTER TABLE workspace_invitation FORCE ROW LEVEL SECURITY;
            CREATE POLICY workspace_invitation_tenant_isolation ON workspace_invitation
                USING (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid)
                WITH CHECK (tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid);
            REVOKE ALL ON workspace_invitation FROM PUBLIC;
            REVOKE ALL ON workspace_invitation FROM {ApplicationRole};
            GRANT SELECT, INSERT, UPDATE ON workspace_invitation TO {ApplicationRole};
            """);

    private static void ReplaceResolvers(Action<string> emit) =>
        emit($"""
            DROP FUNCTION IF EXISTS nix_resolve_principal(uuid, text);
            DROP FUNCTION IF EXISTS nix_resolve_identity_provider(text, text);
            DROP FUNCTION IF EXISTS nix_resolve_access_token(text);

            CREATE FUNCTION nix_resolve_identity_provider(p_issuer text, p_audience text)
            RETURNS TABLE (
                provider_id uuid,
                tenant_id uuid,
                issuer text,
                audience text,
                jwks_uri text,
                allowed_algorithms text[],
                jit_provisioning_enabled boolean,
                userinfo_uri text)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.provider_id, p.tenant_id, p.issuer, p.audience, p.jwks_uri,
                       p.allowed_algorithms, p.jit_provisioning_enabled, p.userinfo_uri
                  FROM identity_provider p
                 WHERE p.issuer = p_issuer AND p.audience = p_audience AND p.enabled
                 LIMIT 1
            $$;

            CREATE FUNCTION nix_resolve_external_principal(
                p_tenant_id uuid, p_external_issuer text, p_external_subject text)
            RETURNS TABLE (principal_id uuid, tenant_id uuid, status text, display_name text)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.principal_id, p.tenant_id, p.status, p.display_name
                  FROM principal p
                 WHERE p.tenant_id = p_tenant_id
                   AND p.external_issuer = p_external_issuer
                   AND p.external_subject = p_external_subject
                 LIMIT 1
            $$;

            CREATE FUNCTION nix_resolve_principal_by_id(p_tenant_id uuid, p_principal_id uuid)
            RETURNS TABLE (principal_id uuid, tenant_id uuid, status text, display_name text)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT p.principal_id, p.tenant_id, p.status, p.display_name
                  FROM principal p
                 WHERE p.tenant_id = p_tenant_id
                   AND p.principal_id = p_principal_id
                 LIMIT 1
            $$;

            CREATE FUNCTION nix_resolve_access_token(p_lookup text)
            RETURNS TABLE (
                token_id uuid, tenant_id uuid, principal_id uuid, principal_status text,
                secret_hash bytea, scopes text[], expires_at timestamptz, revoked_at timestamptz)
            LANGUAGE sql STABLE SECURITY DEFINER
            SET search_path = public, pg_temp
            AS $$
                SELECT t.token_id, t.tenant_id, t.principal_id, p.status, t.secret_hash,
                       t.scopes, t.expires_at, t.revoked_at
                  FROM personal_access_token t
                  JOIN principal p ON p.tenant_id = t.tenant_id
                                  AND p.principal_id = t.principal_id
                 WHERE t.lookup = p_lookup
                 LIMIT 1
            $$;

            REVOKE ALL ON FUNCTION nix_resolve_identity_provider(text, text) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_resolve_external_principal(uuid, text, text) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_resolve_principal_by_id(uuid, uuid) FROM PUBLIC;
            REVOKE ALL ON FUNCTION nix_resolve_access_token(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_resolve_identity_provider(text, text) TO {ApplicationRole};
            GRANT EXECUTE ON FUNCTION nix_resolve_external_principal(uuid, text, text) TO {ApplicationRole};
            GRANT EXECUTE ON FUNCTION nix_resolve_principal_by_id(uuid, uuid) TO {ApplicationRole};
            GRANT EXECUTE ON FUNCTION nix_resolve_access_token(text) TO {ApplicationRole};
            """);
}
