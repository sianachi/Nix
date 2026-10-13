using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Nix.Persistence.Migrations.Generated;

/// <summary>
/// [SEC] Plugin item-metadata reads withhold items under a lock (plugin audit F1), without changing
/// the EF domain model.
/// </summary>
[DbContext(typeof(NixDbContext))]
[Migration("20261013200000_PluginMetadataLockFilter")]
public sealed class PluginMetadataLockFilter : Migration
{
    /// <inheritdoc />
    protected override void Up(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("""
            CREATE OR REPLACE FUNCTION nix_plugin_read_item_metadata(
                p_invocation_id uuid,
                p_item_id uuid)
            RETURNS TABLE (
                item_id uuid,
                workspace_id uuid,
                parent_id uuid,
                item_type text,
                title text,
                lifecycle_state text,
                last_modified_at timestamptz,
                causation_id uuid,
                causation_depth integer)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
                SELECT target.id,
                       target.workspace_id,
                       target.parent_id,
                       target.type,
                       left(target.properties ->> 'title', 512),
                       target.lifecycle_state,
                       target.last_modified_at,
                       invocation.causation_id,
                       invocation.causation_depth
                  FROM plugin_invocation AS invocation
                  JOIN plugin_event_inbox AS inbox
                    ON inbox.tenant_id = invocation.tenant_id
                   AND inbox.event_id = invocation.event_id
                   AND inbox.installation_id = invocation.installation_id
                   AND inbox.current_invocation_id = invocation.invocation_id
                   AND inbox.status = 'running'
                  JOIN plugin_installation AS installation
                    ON installation.tenant_id = invocation.tenant_id
                   AND installation.installation_id = invocation.installation_id
                   AND installation.enabled = true
                  JOIN plugin_capability_grant AS grant_row
                    ON grant_row.tenant_id = invocation.tenant_id
                   AND grant_row.installation_id = invocation.installation_id
                   AND grant_row.capability = 'items.read-metadata'
                  JOIN item AS target
                    ON target.tenant_id = invocation.tenant_id
                   AND target.workspace_id = invocation.workspace_id
                   AND target.id = p_item_id
                 WHERE invocation.invocation_id = p_invocation_id
                   AND invocation.status = 'running'
                   AND invocation.lease_until > clock_timestamp()
                   AND invocation.causation_depth BETWEEN 0 AND 4
                   -- A plugin holds no unlock, so every lock is closed to it: an item under one is
                   -- withheld, as every listing withholds it. The locked item itself still answers.
                   AND NOT EXISTS (
                       SELECT 1
                         FROM item_closure AS edge
                         JOIN item_lock AS locked
                           ON locked.tenant_id = edge.tenant_id
                          AND locked.item_id = edge.ancestor_id
                        WHERE edge.tenant_id = target.tenant_id
                          AND edge.descendant_id = target.id
                          AND edge.depth > 0)
                 LIMIT 1
            $function$;
            """);

    /// <inheritdoc />
    protected override void Down(MigrationBuilder migrationBuilder) =>
        migrationBuilder.Sql("""
            CREATE OR REPLACE FUNCTION nix_plugin_read_item_metadata(
                p_invocation_id uuid,
                p_item_id uuid)
            RETURNS TABLE (
                item_id uuid,
                workspace_id uuid,
                parent_id uuid,
                item_type text,
                title text,
                lifecycle_state text,
                last_modified_at timestamptz,
                causation_id uuid,
                causation_depth integer)
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $function$
                SELECT target.id,
                       target.workspace_id,
                       target.parent_id,
                       target.type,
                       left(target.properties ->> 'title', 512),
                       target.lifecycle_state,
                       target.last_modified_at,
                       invocation.causation_id,
                       invocation.causation_depth
                  FROM plugin_invocation AS invocation
                  JOIN plugin_event_inbox AS inbox
                    ON inbox.tenant_id = invocation.tenant_id
                   AND inbox.event_id = invocation.event_id
                   AND inbox.installation_id = invocation.installation_id
                   AND inbox.current_invocation_id = invocation.invocation_id
                   AND inbox.status = 'running'
                  JOIN plugin_installation AS installation
                    ON installation.tenant_id = invocation.tenant_id
                   AND installation.installation_id = invocation.installation_id
                   AND installation.enabled = true
                  JOIN plugin_capability_grant AS grant_row
                    ON grant_row.tenant_id = invocation.tenant_id
                   AND grant_row.installation_id = invocation.installation_id
                   AND grant_row.capability = 'items.read-metadata'
                  JOIN item AS target
                    ON target.tenant_id = invocation.tenant_id
                   AND target.workspace_id = invocation.workspace_id
                   AND target.id = p_item_id
                 WHERE invocation.invocation_id = p_invocation_id
                   AND invocation.status = 'running'
                   AND invocation.lease_until > clock_timestamp()
                   AND invocation.causation_depth BETWEEN 0 AND 4
                 LIMIT 1
            $function$;
            """);
}
