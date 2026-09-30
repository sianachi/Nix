namespace Nix.Persistence.Migrations;

/// <summary>
/// Narrow cross-tenant discovery for the three reminder sources (ADR-0051 section 4, lane B1):
/// explicit reminders, due tasks (plain and recurring, as two independently paged arms), and habit
/// check-in reminders. Each finder returns only ids, tenant/workspace/principal, and the scheduling
/// inputs a source needs to compute a fire instant - never a title or a body, which each source
/// re-reads (and re-verifies) at fire time under the recipient's own scoped session.
/// </summary>
/// <remarks>
/// <para>
/// Same shape as <see cref="SchedulingSecuritySql"/>'s lease function and
/// <see cref="Nix.Persistence.ObjectStorage.AbandonedObjectReapingSecuritySql"/>'s finder: owned
/// by the migrator role (BYPASSRLS is what crosses FORCE ROW LEVEL SECURITY, not SECURITY DEFINER
/// alone), <c>SET search_path = pg_catalog, public</c>, a bounded <c>LIMIT</c>, and
/// <c>REVOKE</c>/<c>GRANT</c> stated explicitly rather than inherited.
/// </para>
/// <para>
/// <b>Every value read out of a property bag is parsed defensively, never cast bare.</b>
/// <c>PropertyValidator</c> deliberately leaves a key alone that no schema declares (ADR-0007
/// section 4), so a member can PATCH <c>{"reminder":"whenever"}</c> or
/// <c>{"due_date":"soon"}</c> onto an item with no schema to refuse it. A bare <c>::timestamptz</c>
/// or <c>::date</c> cast on that value raises for the whole cross-tenant statement, taking down
/// planning for every tenant until the row is found and fixed. <c>nix_safe_timestamptz</c>,
/// <c>nix_safe_date</c> and <c>nix_safe_uuid</c> below return <c>NULL</c> on anything that will
/// not parse instead of raising. They test the input with <c>pg_input_is_valid</c> (Postgres 16)
/// rather than catching the cast's exception, so no row costs a subtransaction.
/// </para>
/// <para>
/// <b>Each due-task arm is one ordered index scan.</b> The plain arm walks
/// <c>ix_item_due_day_global</c> in <c>(due_day, id)</c> order from the window's first day (the
/// keyset is clamped to it, so a caller's "from the beginning" sentinel never walks history) to
/// its last, with <c>LIMIT</c> ending the scan. The recurring arm walks
/// <c>ix_item_recurs_global</c> in <c>id</c> order: a recurring item's anchor day says nothing
/// about whether it occurs in the window, so it has no useful day bound, and every live recurring
/// item is a candidate that the caller expands. Two arms, paged independently, is what keeps a
/// large recurring population from starving plain due items (or the reverse) and keeps each
/// page's cost bounded by the page, not by history.
/// </para>
/// <para>
/// <b>Every finder is paginated by keyset</b> (<c>p_after_*</c>, defaulted to the "everything"
/// value on a caller's first page) rather than a single 500-row cutoff: without it, once more
/// candidates exist globally than one page holds, whichever sort order the query happens to use
/// permanently starves every candidate that sorts after row 500.
/// </para>
/// <para>
/// <b>A batched preferences lookup</b> rather than each item finder joining
/// <c>principal_preferences</c> itself: planning needs a recipient's own zone, quiet hours and
/// reminder toggles to compute a fire instant, and <c>principal_preferences</c> carries
/// principal-scoped row security - a plan-time read with no session yet established cannot reach
/// it any other way. It takes <c>(tenant_id, principal_id)</c> pairs and joins on the table's full
/// key. Defaulted when a principal has never saved preferences: <c>UTC</c>, no quiet hours,
/// <c>09:00</c>, both reminder toggles on - the defaults ADR-0051 section 3 gives a fresh row.
/// </para>
/// <para>
/// <b>Recipient resolution happens here, not in each source.</b> A due task's recipient is the
/// principal named by <c>$due_set_by</c> and an explicit reminder's the one named by
/// <c>$reminder_set_by</c> - but only when that principal is <c>active</c> and belongs to the
/// item's own tenant; anything else (absent, malformed, another tenant's principal, suspended or
/// deprovisioned) falls back to the item's creator. Those keys are written only by the server, but
/// the join makes the rule hold even for a value that reached storage some other way. A habit's
/// recipient is its creator. Sources re-apply the same rule at fire time.
/// </para>
/// </remarks>
public static class ReminderSourceSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Creates the safe-parse helpers, the four item finders, the preferences batch lookup, and
    /// their supporting indexes.
    /// </summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        // STABLE: timestamptz and date input depend on the session's TimeZone and DateStyle, and
        // pg_input_is_valid is itself STABLE. None of these helpers appears in an index.
        //
        // Deliberately without SET search_path, unlike the SECURITY DEFINER finders: a SET clause
        // stops Postgres from inlining a SQL function, turning one expression into a separate
        // function call per row (measured on the plain and recurring due arms). They are safe
        // without it - they are not SECURITY DEFINER, and they name only pg_catalog objects,
        // which the search path always consults first unless it lists pg_catalog explicitly
        // later; their callers set search_path = pg_catalog, public themselves.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_timestamptz(p_text text)
            RETURNS timestamptz
            LANGUAGE sql
            STABLE
            AS $function$
                SELECT CASE WHEN pg_input_is_valid(p_text, 'timestamptz') THEN p_text::timestamptz END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_timestamptz(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_timestamptz(text) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_date(p_text text)
            RETURNS date
            LANGUAGE sql
            STABLE
            AS $function$
                SELECT CASE WHEN pg_input_is_valid(p_text, 'date') THEN p_text::date END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_date(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_date(text) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_uuid(p_text text)
            RETURNS uuid
            LANGUAGE sql
            STABLE
            AS $function$
                SELECT CASE WHEN pg_input_is_valid(p_text, 'uuid') THEN p_text::uuid END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_uuid(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_uuid(text) TO {{ApplicationRole}};
            """);

        // Indexes the raw text a reminder value is stored under, not a cast of it - the cast is
        // STABLE and cannot appear in an index expression, but the text itself is exactly what
        // PropertyValidator.CheckTimestamp already requires to start with an ISO instant, so a
        // text range against it is a real index condition, not merely a narrower heap filter.
        emit("""
            CREATE INDEX ix_item_reminder
                ON item ((properties ->> 'reminder'))
                WHERE properties ? 'reminder'
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);

        emit("""
            CREATE INDEX ix_item_habit_reminder
                ON item (id)
                WHERE properties ? '$habit_reminder_time'
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);

        // The plain due arm's index. Distinct from ix_item_due_day (TaskSemanticsSecuritySql):
        // that index leads with tenant_id because every other reader of it is scoped to one tenant
        // by row security, while this finder reads every tenant in one ordered scan. Recurring
        // items are excluded by the predicate (they have their own arm and index), and so are
        // completed ones: a finished task is most of a mature corpus's due items and never needs a
        // reminder, so leaving it out keeps a page's heap visits close to the rows it returns.
        // due_day stays text (TaskSemanticsSecuritySql), so the finder compares text ranges.
        emit("""
            CREATE INDEX ix_item_due_day_global
                ON item (due_day, id)
                WHERE lifecycle_state = 'active'
                  AND template_id IS NULL
                  AND due_day IS NOT NULL
                  AND recurrence IS NULL
                  AND COALESCE(properties ->> 'completion', '') <> 'true';
            """);

        // The recurring due arm's index: every live recurring item, in id order, across tenants.
        // ix_item_recurs (TaskSemanticsSecuritySql) leads with (tenant_id, workspace_id) for the
        // calendar's workspace-scoped walk and stays in use there.
        emit("""
            CREATE INDEX ix_item_recurs_global
                ON item (id)
                WHERE recurrence IS NOT NULL
                  AND lifecycle_state = 'active'
                  AND template_id IS NULL;
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_explicit_reminder_candidates(
                p_from timestamptz, p_to timestamptz, p_limit integer,
                p_after_at timestamptz DEFAULT '-infinity', p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                reminder_at timestamptz)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_from_text text := to_char(p_from - interval '1 day', 'YYYY-MM-DD');
                v_to_text text := to_char(p_to + interval '2 days', 'YYYY-MM-DD');
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid explicit-reminder candidate limit';
                END IF;
                IF p_from > p_to THEN
                    RAISE EXCEPTION 'invalid explicit-reminder candidate window';
                END IF;

                RETURN QUERY
                SELECT candidate.tenant_id,
                       candidate.id,
                       candidate.workspace_id,
                       -- Whoever set the reminder, only while that principal is active in the
                       -- item's own tenant; the creator otherwise.
                       COALESCE(setter.principal_id, candidate.created_by),
                       candidate.reminder_at
                  FROM (
                      SELECT i.tenant_id,
                             i.id,
                             i.workspace_id,
                             i.created_by,
                             i.properties ->> '$reminder_set_by' AS set_by_text,
                             -- The stored value is RFC 9557 - an offset-bearing instant plus a
                             -- bracketed zone name, e.g. 2026-03-17T09:00:00+00:00[Europe/London]
                             -- - and the bracket is what a timestamptz cast cannot parse.
                             -- split_part before the first '[' leaves the offset-bearing instant;
                             -- nix_safe_timestamptz returns NULL rather than raising when the
                             -- value is not one at all (an undeclared key can hold anything).
                             nix_safe_timestamptz(split_part(i.properties ->> 'reminder', '[', 1)) AS reminder_at
                        FROM item i
                       WHERE i.lifecycle_state = 'active'
                         AND i.template_id IS NULL
                         AND i.properties ? 'reminder'
                         -- Index condition: a text range against the stored value's own leading
                         -- ISO instant, padded a day on each side for any UTC offset.
                         AND (i.properties ->> 'reminder') >= v_from_text
                         AND (i.properties ->> 'reminder') < v_to_text
                  ) candidate
                  LEFT JOIN principal setter
                    ON setter.tenant_id = candidate.tenant_id
                   AND setter.principal_id = nix_safe_uuid(candidate.set_by_text)
                   AND setter.status = 'active'
                 WHERE candidate.reminder_at IS NOT NULL
                   AND candidate.reminder_at >= p_from
                   AND candidate.reminder_at < p_to
                   AND (candidate.reminder_at, candidate.id) > (p_after_at, p_after_id)
                 ORDER BY candidate.reminder_at, candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_explicit_reminder_candidates(timestamptz, timestamptz, integer, timestamptz, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_explicit_reminder_candidates(timestamptz, timestamptz, integer, timestamptz, uuid) TO {{ApplicationRole}};
            """);

        // The plain (non-recurring) due arm. The keyset is text, exactly the stored due_day, so a
        // malformed day that sorts inside the window pages past cleanly instead of being re-read;
        // such a row is returned with a NULL day, which the caller skips.
        //
        // Both due arms turn off sorts and bitmap scans for their own statement. Their filters
        // (the completion text, recurrence ->> 'until') have no statistics, so the planner
        // underestimates how many index rows survive them and, once a keyset page starts past the
        // middle of the index, prefers a bitmap scan of the whole remainder plus a sort over an
        // ordered scan that stops at LIMIT: measured on a 990k-item corpus, a middle recurring
        // page read 12,320 buffers that way against 635 as an ordered index scan. Each arm's
        // index returns rows in exactly the ORDER BY, so the ordered scan is always the right
        // plan and never needs either.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_due_reminder_candidates(
                p_from date, p_to date, p_limit integer,
                p_after_day text DEFAULT '', p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                due_day_text text,
                due_day date)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            SET enable_sort = off
            SET enable_bitmapscan = off
            AS $function$
            DECLARE
                v_from_text text := to_char(p_from, 'YYYY-MM-DD');
                v_to_text text := to_char(p_to, 'YYYY-MM-DD');
                v_after_text text := COALESCE(p_after_day, '');
                v_after_id uuid := COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000');
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid due-reminder candidate limit';
                END IF;
                IF p_from > p_to THEN
                    RAISE EXCEPTION 'invalid due-reminder candidate window';
                END IF;

                -- A keyset before the window starts at the window: without this clamp, a first
                -- page's sentinel makes the row comparison below the scan's only lower bound, and
                -- the ordered scan reads every due item in history before reaching the window.
                IF v_after_text < v_from_text THEN
                    v_after_text := v_from_text;
                    v_after_id := '00000000-0000-0000-0000-000000000000';
                END IF;

                RETURN QUERY
                SELECT i.tenant_id,
                       i.id,
                       i.workspace_id,
                       -- Whoever set the due date, only while that principal is active in the
                       -- item's own tenant; the creator otherwise.
                       COALESCE(setter.principal_id, i.created_by),
                       i.due_day,
                       nix_safe_date(i.due_day)
                  FROM item i
                  LEFT JOIN principal setter
                    ON setter.tenant_id = i.tenant_id
                   AND setter.principal_id = nix_safe_uuid(i.properties ->> '$due_set_by')
                   AND setter.status = 'active'
                 WHERE i.lifecycle_state = 'active'
                   AND i.template_id IS NULL
                   AND i.due_day IS NOT NULL
                   AND i.recurrence IS NULL
                   -- Compared as text, never cast, so a non-boolean value is simply "not
                   -- complete"; stated exactly as ix_item_due_day_global's predicate states it.
                   AND COALESCE(i.properties ->> 'completion', '') <> 'true'
                   AND (i.due_day, i.id) > (v_after_text, v_after_id)
                   AND i.due_day <= v_to_text
                 ORDER BY i.due_day, i.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_due_reminder_candidates(date, date, integer, text, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_due_reminder_candidates(date, date, integer, text, uuid) TO {{ApplicationRole}};
            """);

        // The recurring due arm. Anchor and `until` prune what cannot occur in the window; the
        // caller expands the rule and skips completed occurrences (a recurring item's completion
        // lives inside the rule, never in the completion property).
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_recurring_due_reminder_candidates(
                p_from date, p_to date, p_limit integer,
                p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                due_day date,
                recurrence text)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            SET enable_sort = off
            SET enable_bitmapscan = off
            AS $function$
            DECLARE
                v_from_text text := to_char(p_from, 'YYYY-MM-DD');
                v_to_text text := to_char(p_to, 'YYYY-MM-DD');
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid recurring due-reminder candidate limit';
                END IF;
                IF p_from > p_to THEN
                    RAISE EXCEPTION 'invalid recurring due-reminder candidate window';
                END IF;

                RETURN QUERY
                SELECT i.tenant_id,
                       i.id,
                       i.workspace_id,
                       COALESCE(setter.principal_id, i.created_by),
                       nix_safe_date(i.due_day),
                       i.recurrence::text
                  FROM item i
                  LEFT JOIN principal setter
                    ON setter.tenant_id = i.tenant_id
                   AND setter.principal_id = nix_safe_uuid(i.properties ->> '$due_set_by')
                   AND setter.status = 'active'
                 WHERE i.recurrence IS NOT NULL
                   AND i.lifecycle_state = 'active'
                   AND i.template_id IS NULL
                   AND i.id > COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000')
                   AND i.due_day IS NOT NULL
                   AND i.due_day <= v_to_text
                   AND (i.recurrence ->> 'until' IS NULL OR i.recurrence ->> 'until' >= v_from_text)
                 ORDER BY i.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_recurring_due_reminder_candidates(date, date, integer, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_recurring_due_reminder_candidates(date, date, integer, uuid) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_habit_reminder_candidates(
                p_limit integer, p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                settings text)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid habit-reminder candidate limit';
                END IF;

                RETURN QUERY
                SELECT i.tenant_id,
                       i.id,
                       i.workspace_id,
                       i.created_by,
                       -- Only the scheduling keys HabitSettings.Read needs. $habit_unit is
                       -- required by HabitSettings.Read (a habit with none fails to parse at
                       -- all) but its value is free text a person chose (such as "reps" or
                       -- "glasses of water") that a habit's schedule never depends on and nothing
                       -- this system shows to anyone but the recipient needs - so a fixed
                       -- placeholder satisfies the parser's requiredness without carrying the
                       -- real text across tenants.
                       jsonb_build_object(
                           '$habit_frequency', i.properties -> '$habit_frequency',
                           '$habit_weekdays', i.properties -> '$habit_weekdays',
                           '$habit_timezone', i.properties -> '$habit_timezone',
                           '$habit_start_date', i.properties -> '$habit_start_date',
                           '$habit_target', i.properties -> '$habit_target',
                           '$habit_unit', to_jsonb('unit'::text),
                           '$habit_reminder_time', i.properties -> '$habit_reminder_time'
                       )::text
                  FROM item i
                 WHERE i.lifecycle_state = 'active'
                   AND i.template_id IS NULL
                   AND i.properties ? '$habit_reminder_time'
                   AND i.id > p_after_id
                 ORDER BY i.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_habit_reminder_candidates(integer, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_habit_reminder_candidates(integer, uuid) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_reminder_preferences_for(p_tenant_ids uuid[], p_principal_ids uuid[])
            RETURNS TABLE (
                tenant_id uuid,
                principal_id uuid,
                time_zone text,
                quiet_start time,
                quiet_end time,
                due_reminder_time time,
                due_reminders boolean,
                habit_reminders boolean,
                muted_container_ids uuid[])
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                IF p_tenant_ids IS NULL OR p_principal_ids IS NULL
                    OR array_length(p_principal_ids, 1) IS NULL
                    OR array_length(p_principal_ids, 1) > 500
                    OR array_length(p_tenant_ids, 1) IS DISTINCT FROM array_length(p_principal_ids, 1) THEN
                    RAISE EXCEPTION 'invalid reminder-preferences principal batch';
                END IF;

                -- Defaulted rather than omitted for a principal with no saved row at all - the
                -- same defaults ADR-0051 section 3 gives a fresh principal_preferences row, so a
                -- source never has to special-case "never configured" separately from "configured
                -- with the defaults". Joined on the table's whole key, (tenant_id, principal_id).
                RETURN QUERY
                SELECT wanted.tenant_id,
                       wanted.principal_id,
                       COALESCE(preferences.time_zone, 'UTC')::text,
                       preferences.quiet_start,
                       preferences.quiet_end,
                       COALESCE(preferences.due_reminder_time, '09:00'::time),
                       COALESCE(preferences.due_reminders, true),
                       COALESCE(preferences.habit_reminders, true),
                       COALESCE(preferences.muted_container_ids, ARRAY[]::uuid[])
                  FROM unnest(p_tenant_ids, p_principal_ids) AS wanted(tenant_id, principal_id)
                  LEFT JOIN principal_preferences preferences
                    ON preferences.tenant_id = wanted.tenant_id
                   AND preferences.principal_id = wanted.principal_id;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_reminder_preferences_for(uuid[], uuid[]) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_reminder_preferences_for(uuid[], uuid[]) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the finders, the preferences batch lookup, the safe-parse helpers, and their supporting indexes.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_reminder_preferences_for(uuid[], uuid[]);
            DROP FUNCTION IF EXISTS nix_find_habit_reminder_candidates(integer, uuid);
            DROP FUNCTION IF EXISTS nix_find_recurring_due_reminder_candidates(date, date, integer, uuid);
            DROP FUNCTION IF EXISTS nix_find_due_reminder_candidates(date, date, integer, text, uuid);
            DROP FUNCTION IF EXISTS nix_find_explicit_reminder_candidates(timestamptz, timestamptz, integer, timestamptz, uuid);
            DROP INDEX IF EXISTS ix_item_recurs_global;
            DROP INDEX IF EXISTS ix_item_due_day_global;
            DROP INDEX IF EXISTS ix_item_habit_reminder;
            DROP INDEX IF EXISTS ix_item_reminder;
            DROP FUNCTION IF EXISTS nix_safe_uuid(text);
            DROP FUNCTION IF EXISTS nix_safe_date(text);
            DROP FUNCTION IF EXISTS nix_safe_timestamptz(text);
            """);
    }
}
