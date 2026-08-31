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
    private async ValueTask<Result<TemplateStageSweepResult>> SweepExpiredBatchAsync(
        WorkspaceId workspaceId,
        TemplateOperationId? preferredOperationId,
        TemplateApplicationId? preferredApplicationId,
        CancellationToken cancellationToken)
    {
        if (!await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateStageSweepResult>(TemplateErrors.NotFound("No such workspace is visible."));
        }

        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        await LockWorkspaceTemplatesAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var now = _clock.GetUtcNow();
        var operationLimit = preferredApplicationId is null
            ? MaximumStageSweepEntries
            : MaximumStageSweepEntries - 1;
        var operations = await _database.TemplateOperations
            .AsTracking()
            .Where(operation => operation.WorkspaceId == workspaceId
                && (operation.State == TemplateOperationState.Aborted
                    || (operation.State == TemplateOperationState.Provisioning && operation.ExpiresAt <= now)))
            .OrderByDescending(operation => preferredOperationId != null && operation.Id == preferredOperationId)
            .ThenBy(operation => operation.ExpiresAt)
            .ThenBy(operation => operation.Id)
            .Take(operationLimit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var remaining = MaximumStageSweepEntries - operations.Count;
        var applications = remaining == 0
            ? []
            : await _database.TemplateApplications
                .AsTracking()
                .Where(application => application.WorkspaceId == workspaceId
                    && (application.State == TemplateOperationState.Aborted
                        || (application.State == TemplateOperationState.Provisioning
                            && application.ExpiresAt <= now)))
                .OrderByDescending(application => preferredApplicationId != null
                    && application.Id == preferredApplicationId)
                .ThenBy(application => application.ExpiresAt)
                .ThenBy(application => application.Id)
                .Take(remaining)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
        if (operations.Count == 0 && applications.Count == 0)
        {
            return Result.Success(new TemplateStageSweepResult(0, []));
        }

        var operationIds = operations.Select(operation => operation.Id).ToArray();
        var applicationIds = applications.Select(application => application.Id).ToArray();
        var applicationTemplateIds = applications.Select(application => application.TemplateId).Distinct().ToArray();
        var operationTargets = operationIds.Length == 0
            ? []
            : await _database.TemplateOperationItems
                .Where(mapping => operationIds.Contains(mapping.OperationId))
                .Select(mapping => mapping.TargetItemId)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
        var applicationTargets = applicationIds.Length == 0
            ? []
            : await _database.TemplateApplicationItems
                .Where(mapping => applicationIds.Contains(mapping.ApplicationId))
                .Select(mapping => mapping.TargetItemId)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
        var targets = operationTargets.Concat(applicationTargets).Distinct().ToArray();

        var templateIds = operations.Select(operation => operation.TemplateId).Distinct().ToArray();
        var catalogs = await _database.WorkspaceTemplates
            .AsTracking()
            .Where(template => templateIds.Contains(template.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var catalog in catalogs)
        {
            if (catalog.PendingRootItemId is { } pending && targets.Contains(pending))
            {
                catalog.PendingRootItemId = null;
            }

            if (catalog.RootItemId is null)
            {
                catalog.State = TemplateState.Provisioning;
            }
            catalog.LastModifiedAt = now;
            catalog.LastModifiedBy = Context.PrincipalId;
            AddAudit("template.staging_expired", catalog.Id.Value, workspaceId, now);
        }

        if (operationIds.Length > 0)
        {
            _database.TemplateOperations.RemoveRange(operations);
        }

        if (applicationIds.Length > 0)
        {
            _database.TemplateApplications.RemoveRange(applications);
        }

        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        ItemId[] removedTargets = [];
        if (targets.Length > 0)
        {
            var stagingTargets = await _database.Items.IgnoreQueryFilters()
                .Where(item => targets.Contains(item.Id)
                    && item.LifecycleState == ItemLifecycleState.Provisioning)
                .Select(item => item.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (stagingTargets.Length > 0)
            {
                removedTargets = stagingTargets;
                await _database.ItemClosure
                    .Where(edge => stagingTargets.Contains(edge.AncestorId)
                        || stagingTargets.Contains(edge.DescendantId))
                    .ExecuteDeleteAsync(cancellationToken)
                    .ConfigureAwait(false);
                await _database.Items.IgnoreQueryFilters()
                    .Where(item => stagingTargets.Contains(item.Id))
                    .ExecuteDeleteAsync(cancellationToken)
                    .ConfigureAwait(false);
            }
        }

        var emptyCatalogCandidates = catalogs.Where(catalog => catalog.RootItemId is null
            && catalog.PendingRootItemId is null).ToArray();
        var emptyCandidateIds = emptyCatalogCandidates.Select(catalog => catalog.Id).ToArray();
        var referencedCatalogIds = emptyCandidateIds.Length == 0
            ? []
            : (await _database.TemplateApplications
                    .Where(application => emptyCandidateIds.Contains(application.TemplateId))
                    .Select(application => application.TemplateId)
                    .Union(_database.TemplateOperations
                        .Where(operation => emptyCandidateIds.Contains(operation.TemplateId))
                        .Select(operation => operation.TemplateId))
                    .Distinct()
                    .ToArrayAsync(cancellationToken)
                    .ConfigureAwait(false))
                .ToHashSet();
        var emptyCatalogs = emptyCatalogCandidates
            .Where(catalog => !referencedCatalogIds.Contains(catalog.Id))
            .ToArray();
        if (emptyCatalogs.Length > 0)
        {
            _database.WorkspaceTemplates.RemoveRange(emptyCatalogs);
        }

        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        foreach (var templateId in applicationTemplateIds)
        {
            await DeleteRetiredTemplateRevisionsAsync(templateId, cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(new TemplateStageSweepResult(
            operations.Count + applications.Count,
            removedTargets));
    }

}
