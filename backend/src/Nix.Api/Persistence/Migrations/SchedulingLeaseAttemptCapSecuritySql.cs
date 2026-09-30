namespace Nix.Persistence.Migrations;

/// <summary>
/// Replaces <c>nix_lease_due_triggers</c> with a version that also applies the attempt cap to a
/// lease that outlived its process (ADR-0051 Amendment 2, owed by lane B1): the original version
/// in <see cref="SchedulingSecuritySql"/> re-leases any row whose lease expired, with no bound on
/// how many times, if the dispatcher replica holding it dies before ever calling
/// <c>nix_finish_trigger</c>. The ordinary attempt cap only runs inside the dispatcher's own
/// failure handling, which never gets to run for a process that is no longer there.
/// </summary>
/// <remarks>
/// Also the first version to return <c>source</c> - the trigger's own <c>ITriggerSource.Name</c>
/// column, added alongside this delta in the same migration - since the dispatcher now resolves a
/// leased row's fire action by that name rather than by <c>kind</c>.
/// </remarks>
/// <remarks>
/// A new file rather than an edit to <see cref="SchedulingSecuritySql"/> itself: that file is
/// referenced by an already-generated migration, and changing what it emits would retroactively
/// change what that migration is recorded as having done. This one instead states the delta - drop
/// the three-parameter function, create the four-parameter one - the same way
/// <c>NotificationsHardeningSecuritySql</c> layers onto <c>NotificationsSecuritySql</c>.
/// </remarks>
public static class SchedulingLeaseAttemptCapSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Drops the three-parameter lease function and creates the capped, four-parameter one.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer);
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_lease_due_triggers(
                p_limit integer, p_owner text, p_lease_seconds integer, p_max_attempts integer)
            RETURNS TABLE (
                tenant_id uuid,
                id uuid,
                workspace_id uuid,
                principal_id uuid,
                kind text,
                source text,
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
                IF p_max_attempts NOT BETWEEN 1 AND 20 THEN
                    RAISE EXCEPTION 'invalid scheduled-trigger max attempts';
                END IF;

                -- A lease that outlived its process without ever reaching nix_finish_trigger sits
                -- past its lease_until forever otherwise, re-leased every pass with no cap ever
                -- applying to it. Finalizing it here, before candidates are chosen, is what
                -- ADR-0051 Amendment 2 owes lane B1.
                --
                -- Aliased, not bare: RETURNS TABLE(..., attempts integer, ...) below implicitly
                -- declares "attempts" as a PL/pgSQL variable in this function's own namespace, and
                -- an unqualified reference to it in a WHERE clause is ambiguous against the table
                -- column of the same name - exactly the trap the original query already avoids by
                -- aliasing every table it touches.
                -- SKIP LOCKED: a row a live replica is mid-finish on (holding its own row lock
                -- inside nix_finish_trigger's own UPDATE) must not block this pass waiting for
                -- it - this finalize is a courtesy for rows nothing is still working on, not a
                -- guarantee, and the next pass finds it whichever way that finish resolved.
                UPDATE scheduled_trigger AS dead
                   SET status = 'skipped',
                       lease_owner = NULL,
                       lease_until = NULL,
                       detail = '{"reason":"lease_expired_at_attempt_cap"}'::jsonb,
                       updated_at = v_now
                 WHERE dead.id IN (
                     SELECT locked.id
                       FROM scheduled_trigger locked
                      WHERE locked.status = 'leased'
                        AND locked.lease_until <= v_now
                        AND locked.attempts >= p_max_attempts
                        FOR UPDATE SKIP LOCKED
                 );

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
                            -- Belt and braces alongside the finalize UPDATE just above: that
                            -- UPDATE already flips an over-cap dead lease to skipped before this
                            -- runs, but restating the cap here means this candidate selection
                            -- stays correct even if a future edit ever separates the two.
                            OR (locked.status = 'leased' AND locked.lease_until <= v_now AND locked.attempts < p_max_attempts)
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
                    candidate.source::text,
                    candidate.source_item_id,
                    candidate.rule_id,
                    candidate.fire_at,
                    candidate.dedupe_key::text,
                    candidate.attempts;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_lease_due_triggers(integer, text, integer, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_due_triggers(integer, text, integer, integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Restores the original three-parameter lease function, without the attempt cap.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer, integer);
            """);

        // Restores exactly the function body SchedulingSecuritySql.Apply still creates today, so a
        // rollback leaves the database exactly as that migration left it.
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
    }
}
