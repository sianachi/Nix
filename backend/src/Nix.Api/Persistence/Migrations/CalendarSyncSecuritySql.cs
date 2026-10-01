namespace Nix.Persistence.Migrations;

/// <summary>
/// Owner isolation for the four calendar sync tables, the dirty feed, and the narrow SECURITY
/// DEFINER finder and purge the calendar sources need (ADR-0052, Amendment 1).
/// </summary>
/// <remarks>
/// <para>
/// <b>Principal-scoped, like the automation tables.</b> A connection holds its owner's OAuth
/// tokens; a link, its event map and its log are the owner's private sync state. Every table
/// carries <c>principal_id</c> so the policy needs no join, and nobody else in the tenant,
/// workspace administrators included, reads or writes them. Grants are stated here
/// (<c>nix_app</c> full DML, nothing for <c>nix_collab</c>) rather than inherited.
/// </para>
/// <para>
/// <b>The dirty feed is a row trigger on <c>item</c></b> (Amendment 1 A5), for the same reasons
/// as the automation property feed: <c>item.changed</c> carries no payload, RabbitMQ is optional,
/// and several writers bypass the command handlers. It runs in the writer's own transaction, so a
/// rolled-back write marks nothing, and it returns at once while the transaction-local
/// <c>nix.calendar_sync_link</c> is set - the pull path's own writes never echo back as pushes.
/// Its trigger fires on the trailing edge of the write's minute, so every write of a burst is in
/// place before the round it causes runs.
/// </para>
/// <para>
/// <b>Every SECURITY DEFINER function here sets <c>search_path = pg_catalog, public, pg_temp</c></b>,
/// schema-qualifies every relation, and is revoked from PUBLIC. They cross row security only
/// because the migrator role that owns them holds BYPASSRLS.
/// </para>
/// </remarks>
public static class CalendarSyncSecuritySql
{
    private const string ApplicationRole = "nix_app";

    private static readonly string[] Tables = ["calendar_connection", "calendar_link", "calendar_event_map", "calendar_sync_log"];

