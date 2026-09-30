namespace Nix.Persistence.Migrations;

/// <summary>
/// Owner isolation for the three automation tables, the property-change feed, and the narrow
/// SECURITY DEFINER finders and purge the automation sources need (ADR-0051 section 6,
/// Amendment 4).
/// </summary>
/// <remarks>
/// <para>
/// <b>Principal-scoped, like <c>scheduled_trigger</c>.</b> A rule, its runs and its per-item
/// state are private to the rule's owner: nobody else in the tenant, workspace administrators
/// included, reads or writes them. Grants are stated here (<c>nix_app</c> full DML, nothing for
/// <c>nix_collab</c>) rather than inherited from default privileges.
/// </para>
/// <para>
/// <b>The property feed is a row trigger on <c>item</c>, not a queue consumer</b> (Amendment 4):
/// <c>item.changed</c> outbox events carry no before/after values and fan out on moves, RabbitMQ is
/// optional, and several writers bypass the command handlers. The trigger runs in the writer's own
/// transaction, so a rolled-back write enqueues nothing, and it reads the causation depth from the
/// transaction-local <c>nix.automation_depth</c> the executor sets while its actions run.
/// </para>
/// <para>
/// <b>Every SECURITY DEFINER function here sets <c>search_path = pg_catalog, public, pg_temp</c></b>
/// with <c>pg_temp</c> last and schema-qualifies every table it names: without <c>pg_temp</c>
/// listed, Postgres searches the caller's temporary schema first, so a caller could shadow
/// <c>item</c> or <c>scheduled_trigger</c> with a temporary table and have it read as the definer.
/// Like the scheduler's own functions, they cross row security only because they are owned by the
/// migrator role, which holds BYPASSRLS.
/// </para>
/// </remarks>
public static class AutomationSecuritySql
{
    private const string ApplicationRole = "nix_app";

    private static readonly string[] Tables = ["automation_rule", "automation_run", "automation_item_state"];

    /// <summary>Applies policies, grants, the property-change trigger, the finders and the purge.</summary>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        foreach (var table in Tables)
        {
            emit($"""
                ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
                ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
                CREATE POLICY {table}_owner ON {table}
                USING (
                    tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                    AND owner_principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                )
                WITH CHECK (
                    tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                    AND owner_principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                );

                REVOKE ALL ON {table} FROM PUBLIC;
                REVOKE ALL ON {table} FROM nix_collab;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ApplicationRole};
                """);
        }

