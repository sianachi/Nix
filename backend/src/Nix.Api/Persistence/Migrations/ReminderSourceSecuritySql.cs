namespace Nix.Persistence.Migrations;

/// <summary>
/// Narrow cross-tenant discovery for the three reminder sources (ADR-0051 section 4, lane B1):
/// explicit reminders, due tasks (including recurring occurrences), and habit check-in reminders.
/// Each finder returns only ids, tenant/workspace/principal, and the scheduling inputs a source
/// needs to compute a fire instant - never a title or a body, which each source re-reads (and
/// re-verifies) at fire time under the recipient's own scoped session.
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
/// planning for every tenant until the row is found and fixed - the opposite of what a background
/// job's own data must never be able to do to another tenant's. <c>nix_safe_timestamptz</c>,
/// <c>nix_safe_date</c> and <c>nix_safe_uuid</c> below return <c>NULL</c> on anything that will
/// not parse instead of raising, and every finder filters that <c>NULL</c> out as it would any
/// other absent value.
/// </para>
/// <para>
/// <b>Every scan is index-condition-friendly, not just index-adjacent.</b> The finders compare
/// text ranges against the same lexicographically-ordered <c>yyyy-MM-dd[...]</c> prefixes the
/// stored values are written in - the same shape <c>RecurrenceSql</c> and <c>ix_item_due_day</c>
/// already rely on - rather than a cast, which is STABLE (timezone-dependent for a bare instant)
/// and therefore cannot appear in an index expression: Postgres requires IMMUTABLE. Only after
/// the text range has narrowed the scan does a row face the safe-cast.
/// </para>
/// <para>
/// <b>Every finder is paginated by keyset</b> (<c>p_after_*</c>, defaulted to the "everything"
/// value on a caller's first page) rather than a single 500-row cutoff: without it, once more
/// candidates exist globally than one page holds, whichever sort order the query happens to use
/// permanently starves every candidate that sorts after row 500 - a large recurring-item or
/// habit-reminder population in one tenant would silently turn reminders off for everyone whose
/// candidates sort later, forever, not just slowly.
/// </para>
/// <para>
/// <b>A fifth function batches principal preferences</b> rather than each item finder joining
/// <c>principal_preferences</c> itself three times over: planning needs a recipient's own zone,
/// quiet hours and reminder toggles to compute a fire instant, and <c>principal_preferences</c>
/// carries principal-scoped row security exactly like <c>scheduled_trigger</c> - a plan-time read
/// with no session yet established cannot reach it any other way. Defaulted when a principal has
/// never saved preferences (no row at all): <c>UTC</c>, no quiet hours, <c>09:00</c>, both
/// reminder toggles on - the same defaults ADR-0051 section 3 gives a fresh row.
/// </para>
/// <para>
/// <b>Recipient resolution happens here, not in each source.</b> A due task's recipient is
/// whoever set the due date (<c>$due_set_by</c>), falling back to the item's creator; an explicit
/// reminder's and a habit's recipient is simply the item's creator, since neither carries a
/// per-set-by attribution. Resolving it in SQL means a source's C# never has to know the fallback
/// rule exists.
/// </para>
/// </remarks>
public static class ReminderSourceSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>
    /// Creates the safe-parse helpers, the three item finders, the preferences batch lookup, and
    /// their supporting indexes.
    /// </summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        // STABLE, not IMMUTABLE: a bare ::timestamptz cast of text with no offset would depend on
        // the session's TimeZone GUC, so Postgres classifies the cast that way regardless of the
        // fact that every value this build ever writes for `reminder` carries an explicit offset.
        // Not usable in an index expression either way, which is why the index below is on the
        // raw text instead.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_timestamptz(p_text text)
            RETURNS timestamptz
            LANGUAGE plpgsql
            STABLE
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                RETURN p_text::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                RETURN NULL;
            END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_timestamptz(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_timestamptz(text) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_date(p_text text)
            RETURNS date
            LANGUAGE plpgsql
            IMMUTABLE
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                RETURN p_text::date;
            EXCEPTION WHEN OTHERS THEN
                RETURN NULL;
            END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_date(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_date(text) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_safe_uuid(p_text text)
            RETURNS uuid
            LANGUAGE plpgsql
            IMMUTABLE
            SET search_path = pg_catalog, public
            AS $function$
            BEGIN
                RETURN p_text::uuid;
            EXCEPTION WHEN OTHERS THEN
                RETURN NULL;
            END;
            $function$;

            REVOKE ALL ON FUNCTION nix_safe_uuid(text) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_safe_uuid(text) TO {{ApplicationRole}};
            """);

        // Indexes the raw text a reminder or habit-reminder-time value is stored under, not a
        // cast of it - the cast is STABLE and cannot appear in an index expression, but the text
        // itself is exactly what PropertyValidator.CheckTimestamp already requires to start with
        // an ISO instant, so a text range against it is a real index condition, not merely a
        // narrower heap filter.
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

        // Distinct from ix_item_due_day (TaskSemanticsSecuritySql): that index leads with
        // tenant_id because every other reader of it is scoped to one tenant by row security.
        // This finder is the one cross-tenant reader of due_day, so a tenant-prefixed index would
        // force it into one index scan per tenant instead of a single ordered scan across all of
        // them. due_day stays text (it always has - see TaskSemanticsSecuritySql), so the finder
        // below compares text ranges against it rather than casting.
        emit("""
            CREATE INDEX ix_item_due_day_global
                ON item (due_day, id)
                WHERE lifecycle_state = 'active'
                  AND template_id IS NULL
                  AND due_day IS NOT NULL;
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
                       candidate.created_by,
                       candidate.reminder_at
                  FROM (
                      SELECT i.tenant_id,
                             i.id,
                             i.workspace_id,
                             i.created_by,
                             i.properties ->> 'reminder' AS reminder_text,
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
                         -- ISO instant, padded a day on each side for any UTC offset - narrower
                         -- than "every item that ever had a reminder", which is what made this
                         -- finder cost grow with the reminder ever set rather than the window.
                         AND (i.properties ->> 'reminder') >= v_from_text
                         AND (i.properties ->> 'reminder') < v_to_text
                  ) candidate
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

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_due_reminder_candidates(
                p_from date, p_to date, p_limit integer,
                p_after_day date DEFAULT '0001-01-01', p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                item_id uuid,
                workspace_id uuid,
                principal_id uuid,
                due_day date,
                recurrence text,
                completed boolean)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public
            AS $function$
            DECLARE
                v_from_text text := to_char(p_from, 'YYYY-MM-DD');
                v_to_text text := to_char(p_to, 'YYYY-MM-DD');
                v_after_text text := to_char(p_after_day, 'YYYY-MM-DD');
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid due-reminder candidate limit';
                END IF;
                IF p_from > p_to THEN
                    RAISE EXCEPTION 'invalid due-reminder candidate window';
                END IF;

                RETURN QUERY
                SELECT candidate.tenant_id,
                       candidate.id,
                       candidate.workspace_id,
                       COALESCE(nix_safe_uuid(candidate.due_set_by_text), candidate.created_by),
                       candidate.safe_due_day,
                       candidate.recurrence,
                       -- A recurring item's completion lives inside the rule itself
                       -- (RecurrenceRule.CompletedThrough/Completed), never in this column - it is
                       -- meaningful here only for a plain, non-recurring due item. Compared as
                       -- text, never cast, so a non-boolean value here is simply "not true"
                       -- instead of raising.
                       COALESCE(candidate.completion_text = 'true', false)
                  FROM (
                      SELECT i.tenant_id,
                             i.id,
                             i.workspace_id,
                             i.created_by,
                             i.due_day,
                             i.recurrence::text AS recurrence,
                             i.properties ->> '$due_set_by' AS due_set_by_text,
                             i.properties ->> 'completion' AS completion_text,
                             nix_safe_date(i.due_day) AS safe_due_day
                        FROM item i
                       WHERE i.lifecycle_state = 'active'
                         AND i.template_id IS NULL
                         AND i.due_day IS NOT NULL
                         AND (i.due_day, i.id) > (v_after_text, p_after_id)
                         AND (
                             -- A plain due item: its one occurrence, as a text range against the
                             -- indexed column - an index condition, never a cast.
                             (i.recurrence IS NULL AND i.due_day >= v_from_text AND i.due_day <= v_to_text)
                             OR
                             -- A recurring item: its anchor must not be entirely after the window,
                             -- and its rule (if bounded) must not have ended entirely before it -
                             -- the same two-sided prune RecurrenceSql's own candidate statement
                             -- uses. `until` stays a heap filter (a jsonb read cannot be an index
                             -- condition under row security); the caller expands the actual
                             -- occurrences.
                             (i.recurrence IS NOT NULL
                              AND i.due_day <= v_to_text
                              AND (i.recurrence ->> 'until' IS NULL OR i.recurrence ->> 'until' >= v_from_text))
                         )
                       ORDER BY i.due_day, i.id
                       -- No LIMIT here: a malformed due_day that fails nix_safe_date must not
                       -- consume a page slot the outer LIMIT below would otherwise give to a real
                       -- candidate. The index condition above already bounds this scan to the
                       -- window; a row poisoned enough to fail nix_safe_date is rare, and the
                       -- ordering keeps the eventual outer LIMIT cheap regardless.
                  ) candidate
                 WHERE candidate.safe_due_day IS NOT NULL
                 ORDER BY candidate.due_day, candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_due_reminder_candidates(date, date, integer, date, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_due_reminder_candidates(date, date, integer, date, uuid) TO {{ApplicationRole}};
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
            CREATE OR REPLACE FUNCTION nix_reminder_preferences_for(p_principal_ids uuid[])
            RETURNS TABLE (
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
                IF p_principal_ids IS NULL OR array_length(p_principal_ids, 1) IS NULL
                    OR array_length(p_principal_ids, 1) > 500 THEN
                    RAISE EXCEPTION 'invalid reminder-preferences principal batch';
                END IF;

                -- Defaulted rather than omitted for a principal with no saved row at all - the
                -- same defaults ADR-0051 section 3 gives a fresh principal_preferences row, so a
                -- source never has to special-case "never configured" separately from "configured
                -- with the defaults".
                RETURN QUERY
                SELECT wanted.principal_id,
                       COALESCE(preferences.time_zone, 'UTC')::text,
                       preferences.quiet_start,
                       preferences.quiet_end,
                       COALESCE(preferences.due_reminder_time, '09:00'::time),
                       COALESCE(preferences.due_reminders, true),
                       COALESCE(preferences.habit_reminders, true),
                       COALESCE(preferences.muted_container_ids, ARRAY[]::uuid[])
                  FROM unnest(p_principal_ids) AS wanted(principal_id)
                  LEFT JOIN principal_preferences preferences
                    -- principal_id alone disambiguates: a Principal's identifier is a globally
                    -- unique Guid (Principal.cs), and tenant_id on this table exists for row
                    -- security partitioning, not to distinguish otherwise-colliding principals.
                    ON preferences.principal_id = wanted.principal_id;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_reminder_preferences_for(uuid[]) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_reminder_preferences_for(uuid[]) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the three finders, the preferences batch lookup, the safe-parse helpers, and their supporting indexes.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP FUNCTION IF EXISTS nix_reminder_preferences_for(uuid[]);
            DROP FUNCTION IF EXISTS nix_find_habit_reminder_candidates(integer, uuid);
            DROP FUNCTION IF EXISTS nix_find_due_reminder_candidates(date, date, integer, date, uuid);
            DROP FUNCTION IF EXISTS nix_find_explicit_reminder_candidates(timestamptz, timestamptz, integer, timestamptz, uuid);
            DROP INDEX IF EXISTS ix_item_due_day_global;
            DROP INDEX IF EXISTS ix_item_habit_reminder;
            DROP INDEX IF EXISTS ix_item_reminder;
            DROP FUNCTION IF EXISTS nix_safe_uuid(text);
            DROP FUNCTION IF EXISTS nix_safe_date(text);
            DROP FUNCTION IF EXISTS nix_safe_timestamptz(text);
            """);
    }
}
