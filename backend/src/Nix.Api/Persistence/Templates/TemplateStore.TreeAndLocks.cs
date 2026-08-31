using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Abstractions.Templates;
using Nix.Domain.Audit;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Npgsql;
using NpgsqlTypes;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    private Item CloneTemplateItem(
        Item source,
        TemplateId templateId,
        Guid sourceId,
        ItemId? parentId,
        ItemId targetId,
        bool isRoot,
        string? rootSchema,
        DateTimeOffset now) =>
        new()
        {
            Id = targetId,
            TenantId = Context.TenantId,
            WorkspaceId = source.WorkspaceId,
            Type = source.Type,
            ParentId = parentId,
            Seq = source.Seq,
            // The captured root is a reusable shape, not an accidental snapshot of the source
            // row's workspace-specific answers. Descendants are selected content and retain their
            // values; the root retains only its display title.
            Properties = isRoot
                ? ItemProperties.WithTitle(null, ItemProperties.ReadTitle(source.Properties))
                : source.Properties,
            Schema = isRoot && rootSchema is not null ? rootSchema : source.Schema,
            Views = source.Views,
            TemplateId = templateId,
            TemplateSourceId = sourceId,
            LifecycleState = ItemLifecycleState.Provisioning,
            CreatedBy = Context.PrincipalId,
            LastModifiedBy = Context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

    private Item CloneRegularItem(
        Item source,
        ItemId? parentId,
        ItemId targetId,
        string title,
        DateTimeOffset now) =>
        new()
        {
            Id = targetId,
            TenantId = Context.TenantId,
            WorkspaceId = source.WorkspaceId,
            Type = source.Type,
            ParentId = parentId,
            Seq = source.Seq,
            Properties = ItemProperties.WithTitle(source.Properties, title),
            Schema = source.Schema,
            Views = source.Views,
            LifecycleState = ItemLifecycleState.Provisioning,
            CreatedBy = Context.PrincipalId,
            LastModifiedBy = Context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

    private async ValueTask RebuildClosureAsync(
        IEnumerable<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.Select(id => id.Value).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return;
        }

        const string sql = """
            WITH RECURSIVE ancestry AS (
                SELECT item.tenant_id,
                       item.workspace_id,
                       item.id AS descendant_id,
                       item.id AS ancestor_id,
                       0 AS depth
                  FROM item
                 WHERE item.tenant_id = @tenant_id
                   AND item.id = ANY(@item_ids)

                UNION ALL

                SELECT ancestry.tenant_id,
                       ancestry.workspace_id,
                       ancestry.descendant_id,
                       parent.id,
                       ancestry.depth + 1
                  FROM ancestry
                  JOIN item current_item
                    ON current_item.tenant_id = ancestry.tenant_id
                   AND current_item.id = ancestry.ancestor_id
                  JOIN item parent
                    ON parent.tenant_id = current_item.tenant_id
                   AND parent.id = current_item.parent_id
            )
            INSERT INTO item_closure (tenant_id, workspace_id, ancestor_id, descendant_id, depth)
            SELECT tenant_id, workspace_id, ancestor_id, descendant_id, depth
              FROM ancestry
            ON CONFLICT (ancestor_id, descendant_id) DO NOTHING
            """;

        await _database.Database.ExecuteSqlRawAsync(
            sql,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids },
            ],
            cancellationToken).ConfigureAwait(false);
    }

    private ValueTask LockWorkspaceTemplatesAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        LockAsync($"template-workspace:{Context.TenantId.Value:N}:{workspaceId.Value:N}", cancellationToken);

    private ValueTask LockTemplateStagesAsync(CancellationToken cancellationToken) =>
        LockAsync($"template-stages:{Context.TenantId.Value:N}", cancellationToken);

    private ValueTask LockTemplateAsync(TemplateId templateId, CancellationToken cancellationToken) =>
        LockAsync($"template:{Context.TenantId.Value:N}:{templateId.Value:N}", cancellationToken);

    private ValueTask LockTemplateApplicationAsync(
        TemplateId templateId,
        ItemId targetItemId,
        CancellationToken cancellationToken) =>
        LockAsync(
            $"template-application:{Context.TenantId.Value:N}:{templateId.Value:N}:{targetItemId.Value:N}",
            cancellationToken);

    private ValueTask LockIdempotencyKeyAsync(string idempotencyKey, CancellationToken cancellationToken) =>
        LockAsync(
            $"template-idempotency:{Context.TenantId.Value:N}:{Context.PrincipalId.Value:N}:{idempotencyKey}",
            cancellationToken);

    private async ValueTask<bool> IdempotencyKeyBelongsElsewhereAsync(
        TemplateOperationKind expectedKind,
        string idempotencyKey,
        CancellationToken cancellationToken) =>
        await _database.TemplateApplications.AnyAsync(
            application => application.ActorId == Context.PrincipalId
                && application.IdempotencyKey == idempotencyKey,
            cancellationToken).ConfigureAwait(false)
        || await _database.TemplateOperations.AnyAsync(
            operation => operation.ActorId == Context.PrincipalId
                && operation.IdempotencyKey == idempotencyKey
                && operation.Kind != expectedKind,
            cancellationToken).ConfigureAwait(false);

    private async ValueTask LockAsync(string identity, CancellationToken cancellationToken)
    {
        const string sql = "SELECT pg_advisory_xact_lock(hashtextextended(@identity, 0));";
        await _database.Database.ExecuteSqlRawAsync(
            sql,
            [new NpgsqlParameter("identity", NpgsqlDbType.Text) { Value = identity }],
            cancellationToken).ConfigureAwait(false);
    }

}
