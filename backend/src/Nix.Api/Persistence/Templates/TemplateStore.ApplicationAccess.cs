using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Authorization;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Templates;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Templates;

public sealed partial class TemplateStore
{
    private async ValueTask<Result<bool>> RecheckApplicationResolutionAccessAsync(
        WorkspaceId workspaceId,
        string? storedResolutionJson,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(storedResolutionJson))
        {
            return Result.Success(true);
        }

        if (!TryReadStoredResolution(storedResolutionJson, out var stored) || stored is null)
        {
            return Result.Failure<bool>(TemplateErrors.Conflict(
                "The stored template application resolution is incomplete."));
        }

        var memberIds = new HashSet<Guid>();
        var itemIds = new HashSet<Guid>();
        foreach (var pair in stored.Resolution.InputTypes)
        {
            if (pair.Value is TemplateInitializationInputType.Text or TemplateInitializationInputType.Date)
            {
                continue;
            }

            if (pair.Value is not TemplateInitializationInputType.Member and not TemplateInitializationInputType.Item)
            {
                return Result.Failure<bool>(TemplateErrors.Conflict(
                    "The stored template application resolution contains an invalid input type."));
            }

            if (!stored.Resolution.Values.TryGetValue(pair.Key, out var value))
            {
                continue;
            }

            if (!Guid.TryParseExact(value, "D", out var id)
                || !string.Equals(value, id.ToString("D"), StringComparison.Ordinal))
            {
                return Result.Failure<bool>(TemplateErrors.Conflict(
                    "The stored template application resolution contains an invalid identifier."));
            }

            if (pair.Value == TemplateInitializationInputType.Member)
            {
                memberIds.Add(id);
            }
            else
            {
                itemIds.Add(id);
            }
        }

        foreach (var referencedId in stored.Resolution.ReferenceMappings.Values)
        {
            if (referencedId is { } id)
            {
                itemIds.Add(id);
            }
        }

        foreach (var initialized in stored.InitializationPreview)
        {
            if (!TryReadAssignee(initialized.Properties, out var assigneeId, out var hasAssignee))
            {
                return Result.Failure<bool>(TemplateErrors.Conflict(
                    "The stored template application contains an invalid assignee."));
            }

            if (hasAssignee)
            {
                memberIds.Add(assigneeId);
            }
        }

        if (memberIds.Count > 0)
        {
            var typedMemberIds = memberIds.Select(PrincipalId.From).ToHashSet();
            var activeMemberIds = await _database.Principals
                .AsNoTracking()
                .Where(principal => principal.TenantId == Context.TenantId
                    && typedMemberIds.Contains(principal.Id)
                    && principal.Status == PrincipalStatus.Active)
                .Select(principal => principal.Id)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            var directMemberIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == workspaceId
                    && member.SubjectType == SubjectType.Principal
                    && memberIds.Contains(member.SubjectId))
                .Select(member => member.SubjectId)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            var groupIds = await _database.WorkspaceMembers
                .AsNoTracking()
                .Where(member => member.TenantId == Context.TenantId
                    && member.WorkspaceId == workspaceId
                    && member.SubjectType == SubjectType.Group)
                .Select(member => member.SubjectId)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (groupIds.Length > 0 && activeMemberIds.Count > 0)
            {
                var typedGroupIds = groupIds.Select(PrincipalGroupId.From).ToHashSet();
                var groupMemberIds = await _database.GroupMemberships
                    .AsNoTracking()
                    .Where(membership => membership.TenantId == Context.TenantId
                        && typedGroupIds.Contains(membership.GroupId)
                        && activeMemberIds.Contains(membership.PrincipalId))
                    .Select(membership => membership.PrincipalId.Value)
                    .ToHashSetAsync(cancellationToken)
                    .ConfigureAwait(false);
                directMemberIds.UnionWith(groupMemberIds);
            }

            if (memberIds.Any(id => !activeMemberIds.Contains(PrincipalId.From(id))
                || !directMemberIds.Contains(id)))
            {
                return Result.Failure<bool>(TemplateErrors.Conflict(
                    "An initialization member or assignee is no longer active in this workspace."));
            }
        }

        if (itemIds.Count > 0)
        {
            var typedItemIds = itemIds.Select(ItemId.From).ToHashSet();
            var readableItemIds = await _database.Items
                .AsNoTracking()
                .Where(item => item.TenantId == Context.TenantId
                    && item.WorkspaceId == workspaceId
                    && item.TemplateId == null
                    && item.LifecycleState == ItemLifecycleState.Active
                    && typedItemIds.Contains(item.Id))
                .Select(item => item.Id)
                .ToHashSetAsync(cancellationToken)
                .ConfigureAwait(false);
            if (typedItemIds.Any(id => !readableItemIds.Contains(id)))
            {
                return Result.Failure<bool>(TemplateErrors.Conflict(
                    "An initialization item or retained body reference is no longer readable in this workspace."));
            }
        }

        return Result.Success(true);
    }
}
