namespace Nix.Persistence.Migrations;

/// <summary>
/// The constraints on the item protection columns, and the backfill that puts existing calendar
/// links under them.
/// </summary>
/// <remarks>
/// <para>
/// Frozen to the migration that applies it. A later change writes a new file.
/// </para>
/// <para>
/// <b>No new row-security policy is owed.</b> The three columns land on <c>item</c>, which already
/// carries <c>item_tenant_isolation</c> with forced row security, and columns on a protected table
/// are protected by construction. <c>nix_collab</c> is granted nothing: a protection is about
/// structure, and the collaboration service does not create, move or delete items.
/// </para>
/// <para>
/// <b>The runtime role can write these columns, by the same default privileges as every other
/// item column.</b> What keeps a caller from clearing a system-held protection is Core's handler,
/// which is the one authority for every other permission too. The CHECK below is not that guard;
/// it only keeps the two columns from disagreeing about a managed item.
/// </para>
/// <para>
/// The backfill crosses tenants because the migrator role holds BYPASSRLS, like every backfill
/// before it.
/// </para>
/// </remarks>
public static class ItemProtectionSecuritySql
{
    private const string ApplicationRole = "nix_app";

    /// <summary>Emits the constraints and the backfill.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Apply(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("""
            ALTER TABLE item
                ADD CONSTRAINT ck_item_managed_by
                CHECK (managed_by IS NULL OR managed_by IN ('calendar', 'calendar_event')),
                ADD CONSTRAINT ck_item_managed_no_delete
                CHECK (managed_by IS NULL OR no_delete);
            """);

        // Links and pairings made before this migration: their containers and live mirrored events
        // come under the same protection a new link gives.
        emit("""
            UPDATE item
               SET managed_by = 'calendar', no_delete = true
              FROM calendar_link link
             WHERE item.tenant_id = link.tenant_id AND item.id = link.container_item_id;
            """);
        emit("""
            UPDATE item
               SET managed_by = 'calendar_event', no_delete = true
              FROM calendar_event_map map
             WHERE item.tenant_id = map.tenant_id
               AND item.id = map.item_id
               AND map.deleted_at IS NULL
               AND item.managed_by IS NULL;
            """);

        ApplyAdministratorUnlink(emit);
    }

    /// <summary>
    /// The one way anybody but a link's owner removes it: a workspace owner or tenant administrator
    /// unlinking a calendar somebody else linked into their workspace.
    /// </summary>
    /// <remarks>
    /// <para>
    /// SECURITY DEFINER because the calendar tables are private to the principal that owns the
    /// link, and the administrator is not that principal. It is narrow on purpose: it removes, it
    /// never reads a token or returns a row, and it cannot leave the caller's tenant - the tenant
    /// is taken from the session setting the unit of work set, never from an argument.
    /// </para>
    /// <para>
    /// <b>The function does not decide who may call it.</b> Core does, with
    /// <c>CanManageWorkspaceAsync</c>, before it calls; the runtime role reaching this function
    /// without that check would be Core itself misbehaving. The workspace is an argument only so
    /// a container in another workspace of the tenant cannot be named by mistake.
    /// </para>
    /// <para>
    /// <c>search_path</c> ends in <c>pg_temp</c> and every relation is schema-qualified, the rule
    /// every definer here follows since the temp-shadowing finding.
    /// </para>
    /// </remarks>
    private static void ApplyAdministratorUnlink(Action<string> emit) =>
        emit($$"""
            CREATE OR REPLACE FUNCTION nix_unlink_calendar_container(p_workspace_id uuid, p_container_item_id uuid)
            RETURNS boolean
            LANGUAGE plpgsql
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
            DECLARE
                v_tenant uuid := NULLIF(current_setting('nix.tenant_id', true), '')::uuid;
                v_link uuid;
            BEGIN
                IF v_tenant IS NULL THEN
                    RAISE EXCEPTION 'no tenant context';
                END IF;

                SELECT l.id INTO v_link
                  FROM public.calendar_link l
                 WHERE l.tenant_id = v_tenant
                   AND l.workspace_id = p_workspace_id
                   AND l.container_item_id = p_container_item_id
                   FOR UPDATE;
                IF v_link IS NULL THEN
                    RETURN false;
                END IF;

                UPDATE public.scheduled_trigger
                   SET status = 'cancelled', updated_at = now()
                 WHERE tenant_id = v_tenant AND kind = 'calendar' AND rule_id = v_link AND status = 'pending';

                UPDATE public.item
                   SET managed_by = NULL, no_delete = false
                 WHERE tenant_id = v_tenant
                   AND managed_by IS NOT NULL
                   AND ((id = p_container_item_id AND managed_by = 'calendar')
                        OR (managed_by = 'calendar_event'
                            AND (parent_id = p_container_item_id
                                 OR id IN (SELECT m.item_id FROM public.calendar_event_map m
                                            WHERE m.tenant_id = v_tenant AND m.link_id = v_link))));

                DELETE FROM public.calendar_link WHERE tenant_id = v_tenant AND id = v_link;
                RETURN true;
            END
            $function$;

            REVOKE ALL ON FUNCTION nix_unlink_calendar_container(uuid, uuid) FROM PUBLIC;
            GRANT EXECUTE ON FUNCTION nix_unlink_calendar_container(uuid, uuid) TO {{ApplicationRole}};
            """);

    /// <summary>Emits the reversal of <see cref="Apply"/>.</summary>
    /// <param name="emit">Receives each statement.</param>
    public static void Revert(Action<string> emit)
    {
        ArgumentNullException.ThrowIfNull(emit);

        emit("DROP FUNCTION IF EXISTS nix_unlink_calendar_container(uuid, uuid);");
        emit("""
            ALTER TABLE item
                DROP CONSTRAINT IF EXISTS ck_item_managed_no_delete,
                DROP CONSTRAINT IF EXISTS ck_item_managed_by;
            """);
    }
}