        // The feed. Returns early for template rows and anything not active (a trash or restore is
        // a lifecycle change, never a property change a rule should see). One probe of
        // ix_automation_rule_property_watch per written row; a workspace with no property rules
        // pays that and nothing else. At most 50 rules per change, matching the per-owner ceiling.
        //
        // The dedupe key coalesces a burst on one item to one trigger per rule per UTC minute; the
        // executor re-reads the current value at fire time, so what fires is the latest value.
        // Past the depth bound (a change made by an automation's action made by an automation's
        // action) the rule is recorded as suppressed instead of being enqueued.
        emit("""
            CREATE OR REPLACE FUNCTION nix_enqueue_automation_property_changes()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_setting text := current_setting('nix.automation_depth', true);
                v_depth integer := 0;
                v_now timestamptz := clock_timestamp();
                v_minute text := to_char(v_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI');
            BEGIN
                IF NEW.template_id IS NOT NULL OR NEW.lifecycle_state <> 'active' THEN
                    RETURN NULL;
                END IF;

                IF v_setting IS NOT NULL AND v_setting <> '' AND pg_input_is_valid(v_setting, 'smallint') THEN
                    v_depth := GREATEST(v_setting::smallint, 0);
                END IF;

                IF v_depth > 1 THEN
                    INSERT INTO public.automation_run
                        (tenant_id, id, rule_id, owner_principal_id, workspace_id, item_id, trigger_key,
                         origin, depth, status, detail, created_at)
                    SELECT NEW.tenant_id, gen_random_uuid(), matched.id, matched.owner_principal_id,
                           matched.workspace_id, NEW.id,
                           'auto:' || matched.id::text || ':p' || v_depth::text || ':' || NEW.id::text || ':' || v_minute,
                           'property', v_depth, 'suppressed', '{"reason":"chain_depth"}'::jsonb, v_now
                      FROM (
                          SELECT r.id, r.owner_principal_id, r.workspace_id
                            FROM public.automation_rule r
                           WHERE r.tenant_id = NEW.tenant_id
                             AND r.workspace_id = NEW.workspace_id
                             AND r.enabled
                             AND r.trigger_type = 'property_changed'
                             AND (OLD.properties -> r.watch_key) IS DISTINCT FROM (NEW.properties -> r.watch_key)
                             AND (NOT (r.trigger ? 'to')
                                  OR COALESCE(NEW.properties -> r.watch_key, 'null'::jsonb) = COALESCE(r.trigger -> 'to' -> 'value', 'null'::jsonb))
                             AND (NOT (r.trigger ? 'from')
                                  OR COALESCE(OLD.properties -> r.watch_key, 'null'::jsonb) = COALESCE(r.trigger -> 'from' -> 'value', 'null'::jsonb))
                             AND (r.scope_item_id IS NULL OR EXISTS (
                                  SELECT 1
                                    FROM public.item_closure edge
                                   WHERE edge.tenant_id = NEW.tenant_id
                                     AND edge.ancestor_id = r.scope_item_id
                                     AND edge.descendant_id = NEW.id))
                           ORDER BY r.id
                           LIMIT 50
                      ) matched
                    ON CONFLICT (tenant_id, rule_id, trigger_key) DO NOTHING;
                    RETURN NULL;
                END IF;

                INSERT INTO public.scheduled_trigger
                    (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                     fire_at, dedupe_key, status, attempts, created_at, updated_at)
                SELECT NEW.tenant_id, gen_random_uuid(), matched.workspace_id, matched.owner_principal_id,
                       'automation', 'automation.property', NEW.id, matched.id, v_now,
                       'auto:' || matched.id::text || ':p' || v_depth::text || ':' || NEW.id::text || ':' || v_minute,
                       'pending', 0, v_now, v_now
                  FROM (
                      SELECT r.id, r.owner_principal_id, r.workspace_id
                        FROM public.automation_rule r
                       WHERE r.tenant_id = NEW.tenant_id
                         AND r.workspace_id = NEW.workspace_id
                         AND r.enabled
                         AND r.trigger_type = 'property_changed'
                         AND (OLD.properties -> r.watch_key) IS DISTINCT FROM (NEW.properties -> r.watch_key)
                         AND (NOT (r.trigger ? 'to')
                              OR COALESCE(NEW.properties -> r.watch_key, 'null'::jsonb) = COALESCE(r.trigger -> 'to' -> 'value', 'null'::jsonb))
                         AND (NOT (r.trigger ? 'from')
                              OR COALESCE(OLD.properties -> r.watch_key, 'null'::jsonb) = COALESCE(r.trigger -> 'from' -> 'value', 'null'::jsonb))
                         AND (r.scope_item_id IS NULL OR EXISTS (
                              SELECT 1
                                FROM public.item_closure edge
                               WHERE edge.tenant_id = NEW.tenant_id
                                 AND edge.ancestor_id = r.scope_item_id
                                 AND edge.descendant_id = NEW.id))
                       ORDER BY r.id
                       LIMIT 50
                  ) matched
                ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING;
                RETURN NULL;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_enqueue_automation_property_changes() FROM PUBLIC;

            CREATE TRIGGER item_automation_property_changed
                AFTER UPDATE OF properties ON item
                FOR EACH ROW
                WHEN (OLD.properties IS DISTINCT FROM NEW.properties)
                EXECUTE FUNCTION nix_enqueue_automation_property_changes();
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_planned_automation_rules(
                p_limit integer, p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                rule_id uuid,
                workspace_id uuid,
                owner_principal_id uuid,
                trigger_type text,
                trigger_json text,
                scope_item_id uuid)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid planned-automation limit';
                END IF;

                RETURN QUERY
                SELECT r.tenant_id, r.id, r.workspace_id, r.owner_principal_id,
                       r.trigger_type::text, r.trigger::text, r.scope_item_id
                  FROM public.automation_rule r
                 WHERE r.enabled
                   AND r.trigger_type IN ('schedule', 'date_arrives')
                   AND r.id > COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000')
                 ORDER BY r.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_planned_automation_rules(integer, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_planned_automation_rules(integer, uuid) TO {{ApplicationRole}};
            """);

        // One date rule's candidates. The key, workspace and scope come from the rule row itself,
        // never from the caller. due_date uses the text range over ix_item_due_day; any other key
        // is a text range over the property's own leading ISO date inside the rule's workspace,
        // padded a day before and two after for any UTC offset, then kept only when it parses.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_automation_date_candidates(
                p_tenant_id uuid, p_rule_id uuid, p_from date, p_to date, p_limit integer,
                p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (item_id uuid, value_text text)
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_key text;
                v_workspace uuid;
                v_scope uuid;
                v_from_text text;
                v_to_text text;
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid automation date-candidate limit';
                END IF;
                IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
                    RAISE EXCEPTION 'invalid automation date-candidate window';
                END IF;

