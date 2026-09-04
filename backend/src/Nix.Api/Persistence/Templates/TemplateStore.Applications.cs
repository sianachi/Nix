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
    /// <summary>Stages an idempotent create or merge application.</summary>
    public async ValueTask<Result<TemplateApplicationPlan>> BeginApplicationAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        string? title,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var requestedTitle = title?.Trim();
        if (InvalidKey(idempotencyKey)
            || (mode == TemplateApplicationMode.Create
                && title is not null
                && (requestedTitle!.Length == 0 || requestedTitle.Length > 200)))
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(
                "An idempotency key and an optional create title of 1 to 200 characters are required."));
        }

        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        await SweepExpiredAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await LockTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await _database.TemplateOperations.AnyAsync(
            operation => operation.ActorId == Context.PrincipalId
                && operation.IdempotencyKey == idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateApplicationPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }
        await _database.Entry(template).ReloadAsync(cancellationToken).ConfigureAwait(false);
        if (template.State != TemplateState.Active || template.RootItemId is null)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        var existingApplication = await _database.TemplateApplications
            .FirstOrDefaultAsync(
                application => application.ActorId == Context.PrincipalId
                    && application.IdempotencyKey == idempotencyKey,
                cancellationToken)
            .ConfigureAwait(false);
        if (existingApplication is not null)
        {
            var effectiveTitle = requestedTitle ?? template.Title;
            if (existingApplication.TemplateId != templateId
                || existingApplication.Mode != mode
                || (mode == TemplateApplicationMode.Merge
                    && existingApplication.TargetItemId != targetItemId)
                || (mode == TemplateApplicationMode.Create
                    && (existingApplication.ParentItemId != parentItemId
                        || !string.Equals(
                            existingApplication.RequestedTitle,
                            effectiveTitle,
                            StringComparison.Ordinal))))
            {
                return Result.Failure<TemplateApplicationPlan>(
                    TemplateErrors.Conflict("This idempotency key belongs to a different template application."));
            }

            if (existingApplication.State == TemplateOperationState.Provisioning)
            {
                var destinationId = existingApplication.Mode == TemplateApplicationMode.Merge
                    ? existingApplication.TargetItemId
                    : existingApplication.ParentItemId;
                if (destinationId is { } requiredDestination)
                {
                    var destination = await LockRegularItemAsync(requiredDestination, cancellationToken)
                        .ConfigureAwait(false);
                    if (destination is null || destination.WorkspaceId != template.WorkspaceId)
                    {
                        return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Conflict(
                            "The destination for this template application was deleted or is no longer active."));
                    }
                }
            }

            return Result.Success((await ApplicationReplayAsync(idempotencyKey, cancellationToken)
                .ConfigureAwait(false))!);
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid("The template has no active root."));
        }
        if (ContainsFileItems(source))
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.FileAttachmentsUnsupported());
        }
        // Applying a captured template: its source came from a workspace, so it is tolerated the
        // same way it was at capture - a template that saved must be applyable.
        if (_validator.ValidateTemplateTree(source, tolerateViewDrift: true) is { } templateConflict)
        {
            return Result.Failure<TemplateApplicationPlan>(TemplateErrors.Invalid(templateConflict));
        }

        var rootSource = source[0];
        Item targetRoot;
        var now = _clock.GetUtcNow();
        if (mode == TemplateApplicationMode.Merge)
        {
            if (targetItemId is not { } existingId)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such target is visible."));
            }

            await LockTemplateApplicationAsync(templateId, existingId, cancellationToken).ConfigureAwait(false);
            var existing = await LockRegularItemAsync(existingId, cancellationToken).ConfigureAwait(false);
            if (existing is null || existing.WorkspaceId != template.WorkspaceId)
            {
                return Result.Failure<TemplateApplicationPlan>(TemplateErrors.NotFound("No such target is visible."));
            }

            targetRoot = existing;
        }
        else
        {
            if (parentItemId is { } parent)
            {
                var parentItem = await LockRegularItemAsync(parent, cancellationToken).ConfigureAwait(false);
                if (parentItem is null || parentItem.WorkspaceId != template.WorkspaceId)
                {
                    return Result.Failure<TemplateApplicationPlan>(
                        TemplateErrors.NotFound("No such destination is visible."));
                }
            }

            targetRoot = CloneRegularItem(
                rootSource,
                parentItemId,
                ItemId.Create(),
                requestedTitle ?? template.Title,
                now);
            _database.Items.Add(targetRoot);
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        TemplateMergePlan? mergePlan = null;
        if (mode == TemplateApplicationMode.Merge)
        {
            var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetRoot.Id, cancellationToken)
                .ConfigureAwait(false);
            mergePlan = _mergePlanner.Plan(
                targetRoot.Schema,
                rootSource.Schema,
                targetRoot.Views,
                rootSource.Views,
                effectiveTargetSchema);
            if (mergePlan.Conflicts.Count > 0)
            {
                return Result.Failure<TemplateApplicationPlan>(
                    TemplateErrors.Conflict(string.Join(" ", mergePlan.Conflicts)));
            }
        }

        var sourceBodies = await BodyItemIdsAsync(source.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var priorResult = mode == TemplateApplicationMode.Merge
            ? await PriorTargetMapAsync(
                templateId,
                targetRoot.Id,
                template.WorkspaceId,
                source.Select(item => item.TemplateSourceId!.Value).ToArray(),
                cancellationToken).ConfigureAwait(false)
            : Result.Success(new Dictionary<Guid, ItemId>());
        if (priorResult.IsFailure)
        {
            return Result.Failure<TemplateApplicationPlan>(priorResult.Error);
        }
        var prior = priorResult.Value;
        var targets = new Dictionary<Guid, ItemId>
        {
            [rootSource.TemplateSourceId!.Value] = targetRoot.Id,
        };
        foreach (var pair in prior)
        {
            targets[pair.Key] = pair.Value;
        }

        var applicationId = TemplateApplicationId.Create();
        var staged = new List<Item>();
        var mappings = new List<TemplateApplicationItem>(source.Count);
        foreach (var item in source)
        {
            var sourceId = item.TemplateSourceId!.Value;
            var isRoot = item.Id == rootSource.Id;
            var created = isRoot && mode == TemplateApplicationMode.Create;
            if (!targets.TryGetValue(sourceId, out var targetId))
            {
                var parentSource = source.Single(candidate => candidate.Id == item.ParentId);
                var parentTarget = targets[parentSource.TemplateSourceId!.Value];
                targetId = ItemId.Create();
                targets[sourceId] = targetId;
                staged.Add(CloneRegularItem(item, parentTarget, targetId, ItemProperties.ReadTitle(item.Properties), now));
                created = true;
            }

            var bodyRequired = sourceBodies.Contains(item.Id)
                && created
                && (!isRoot || mode == TemplateApplicationMode.Create);
            mappings.Add(new TemplateApplicationItem
            {
                ApplicationId = applicationId,
                TenantId = Context.TenantId,
                TemplateSourceId = sourceId,
                SourceItemId = item.Id,
                ItemType = item.Type,
                TargetItemId = targetId,
                IsRoot = isRoot,
                Created = created,
                BodyRequired = bodyRequired,
            });
        }

        if (staged.Count > 0)
        {
            _database.Items.AddRange(staged);
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        _database.TemplateApplications.Add(new TemplateApplication
        {
            Id = applicationId,
            TenantId = Context.TenantId,
            WorkspaceId = template.WorkspaceId,
            TemplateId = templateId,
            TargetItemId = targetRoot.Id,
            ParentItemId = mode == TemplateApplicationMode.Create ? parentItemId : null,
            RequestedTitle = mode == TemplateApplicationMode.Create ? requestedTitle ?? template.Title : null,
            Mode = mode,
            IdempotencyKey = idempotencyKey,
            ActorId = Context.PrincipalId,
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = now + StagingLifetime,
        });
        _database.TemplateApplicationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        if (staged.Count > 0 || mode == TemplateApplicationMode.Create)
        {
            await RebuildClosureAsync(
                staged.Select(item => item.Id).Append(targetRoot.Id),
                cancellationToken).ConfigureAwait(false);
        }

        var bodyCopies = mappings.Where(mapping => mapping.BodyRequired).Select(mapping =>
        {
            var sourceItem = source.Single(item => item.Id == mapping.SourceItemId);
            return new TemplateBodyCopy(mapping.SourceItemId, mapping.TargetItemId, sourceItem.Type);
        }).ToArray();
        return Result.Success(new TemplateApplicationPlan(
            applicationId,
            templateId,
            targetRoot.Id,
            bodyCopies.Length == 0
                && staged.Count == 0
                && mode == TemplateApplicationMode.Merge
                && mergePlan is { FieldAdditions: 0, ViewAdditions: 0 },
            mappings.Where(mapping => mapping.Created).Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                source.Single(item => item.Id == mapping.SourceItemId).Type)).ToArray(),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                source.Single(item => item.Id == mapping.SourceItemId).Type)).ToArray(),
            bodyCopies));
    }

    /// <summary>Atomically exposes a staged application and merges the root envelope.</summary>
    public async ValueTask<Result<ItemId>> FinalizeApplicationAsync(
        TemplateApplicationId applicationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var application = await _database.TemplateApplications
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null || application.ActorId != Context.PrincipalId)
        {
            return Result.Failure<ItemId>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ItemId>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (application.State == TemplateOperationState.Active)
        {
            return Result.Success(application.TargetItemId);
        }

        if (application.State != TemplateOperationState.Provisioning || application.ExpiresAt <= _clock.GetUtcNow())
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict("This template application is no longer active."));
        }

        await LockTemplateApplicationAsync(
            application.TemplateId,
            application.TargetItemId,
            cancellationToken).ConfigureAwait(false);

        var mappings = await _database.TemplateApplicationItems
            .Where(mapping => mapping.ApplicationId == applicationId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (mappings.Count == 0 || mappings.Count > MaximumTemplateItems
            || mappings.Count(mapping => mapping.IsRoot) != 1)
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict(
                "This template application's item map is incomplete or exceeds the template item limit."));
        }

        if (application.Mode == TemplateApplicationMode.Create && application.ParentItemId is { } parentItemId)
        {
            var parent = await LockRegularItemAsync(parentItemId, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != application.WorkspaceId)
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(
                    "The destination for this template application was deleted or is no longer active."));
            }
        }

        var targetItems = await LockItemsAsync(
            mappings.Select(mapping => mapping.TargetItemId).ToArray(),
            cancellationToken).ConfigureAwait(false);
        var targetsById = targetItems.ToDictionary(item => item.Id);
        foreach (var mapping in mappings)
        {
            if (!targetsById.TryGetValue(mapping.TargetItemId, out var target)
                || target.WorkspaceId != application.WorkspaceId
                || target.TemplateId is not null
                || (mapping.Created
                    ? target.LifecycleState != ItemLifecycleState.Provisioning
                    : target.LifecycleState != ItemLifecycleState.Active))
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(
                    "A mapped application target was deleted, replaced, or is no longer in its expected state."));
            }
        }

        var sourceItemIds = mappings.Select(mapping => mapping.SourceItemId).Distinct().ToArray();
        var activeSourceCount = await _database.Items.IgnoreQueryFilters()
            .CountAsync(
                item => sourceItemIds.Contains(item.Id)
                    && item.TemplateId == application.TemplateId
                    && item.LifecycleState == ItemLifecycleState.Active,
                cancellationToken)
            .ConfigureAwait(false);
        if (activeSourceCount != sourceItemIds.Length)
        {
            return Result.Failure<ItemId>(TemplateErrors.Conflict(
                "A mapped template source is no longer active; restart the application from the current revision."));
        }

        var expected = mappings.Where(mapping => mapping.BodyRequired).Select(mapping => mapping.TargetItemId).ToArray();
        if (!SameSet(expected, writtenBodyItemIds))
        {
            return Result.Failure<ItemId>(
                TemplateErrors.BodiesIncomplete("Every requested body must be written before application."));
        }
        var actualBodies = await BodyItemIdsAsync(
            mappings.Where(mapping => mapping.Created).Select(mapping => mapping.TargetItemId),
            cancellationToken).ConfigureAwait(false);
        if (!SameSet(expected, actualBodies))
        {
            return Result.Failure<ItemId>(
                TemplateErrors.BodiesIncomplete("The staged application bodies do not match the application plan."));
        }

        if (application.Mode == TemplateApplicationMode.Merge)
        {
            var rootMapping = mappings.Single(mapping => mapping.IsRoot);
            var sourceRoot = await _database.Items.IgnoreQueryFilters()
                .SingleAsync(item => item.Id == rootMapping.SourceItemId, cancellationToken)
                .ConfigureAwait(false);
            var targetRoot = targetsById[rootMapping.TargetItemId];
            var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetRoot.Id, cancellationToken)
                .ConfigureAwait(false);
            var merge = _mergePlanner.Plan(
                targetRoot.Schema,
                sourceRoot.Schema,
                targetRoot.Views,
                sourceRoot.Views,
                effectiveTargetSchema);
            if (merge.Conflicts.Count > 0)
            {
                return Result.Failure<ItemId>(TemplateErrors.Conflict(string.Join(" ", merge.Conflicts)));
            }

            await _database.Items.IgnoreQueryFilters()
                .Where(item => item.Id == targetRoot.Id)
                .ExecuteUpdateAsync(
                    update => update
                        .SetProperty(item => item.Schema, merge.Schema)
                        .SetProperty(item => item.Views, merge.Views)
                        .SetProperty(item => item.LastModifiedBy, Context.PrincipalId)
                        .SetProperty(item => item.LastModifiedAt, _clock.GetUtcNow()),
                    cancellationToken)
                .ConfigureAwait(false);
        }

        await _database.Items.IgnoreQueryFilters()
            .Where(item => mappings.Select(mapping => mapping.TargetItemId).Contains(item.Id)
                && item.LifecycleState == ItemLifecycleState.Provisioning)
            .ExecuteUpdateAsync(
                update => update.SetProperty(item => item.LifecycleState, ItemLifecycleState.Active),
                cancellationToken)
            .ConfigureAwait(false);
        var now = _clock.GetUtcNow();
        application.State = TemplateOperationState.Active;
        application.FinalizedAt = now;
        AddAudit("template.applied", application.TemplateId.Value, application.WorkspaceId, now);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await TrimManagedOperationHistoryAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await DeleteRetiredTemplateRevisionsAsync(application.TemplateId, cancellationToken).ConfigureAwait(false);
        return Result.Success(application.TargetItemId);
    }

    /// <summary>Marks an unfinished application as abandoned; its staged items remain hidden.</summary>
    public async ValueTask<Result<bool>> AbortApplicationAsync(
        TemplateApplicationId applicationId,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var application = await _database.TemplateApplications
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null || application.ActorId != Context.PrincipalId)
        {
            return Result.Failure<bool>(TemplateErrors.NotFound("No such template application is visible."));
        }

        if (application.State == TemplateOperationState.Active)
        {
            return Result.Failure<bool>(TemplateErrors.Conflict("A finalized template application cannot be aborted."));
        }

        if (application.State != TemplateOperationState.Aborted)
        {
            application.State = TemplateOperationState.Aborted;
            application.FinalizedAt = _clock.GetUtcNow();
            AddAudit(
                "template.application_aborted",
                application.TemplateId.Value,
                application.WorkspaceId,
                application.FinalizedAt.Value);
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        await SweepExpiredBatchAsync(
            application.WorkspaceId,
            null,
            application.Id,
            cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }

}
