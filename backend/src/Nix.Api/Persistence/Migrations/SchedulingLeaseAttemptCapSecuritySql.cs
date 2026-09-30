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
/// Every definer here pins <c>SET search_path = pg_catalog, public, pg_temp</c> (pg_temp last, so
/// a caller's temporary relation can never shadow one the definer means) and schema-qualifies the
/// relations it names. Also the first version to return <c>source</c> - the trigger's own <c>ITriggerSource.Name</c>
/// column, added alongside this delta in the same migration - since the dispatcher now resolves a
/// leased row's fire action by that name rather than by <c>kind</c>.
/// </remarks>
/// <remarks>
/// A new file rather than an edit to <see cref="SchedulingSecuritySql"/> itself: that file is
/// referenced by an already-generated migration, and changing what it emits would retroactively
/// change what that migration is recorded as having done. This one instead states the delta -
/// create the capped function, and replace the three-parameter one with a compatibility wrapper
/// over it - the same way <c>NotificationsHardeningSecuritySql</c> layers onto
/// <c>NotificationsSecuritySql</c>.
/// </remarks>
public static class SchedulingLeaseAttemptCapSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Creates the capped lease function and replaces the three-parameter one with a wrapper over
    /// it that a Core instance still running the previous build can call during a rolling deploy.
    /// </summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer);
            """);

        // The source-filtered lease's pending branch: due rows of the named sources in fire_at
        // order. Raw SQL rather than an EF index, like the item indexes the reminder finders read:
        // only this function uses it.
        emit("""
            CREATE INDEX ix_scheduled_trigger_pending_source_due
                ON scheduled_trigger (source, fire_at, id)
             WHERE status = 'pending';
            """);

        // p_sources limits leasing to the named sources; NULL leases every source. The dispatcher
        // leases the reminder sources first and then every source (ADR-0051 Amendment 4), so a
        // backlog of automation triggers can never hold a due reminder back; the compatibility
        // wrapper below uses it to lease only system.test.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_lease_due_triggers(
                p_limit integer, p_owner text, p_lease_seconds integer, p_max_attempts integer,
                p_sources text[] DEFAULT NULL)
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
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
                v_ids uuid[];
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
                UPDATE public.scheduled_trigger AS dead
                   SET status = 'skipped',
                       lease_owner = NULL,
                       lease_until = NULL,
                       detail = '{"reason":"lease_expired_at_attempt_cap"}'::jsonb,
                       updated_at = v_now
                 WHERE dead.id IN (
                     SELECT locked.id
                       FROM public.scheduled_trigger locked
                      WHERE locked.status = 'leased'
                        AND locked.lease_until <= v_now
                        AND locked.attempts >= p_max_attempts
                        FOR UPDATE SKIP LOCKED
                 );

                -- Two index-ordered branches, never one OR: pending rows due now, and leases that
                -- expired under a process that died. "status = 'pending' OR (status = 'leased'
                -- AND ...)" cannot be read in fire_at order from any one index, so the planner
                -- sorted every due row to pick the first p_limit - 160 ms with a 320,000-row
                -- automation backlog. Each branch instead takes its own first p_limit in
                -- (fire_at, id) order, locking as it goes; the merge keeps the first p_limit of
                -- the two. With p_sources named (the dispatcher leases reminder sources before any
                -- other), the pending branch reads ix_scheduled_trigger_pending_source_due, so a
                -- backlog of other sources' rows is never walked. Branch by IF, not by
                -- "p_sources IS NULL OR ...", so each statement keeps its own plan.
                IF p_sources IS NULL THEN
                    SELECT array_agg(due.id ORDER BY due.fire_at, due.id)
                      INTO v_ids
                      FROM (
                          SELECT candidates.id, candidates.fire_at
                            FROM (
                                SELECT pending.id, pending.fire_at
                                  FROM (
                                      SELECT p.id, p.fire_at
                                        FROM public.scheduled_trigger p
                                       WHERE p.status = 'pending'
                                         AND p.fire_at <= v_now
                                       ORDER BY p.fire_at, p.id
                                       LIMIT p_limit
                                         FOR UPDATE SKIP LOCKED
                                  ) pending
                                UNION ALL
                                SELECT expired.id, expired.fire_at
                                  FROM (
                                      SELECT l.id, l.fire_at
                                        FROM public.scheduled_trigger l
                                       WHERE l.status = 'leased'
                                         AND l.fire_at <= v_now
                                         AND l.lease_until <= v_now
                                         -- Belt and braces alongside the finalize UPDATE above:
                                         -- an over-cap dead lease is already skipped, but
                                         -- restating the cap keeps this selection correct even
                                         -- if a future edit ever separates the two.
                                         AND l.attempts < p_max_attempts
                                       ORDER BY l.fire_at, l.id
                                       LIMIT p_limit
                                         FOR UPDATE SKIP LOCKED
                                  ) expired
                            ) candidates
                           ORDER BY candidates.fire_at, candidates.id
                           LIMIT p_limit
                      ) due;
                ELSE
                    SELECT array_agg(due.id ORDER BY due.fire_at, due.id)
                      INTO v_ids
                      FROM (
                          SELECT candidates.id, candidates.fire_at
                            FROM (
                                SELECT pending.id, pending.fire_at
                                  FROM (
                                      SELECT p.id, p.fire_at
                                        FROM public.scheduled_trigger p
                                       WHERE p.status = 'pending'
                                         AND p.source = ANY(p_sources)
                                         AND p.fire_at <= v_now
                                       ORDER BY p.fire_at, p.id
                                       LIMIT p_limit
                                         FOR UPDATE SKIP LOCKED
                                  ) pending
                                UNION ALL
                                SELECT expired.id, expired.fire_at
                                  FROM (
                                      SELECT l.id, l.fire_at
                                        FROM public.scheduled_trigger l
                                       WHERE l.status = 'leased'
                                         AND l.source = ANY(p_sources)
                                         AND l.fire_at <= v_now
                                         AND l.lease_until <= v_now
                                         AND l.attempts < p_max_attempts
                                       ORDER BY l.fire_at, l.id
                                       LIMIT p_limit
                                         FOR UPDATE SKIP LOCKED
                                  ) expired
                            ) candidates
                           ORDER BY candidates.fire_at, candidates.id
                           LIMIT p_limit
                      ) due;
                END IF;

                IF v_ids IS NULL THEN
                    RETURN;
                END IF;

                RETURN QUERY
                UPDATE public.scheduled_trigger AS candidate
                   SET status = 'leased',
                       lease_owner = p_owner,
                       lease_until = v_now + make_interval(secs => p_lease_seconds),
                       attempts = candidate.attempts + 1,
                       updated_at = v_now
                 WHERE candidate.id = ANY(v_ids)
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

            REVOKE ALL ON FUNCTION nix_lease_due_triggers(integer, text, integer, integer, text[]) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_due_triggers(integer, text, integer, integer, text[]) TO {{ApplicationRole}};
            """);

        // Rolling-deploy compatibility: a Core instance still on the previous build calls the
        // three-parameter overload, and dispatches by kind with no reminder source registered, so
        // it would lease every reminder row and finish it as skipped ("no_source_registered").
        // The wrapper therefore leases only the one source that build could fire (system.test,
        // never registered in production), with the same attempt cap as the current dispatcher
        // (ScheduleDispatcher.MaxAttempts), and returns that build's row shape. Once no instance
        // of the previous build can be running, a later migration can drop this overload.
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
            LANGUAGE sql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
                SELECT leased.tenant_id,
                       leased.id,
                       leased.workspace_id,
                       leased.principal_id,
                       leased.kind,
                       leased.source_item_id,
                       leased.rule_id,
                       leased.fire_at,
                       leased.dedupe_key,
                       leased.attempts
                  FROM public.nix_lease_due_triggers(p_limit, p_owner, p_lease_seconds, 5, ARRAY['system.test']) AS leased;
            $function$;

            REVOKE ALL ON FUNCTION nix_lease_due_triggers(integer, text, integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_lease_due_triggers(integer, text, integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Restores the original three-parameter lease function, without the attempt cap.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer);
            DROP FUNCTION IF EXISTS nix_lease_due_triggers(integer, text, integer, integer, text[]);
            DROP INDEX IF EXISTS ix_scheduled_trigger_pending_source_due;
            """);

        // Restores the function SchedulingSecuritySql.Apply creates - the same signature, row
        // shape and uncapped behaviour, so a rollback leaves callers exactly as that migration left
        // them - except that the restored definer keeps pg_temp last on its search_path and its
        // relations schema-qualified rather than reverting to the weaker original path.
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
            SET search_path = pg_catalog, public, pg_temp
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
                UPDATE public.scheduled_trigger AS candidate
                   SET status = 'leased',
                       lease_owner = p_owner,
                       lease_until = v_now + make_interval(secs => p_lease_seconds),
                       attempts = candidate.attempts + 1,
                       updated_at = v_now
                 WHERE candidate.id IN (
                     SELECT locked.id
                       FROM public.scheduled_trigger locked
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
