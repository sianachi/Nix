namespace Nix.Persistence.Migrations;

/// <summary>
/// Principal isolation for <c>scheduled_trigger</c>, and the four SECURITY DEFINER functions
/// (lease, finish, and two retention purges) that let the single Core-owned dispatcher and its
/// retention pass cross every tenant while every other reader stays confined to its own
/// principal's rows.
/// </summary>
/// <remarks>
/// The policy is the same fail-closed shape as <c>NotificationsSecuritySql</c>: a trigger is
/// derived, rebuildable planning state kept on the rule owner's behalf, so it gets exactly the
/// isolation their own inbox gets. The dispatcher's finder and finisher are the only cross-tenant
/// readers, exactly as <c>AbandonedObjectReapingSecuritySql</c> is for expiry; all four functions
/// cross tenants only because they are owned by the migrator role, which holds BYPASSRLS - not
/// because SECURITY DEFINER exempts them from FORCE ROW LEVEL SECURITY on its own.
/// </remarks>
public static class SchedulingSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Applies the table policy, grants, and the lease/finish/retention functions.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            ALTER TABLE scheduled_trigger ENABLE ROW LEVEL SECURITY;
            ALTER TABLE scheduled_trigger FORCE ROW LEVEL SECURITY;
            CREATE POLICY scheduled_trigger_owner ON scheduled_trigger
            USING (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            )
            WITH CHECK (
                tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
            );

            REVOKE ALL ON scheduled_trigger FROM PUBLIC;
            GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_trigger TO {{ApplicationRole}};
            """.Replace("{{ApplicationRole}}", ApplicationRole, StringComparison.Ordinal));

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_lease_due_triggers(p_limit integer, p_owner text, p_lease_seconds integer)
            RETURNS TABLE (
                tenant_id uuid,
                id uuid,
                workspace_id uuid,
                principal_id uuid,
                kind text,
                source_item_id uuid,
                rule_id uuid,
                fire_at timestamptz,
                dedupe_key text,
                attempts integer)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 100 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger lease limit';
                END IF;
                IF p_lease_seconds NOT BETWEEN 5 AND 300 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger lease duration';
                END IF;
                IF p_owner IS NULL OR length(p_owner) = 0 OR length(p_owner) > 128 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger lease owner';
                END IF;

                RETURN QUERY
                UPDATE scheduled_trigger AS candidate
                   SET status = 'leased',
                       lease_owner = p_owner,
                       lease_until = v_now + make_interval(secs => p_lease_seconds),
                       attempts = candidate.attempts + 1,
                       updated_at = v_now
                 WHERE candidate.id IN (
                     SELECT locked.id
                       FROM scheduled_trigger locked
                      WHERE locked.fire_at <= v_now
                        AND (
                            locked.status = 'pending'
                            OR (locked.status = 'leased' AND locked.lease_until <= v_now)
                        )
                      ORDER BY locked.fire_at, locked.id
                      LIMIT p_limit
                        FOR UPDATE SKIP LOCKED
                 )
                RETURNING
                    candidate.tenant_id,
                    candidate.id,
                    candidate.workspace_id,
                    candidate.principal_id,
                    candidate.kind::text,
                    candidate.source_item_id,
                    candidate.rule_id,
                    candidate.fire_at,
                    candidate.dedupe_key::text,
                    candidate.attempts;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_lease_due_triggers(integer, text, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_due_triggers(integer, text, integer) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_finish_trigger(
                p_tenant_id uuid, p_id uuid, p_owner text, p_status text, p_detail jsonb)
            RETURNS boolean
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_updated integer;
            BEGIN
                IF p_status NOT IN ('fired', 'skipped', 'pending') THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger finish status';
                END IF;
                IF p_owner IS NULL OR length(p_owner) = 0 OR length(p_owner) > 128 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger lease owner';
                END IF;

                UPDATE scheduled_trigger
                   SET status = p_status,

                       -- Cleared for every outcome, including a retry sent back to pending:
                       -- "leased" is the only status a live lease belongs to, and a pending row
                       -- with a stale owner and expiry would misreport what actually holds it.
                       lease_owner = NULL,
                       lease_until = NULL,
                       detail = p_detail,
                       updated_at = clock_timestamp()
                 WHERE tenant_id = p_tenant_id
                   AND id = p_id
                   AND status = 'leased'
                   AND lease_owner = p_owner;
                GET DIAGNOSTICS v_updated = ROW_COUNT;
                RETURN v_updated = 1;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_finish_trigger(uuid, uuid, text, text, jsonb) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_finish_trigger(uuid, uuid, text, text, jsonb) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_purge_finished_triggers(p_limit integer)
            RETURNS integer
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_deleted integer;
                v_now timestamptz := clock_timestamp();
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 10000 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger purge limit';
                END IF;

                WITH doomed AS (
                    SELECT tenant_id, id
                      FROM scheduled_trigger
                     WHERE status IN ('fired', 'skipped', 'cancelled')
                       AND updated_at <= v_now - interval '30 days'
                     ORDER BY updated_at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM scheduled_trigger t
                 USING doomed
                 WHERE t.tenant_id = doomed.tenant_id AND t.id = doomed.id;
                GET DIAGNOSTICS v_deleted = ROW_COUNT;
                RETURN v_deleted;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_purge_finished_triggers(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_purge_finished_triggers(integer) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_purge_old_notifications(p_limit integer)
            RETURNS integer
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_deleted integer;
                v_now timestamptz := clock_timestamp();
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 10000 THEN
                    RAISE EXCEPTION 'invalid notification purge limit';
                END IF;

                -- The migrator role's BYPASSRLS is what lets this cross every principal, not
                -- SECURITY DEFINER by itself: FORCE ROW LEVEL SECURITY binds even a table's owner,
                -- and these functions are owned by the migrator, which holds BYPASSRLS. Retention
                -- is the one legitimate cross-principal writer, exactly as the trigger purge above
                -- is for scheduled_trigger.
                WITH doomed AS (
                    SELECT tenant_id, id
                      FROM notification
                     WHERE created_at <= v_now - interval '90 days'
                     ORDER BY created_at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM notification n
                 USING doomed
                 WHERE n.tenant_id = doomed.tenant_id AND n.id = doomed.id;
                GET DIAGNOSTICS v_deleted = ROW_COUNT;
                RETURN v_deleted;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_purge_old_notifications(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_purge_old_notifications(integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the policy, grants, and functions this migration added.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_purge_old_notifications(integer);
            DROP FUNCTION IF EXISTS nix_purge_finished_triggers(integer);
            DROP FUNCTION IF EXISTS nix_finish_trigger(uuid, uuid, text, text, jsonb);
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer);
            """);
    }
}