                SELECT r.trigger ->> 'key', r.workspace_id, r.scope_item_id
                  INTO v_key, v_workspace, v_scope
                  FROM public.automation_rule r
                 WHERE r.tenant_id = p_tenant_id
                   AND r.id = p_rule_id
                   AND r.enabled
                   AND r.trigger_type = 'date_arrives';
                IF v_key IS NULL THEN
                    RETURN;
                END IF;

                IF v_key = 'due_date' THEN
                    v_from_text := to_char(p_from, 'YYYY-MM-DD');
                    v_to_text := to_char(p_to, 'YYYY-MM-DD');
                    -- Materialised on purpose: the window's due items come from one range scan
                    -- of ix_item_due_day, then are ordered by id for the keyset. Left to itself
                    -- the planner prefers walking the tenant's whole id index and filtering,
                    -- which reads every item that sorts before the 500th match.
                    RETURN QUERY
                    WITH due AS MATERIALIZED (
                        SELECT i.id, i.properties ->> 'due_date' AS value_text
                          FROM public.item i
                         WHERE i.tenant_id = p_tenant_id
                           AND i.lifecycle_state = 'active'
                           AND i.template_id IS NULL
                           AND i.due_day IS NOT NULL
                           AND i.due_day >= v_from_text
                           AND i.due_day <= v_to_text
                           AND i.workspace_id = v_workspace
                    )
                    SELECT due.id, due.value_text
                      FROM due
                     WHERE due.id > COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000')
                       AND (v_scope IS NULL OR EXISTS (
                            SELECT 1 FROM public.item_closure edge
                             WHERE edge.tenant_id = p_tenant_id
                               AND edge.ancestor_id = v_scope
                               AND edge.descendant_id = due.id))
                     ORDER BY due.id
                     LIMIT p_limit;
                    RETURN;
                END IF;

                v_from_text := to_char(p_from - 1, 'YYYY-MM-DD');
                v_to_text := to_char(p_to + 2, 'YYYY-MM-DD');
                RETURN QUERY
                SELECT candidate.id, candidate.value_text
                  FROM (
                      SELECT i.id, i.properties ->> v_key AS value_text
                        FROM public.item i
                       WHERE i.tenant_id = p_tenant_id
                         AND i.workspace_id = v_workspace
                         AND i.lifecycle_state = 'active'
                         AND i.template_id IS NULL
                         AND i.properties ? v_key
                         AND (i.properties ->> v_key) >= v_from_text
                         AND (i.properties ->> v_key) < v_to_text
                         AND i.id > COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000')
                         AND (v_scope IS NULL OR EXISTS (
                              SELECT 1 FROM public.item_closure edge
                               WHERE edge.tenant_id = p_tenant_id
                                 AND edge.ancestor_id = v_scope
                                 AND edge.descendant_id = i.id))
                  ) candidate
                 WHERE (length(candidate.value_text) = 10 AND nix_safe_date(candidate.value_text) IS NOT NULL)
                    OR nix_safe_timestamptz(split_part(candidate.value_text, '[', 1)) IS NOT NULL
                 ORDER BY candidate.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_automation_date_candidates(uuid, uuid, date, date, integer, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_automation_date_candidates(uuid, uuid, date, date, integer, uuid) TO {{ApplicationRole}};
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_purge_automation_runs(p_limit integer)
            RETURNS integer
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_deleted integer;
                v_now timestamptz := clock_timestamp();
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 10000 THEN
                    RAISE EXCEPTION 'invalid automation-run purge limit';
                END IF;

                WITH doomed AS (
                    SELECT run.tenant_id, run.id
                      FROM public.automation_run run
                     WHERE run.created_at <= v_now - interval '30 days'
                     ORDER BY run.created_at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM public.automation_run target
                 USING doomed
                 WHERE target.tenant_id = doomed.tenant_id AND target.id = doomed.id;
                GET DIAGNOSTICS v_deleted = ROW_COUNT;
                RETURN v_deleted;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_purge_automation_runs(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_purge_automation_runs(integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>Removes the trigger, functions and policies this migration added.</summary>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DROP TRIGGER IF EXISTS item_automation_property_changed ON item;
            DROP FUNCTION IF EXISTS nix_enqueue_automation_property_changes();
            DROP FUNCTION IF EXISTS nix_purge_automation_runs(integer);
            DROP FUNCTION IF EXISTS nix_find_automation_date_candidates(uuid, uuid, date, date, integer, uuid);
            DROP FUNCTION IF EXISTS nix_find_planned_automation_rules(integer, uuid);
            """);
        foreach (var table in Tables)
        {
            emit($"DROP POLICY IF EXISTS {table}_owner ON {table};");
        }
    }
}