    /// <summary>Applies policies, grants, the dirty feed, the finder and the purge.</summary>
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
                    AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                )
                WITH CHECK (
                    tenant_id = NULLIF(current_setting('nix.tenant_id', true), '')::uuid
                    AND principal_id = NULLIF(current_setting('nix.principal_id', true), '')::uuid
                );

                REVOKE ALL ON {table} FROM PUBLIC;
                REVOKE ALL ON {table} FROM nix_collab;
                GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {ApplicationRole};
                """);
        }

        // The planner's keyset over every active link whose connection is still active, across
        // tenants. Walks ix_calendar_link_active in id order; the connection probe is its primary
        // key.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_find_active_calendar_links(
                p_limit integer, p_after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000')
            RETURNS TABLE (
                tenant_id uuid,
                link_id uuid,
                workspace_id uuid,
                principal_id uuid,
                container_item_id uuid)
            LANGUAGE plpgsql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 500 THEN
                    RAISE EXCEPTION 'invalid calendar-link limit';
                END IF;

                RETURN QUERY
                SELECT l.tenant_id, l.id, l.workspace_id, l.principal_id, l.container_item_id
                  FROM public.calendar_link l
                  JOIN public.calendar_connection c
                    ON c.tenant_id = l.tenant_id AND c.id = l.connection_id
                 WHERE l.status = 'active'
                   AND c.status = 'active'
                   AND l.id > COALESCE(p_after_id, '00000000-0000-0000-0000-000000000000')
                 ORDER BY l.id
                 LIMIT p_limit;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_find_active_calendar_links(integer, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_find_active_calendar_links(integer, uuid) TO {{ApplicationRole}};
            """);

        // The dirty feed. At most two probes of ux_calendar_link_container per written row (the new
        // parent and, for a move, the old one); a container with no active two-way link pays that
        // and nothing else. The dedupe key coalesces a burst on one link to one trigger per UTC
        // minute, fired at the start of the next minute.
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_mark_calendar_link_dirty()
            RETURNS trigger
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_now timestamptz := clock_timestamp();
                v_minute text := to_char(v_now AT TIME ZONE 'UTC', 'YYYYMMDDHH24MI');
                v_fire_at timestamptz := date_trunc('minute', v_now) + interval '1 minute';
                v_old_parent uuid;
            BEGIN
                IF NEW.template_id IS NOT NULL THEN
                    RETURN NULL;
                END IF;
                IF COALESCE(current_setting('nix.calendar_sync_link', true), '') <> '' THEN
                    RETURN NULL;
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    v_old_parent := OLD.parent_id;
                END IF;
                IF NEW.parent_id IS NULL AND v_old_parent IS NULL THEN
                    RETURN NULL;
                END IF;

                INSERT INTO public.scheduled_trigger
                    (tenant_id, id, workspace_id, principal_id, kind, source, source_item_id, rule_id,
                     fire_at, dedupe_key, status, attempts, created_at, updated_at)
                SELECT l.tenant_id, gen_random_uuid(), l.workspace_id, l.principal_id, 'calendar',
                       'calendar.dirty', l.container_item_id, l.id, v_fire_at,
                       'cal:d:' || l.id::text || ':' || v_minute, 'pending', 0, v_now, v_now
                  FROM public.calendar_link l
                 WHERE l.tenant_id = NEW.tenant_id
                   AND l.container_item_id IN (NEW.parent_id, v_old_parent)
                   AND l.status = 'active'
                   AND l.direction = 'two_way'
                 LIMIT 2
                ON CONFLICT (tenant_id, principal_id, dedupe_key) DO NOTHING;
                RETURN NULL;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_mark_calendar_link_dirty() FROM PUBLIC;

            CREATE TRIGGER item_calendar_link_dirty_insert
                AFTER INSERT ON item
                FOR EACH ROW
                WHEN (NEW.parent_id IS NOT NULL AND NEW.template_id IS NULL)
                EXECUTE FUNCTION nix_mark_calendar_link_dirty();

            CREATE TRIGGER item_calendar_link_dirty
                AFTER UPDATE OF properties, lifecycle_state, parent_id ON item
                FOR EACH ROW
                WHEN (NEW.template_id IS NULL
                      AND (OLD.properties IS DISTINCT FROM NEW.properties
                           OR OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
                           OR OLD.parent_id IS DISTINCT FROM NEW.parent_id))
                EXECUTE FUNCTION nix_mark_calendar_link_dirty();
            """);

        emit($$"""
            CREATE OR REPLACE FUNCTION nix_purge_calendar_sync_log(p_limit integer)
            RETURNS integer
            LANGUAGE plpgsql
            VOLATILE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_logs integer;
                v_tombstones integer;
                v_now timestamptz := clock_timestamp();
            BEGIN
                IF p_limit NOT BETWEEN 1 AND 10000 THEN
                    RAISE EXCEPTION 'invalid calendar-sync-log purge limit';
                END IF;

                WITH doomed AS (
                    SELECT entry.tenant_id, entry.id
                      FROM public.calendar_sync_log entry
                     WHERE entry.at < v_now - interval '30 days'
                     ORDER BY entry.at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM public.calendar_sync_log target
                 USING doomed
                 WHERE target.tenant_id = doomed.tenant_id AND target.id = doomed.id;
                GET DIAGNOSTICS v_logs = ROW_COUNT;

                WITH doomed AS (
                    SELECT map.tenant_id, map.id
                      FROM public.calendar_event_map map
                     WHERE map.deleted_at IS NOT NULL
                       AND map.deleted_at < v_now - interval '30 days'
                     ORDER BY map.deleted_at
                     LIMIT p_limit
                       FOR UPDATE SKIP LOCKED
                )
                DELETE FROM public.calendar_event_map target
                 USING doomed
                 WHERE target.tenant_id = doomed.tenant_id AND target.id = doomed.id;
                GET DIAGNOSTICS v_tombstones = ROW_COUNT;

                RETURN GREATEST(v_logs, v_tombstones);
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_purge_calendar_sync_log(integer) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_purge_calendar_sync_log(integer) TO {{ApplicationRole}};
            """);
    }

    /// <summary>
    /// Removes the triggers, functions and policies this migration added, and every scheduled
    /// trigger a calendar source planned or the feed enqueued.
    /// </summary>
    /// <remarks>
    /// Destructive by design: the migration's Down then drops the four tables, so every connection
    /// (and its tokens), link, map row and log row is lost. Items created by sync keep their
    /// <c>$cal_</c> keys.
    /// </remarks>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);
        emit("""
            DELETE FROM scheduled_trigger WHERE kind = 'calendar';
            DROP TRIGGER IF EXISTS item_calendar_link_dirty ON item;
            DROP TRIGGER IF EXISTS item_calendar_link_dirty_insert ON item;
            DROP FUNCTION IF EXISTS nix_mark_calendar_link_dirty();
            DROP FUNCTION IF EXISTS nix_purge_calendar_sync_log(integer);
            DROP FUNCTION IF EXISTS nix_find_active_calendar_links(integer, uuid);
            """);
        foreach (var table in Tables)
        {
            emit($"DROP POLICY IF EXISTS {table}_owner ON {table};");
        }
    }
}
