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
    /// <summary>Stages a hidden item copy of a current workspace item or subtree.</summary>
    public async ValueTask<Result<TemplateCapturePlan>> BeginCaptureAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        string title,
        string? description,
        bool includeBody,
        bool includeChildren,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (InvalidKey(idempotencyKey)
            || string.IsNullOrWhiteSpace(title)
            || title.Length > 200
            || description is { Length: > 1000 })
        {
            return Result.Failure<TemplateCapturePlan>(
                TemplateErrors.Invalid("A title and an idempotency key of at most 160 characters are required."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateCapturePlan>(TemplateErrors.NotFound("No such workspace is visible."));
        }

        await LockWorkspaceTemplatesAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await IdempotencyKeyBelongsElsewhereAsync(
            TemplateOperationKind.Capture,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateCapturePlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }

        var replay = await CaptureReplayAsync(
            workspaceId,
            sourceItemId,
            title.Trim(),
            description,
            includeBody,
            includeChildren,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (replay.IsFailure)
        {
            return Result.Failure<TemplateCapturePlan>(replay.Error);
        }

        if (replay.Value is { } replayed)
        {
            return Result.Success(replayed);
        }

        var capacity = await EnsureCatalogCapacityAsync(workspaceId, true, cancellationToken).ConfigureAwait(false);
        if (capacity.IsFailure)
        {
            return Result.Failure<TemplateCapturePlan>(capacity.Error);
        }

        var source = await SourceTreeAsync(workspaceId, sourceItemId, includeChildren, cancellationToken)
            .ConfigureAwait(false);
        if (source.Count == 0 || source.Count > MaximumTemplateItems)
        {
            return Result.Failure<TemplateCapturePlan>(
                TemplateErrors.Invalid($"A template may contain at most {MaximumTemplateItems:N0} items."));
        }

        if (_validator.Depth(source, sourceItemId) > MaximumTemplateDepth)
        {
            return Result.Failure<TemplateCapturePlan>(
                TemplateErrors.Invalid($"A template may be at most {MaximumTemplateDepth} levels deep."));
        }

        var effectiveSchemas = new Dictionary<ItemId, PropertySchema>(source.Count);
        foreach (var item in source)
        {
            var effective = await _schemas.ResolveForItemAsync(item.Id, cancellationToken).ConfigureAwait(false);
            effectiveSchemas[item.Id] = effective;
            // Capture: this is the user-facing "save my container as a template". A working
            // container may hold a view with a column the schema no longer declares - the live
            // product renders it as nothing rather than refusing it - so capture tolerates the
            // same drift instead of rejecting a container that works. Import stays strict.
            if (_validator.ValidateEnvelope(item.Properties, item.Schema, item.Views, effective, tolerateViewDrift: true)
                is { } reason)
            {
                return Result.Failure<TemplateCapturePlan>(TemplateErrors.Invalid(reason));
            }
        }

        var now = _clock.GetUtcNow();
        var stableKey = $"user.{Guid.CreateVersion7():N}";
        var template = new WorkspaceTemplate
        {
            Id = TemplateId.Create(),
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            StableKey = stableKey,
            ProfileKey = stableKey,
            Origin = TemplateOrigin.User,
            Title = title.Trim(),
            Description = description,
            IncludeBody = includeBody,
            IncludeChildren = includeChildren,
            State = TemplateState.Provisioning,
            Revision = 1,
            CreatedBy = Context.PrincipalId,
            LastModifiedBy = Context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        var operationId = TemplateOperationId.Create();
        var sourceIds = source.ToDictionary(item => item.Id, _ => Guid.CreateVersion7());
        var targetIds = source.ToDictionary(item => item.Id, _ => ItemId.Create());
        var effectiveRootSchema = await _schemas.ResolveForItemAsync(sourceItemId, cancellationToken)
            .ConfigureAwait(false);
        var capturedRootSchema = PropertySchemaJson.Write(effectiveRootSchema with { Inherit = false });
        var bodySources = await BodyItemIdsAsync(source.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var staged = new List<Item>(source.Count);
        var mappings = new List<TemplateOperationItem>(source.Count);
        for (var index = 0; index < source.Count; index++)
        {
            var item = source[index];
            var isRoot = item.Id == sourceItemId;
            var bodyRequired = bodySources.Contains(item.Id) && (!isRoot || includeBody);
            staged.Add(CloneTemplateItem(
                item,
                template.Id,
                sourceIds[item.Id],
                isRoot ? null : targetIds[item.ParentId!.Value],
                targetIds[item.Id],
                isRoot,
                capturedRootSchema,
                now));
            mappings.Add(new TemplateOperationItem
            {
                OperationId = operationId,
                TenantId = Context.TenantId,
                TemplateSourceId = sourceIds[item.Id],
                SourceItemId = item.Id,
                TargetItemId = targetIds[item.Id],
                ItemType = item.Type,
                BodyRequired = bodyRequired,
            });
        }

        var effectiveSchemasByTarget = effectiveSchemas.ToDictionary(
            pair => targetIds[pair.Key],
            pair => pair.Value);
        foreach (var item in staged)
        {
            // Still the capture path (the staged tree the plan will write): tolerant for the same
            // reason as the source validation above.
            if (_validator.ValidateEnvelope(
                    item.Properties,
                    item.Schema,
                    item.Views,
                    effectiveSchemasByTarget[item.Id],
                    tolerateViewDrift: true) is { } reason)
            {
                return Result.Failure<TemplateCapturePlan>(TemplateErrors.Invalid(reason));
            }
        }

        template.PendingRootItemId = targetIds[sourceItemId];
        _database.WorkspaceTemplates.Add(template);
        _database.Items.AddRange(staged);
        _database.TemplateOperations.Add(new TemplateOperation
        {
            Id = operationId,
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            TemplateId = template.Id,
            Kind = TemplateOperationKind.Capture,
            IdempotencyKey = idempotencyKey,
            SourceItemId = sourceItemId,
            ActorId = Context.PrincipalId,
            DraftTitle = title.Trim(),
            DraftDescription = description,
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = now + StagingLifetime,
        });
        _database.TemplateOperationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await RebuildClosureAsync(staged.Select(item => item.Id), cancellationToken).ConfigureAwait(false);

        return Result.Success(new TemplateCapturePlan(
            operationId,
            template.Id,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    /// <summary>Stages a complete validated template-profile import.</summary>
    public async ValueTask<Result<TemplateImportPlan>> BeginImportAsync(
        WorkspaceId workspaceId,
        string idempotencyKey,
        TemplateImportDescriptor descriptor,
        IReadOnlyList<TemplateImportItem> items,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        ArgumentNullException.ThrowIfNull(items);

        if (!await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateImportPlan>(TemplateErrors.NotFound("No such workspace is visible."));
        }

        if (InvalidKey(idempotencyKey))
        {
            return Result.Failure<TemplateImportPlan>(
                TemplateErrors.Invalid("An idempotency key is required."));
        }

        if (_validator.ValidateImport(descriptor, items) is { } refusal)
        {
            return Result.Failure<TemplateImportPlan>(TemplateErrors.Invalid(refusal));
        }

        if (descriptor.Origin == TemplateOrigin.Managed
            && !await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateImportPlan>(
                TemplateErrors.Forbidden("Only the provisioned managed-template service may reconcile managed templates."));
        }

        await LockWorkspaceTemplatesAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await IdempotencyKeyBelongsElsewhereAsync(
            TemplateOperationKind.Import,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateImportPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }

        var replay = await ImportReplayAsync(
            workspaceId,
            descriptor,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (replay.IsFailure)
        {
            return Result.Failure<TemplateImportPlan>(replay.Error);
        }

        if (replay.Value is { } replayed)
        {
            return Result.Success(replayed);
        }

        var catalog = descriptor.Origin == TemplateOrigin.Managed
            ? await _database.WorkspaceTemplates
                .AsTracking()
                .FirstOrDefaultAsync(
                    template => template.WorkspaceId == workspaceId && template.StableKey == descriptor.StableKey,
                    cancellationToken)
                .ConfigureAwait(false)
            : null;
        if (catalog is not null)
        {
            if (catalog.Origin != descriptor.Origin)
            {
                return Result.Failure<TemplateImportPlan>(
                    TemplateErrors.Conflict(
                        $"'{descriptor.StableKey}' already belongs to a {OriginText(catalog.Origin)} template."));
            }

            if (catalog.State == TemplateState.Active
                && string.Equals(catalog.SourceDigest, descriptor.Digest, StringComparison.Ordinal))
            {
                var active = await ActiveTreeAsync(catalog, cancellationToken).ConfigureAwait(false);
                return Result.Success(new TemplateImportPlan(
                    null,
                    catalog.Id,
                    true,
                    active.Select(item => new TemplateItemMapping(
                        item.TemplateSourceId!.Value,
                        item.Id,
                        item.Type)).ToArray(),
                    []));
            }

            if (catalog.PendingRootItemId is not null)
            {
                return Result.Failure<TemplateImportPlan>(
                    TemplateErrors.Conflict("This template already has a revision being imported."));
            }

            if (descriptor.Origin == TemplateOrigin.Managed)
            {
                await TrimManagedOperationHistoryAsync(workspaceId, cancellationToken).ConfigureAwait(false);
                var operationCount = await _database.TemplateOperations
                    .Where(operation => operation.TemplateId == catalog.Id
                        && operation.Kind == TemplateOperationKind.Import
                        && operation.State == TemplateOperationState.Active)
                    .Take(MaximumManagedOperationHistory)
                    .CountAsync(cancellationToken)
                    .ConfigureAwait(false);
                if (operationCount >= MaximumManagedOperationHistory)
                {
                    return Result.Failure<TemplateImportPlan>(TemplateErrors.Conflict(
                        $"Managed template '{descriptor.StableKey}' has reached its "
                        + $"{MaximumManagedOperationHistory}-revision operation-history bound; "
                        + "finish its in-flight applications before importing another revision."));
                }
            }
        }


        var capacity = await EnsureCatalogCapacityAsync(
            workspaceId,
            catalog is null,
            cancellationToken).ConfigureAwait(false);
        if (capacity.IsFailure)
        {
            return Result.Failure<TemplateImportPlan>(capacity.Error);
        }

        var now = _clock.GetUtcNow();
        catalog ??= new WorkspaceTemplate
        {
            Id = TemplateId.Create(),
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            StableKey = descriptor.Origin == TemplateOrigin.User
                ? $"user.{Guid.CreateVersion7():N}"
                : descriptor.StableKey,
            ProfileKey = descriptor.StableKey,
            Origin = descriptor.Origin,
            Title = descriptor.Title,
            Description = descriptor.Description,
            IncludeBody = descriptor.IncludeBody,
            IncludeChildren = descriptor.IncludeChildren,
            ManagedSource = descriptor.ManagedSource,
            SourceDigest = descriptor.Digest,
            State = TemplateState.Provisioning,
            Revision = 1,
            CreatedBy = Context.PrincipalId,
            LastModifiedBy = Context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        var operationId = TemplateOperationId.Create();
        var targetIds = items.ToDictionary(item => item.SourceId, _ => ItemId.Create());
        var effectiveSchemas = new Dictionary<Guid, PropertySchema>(items.Count);
        var staged = new List<Item>(items.Count);
        var mappings = new List<TemplateOperationItem>(items.Count);
        foreach (var item in items)
        {
            var declaredSchema = PropertySchemaJson.Read(item.Schema);
            var effectiveSchema = item.ParentSourceId is { } parentSourceId && declaredSchema.Inherit
                ? PropertySchema.Merge(effectiveSchemas[parentSourceId], declaredSchema)
                : declaredSchema;
            effectiveSchemas[item.SourceId] = effectiveSchema;
            var targetId = targetIds[item.SourceId];
            var stagedItem = new Item
            {
                Id = targetId,
                TenantId = Context.TenantId,
                WorkspaceId = workspaceId,
                Type = item.ItemType,
                ParentId = item.ParentSourceId is { } parent ? targetIds[parent] : null,
                Seq = item.Seq,
                Properties = ItemProperties.WithTitle(
                    item.ParentSourceId is null ? null : item.Properties,
                    item.Title),
                Schema = item.Schema,
                Views = item.Views,
                TemplateId = catalog.Id,
                TemplateSourceId = item.SourceId,
                LifecycleState = ItemLifecycleState.Provisioning,
                CreatedBy = Context.PrincipalId,
                LastModifiedBy = Context.PrincipalId,
                CreatedAt = now,
                LastModifiedAt = now,
            };
            if (_validator.ValidateEnvelope(
                    stagedItem.Properties,
                    stagedItem.Schema,
                    stagedItem.Views,
                    effectiveSchema) is { } reason)
            {
                return Result.Failure<TemplateImportPlan>(TemplateErrors.Invalid(reason));
            }

            staged.Add(stagedItem);
            mappings.Add(new TemplateOperationItem
            {
                OperationId = operationId,
                TenantId = Context.TenantId,
                TemplateSourceId = item.SourceId,
                TargetItemId = targetId,
                ItemType = item.ItemType,
                BodyRequired = item.HasBody,
            });
        }

        var root = items.Single(item => item.ParentSourceId is null);
        if (_database.Entry(catalog).State == EntityState.Detached)
        {
            _database.WorkspaceTemplates.Add(catalog);
        }

        catalog.PendingRootItemId = targetIds[root.SourceId];
        catalog.LastModifiedBy = Context.PrincipalId;
        catalog.LastModifiedAt = now;
        _database.Items.AddRange(staged);
        _database.TemplateOperations.Add(new TemplateOperation
        {
            Id = operationId,
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            TemplateId = catalog.Id,
            Kind = TemplateOperationKind.Import,
            IdempotencyKey = idempotencyKey,
            ActorId = Context.PrincipalId,
            DraftTitle = descriptor.Title,
            DraftDescription = descriptor.Description,
            ManagedSource = descriptor.ManagedSource,
            SourceDigest = descriptor.Digest,
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = now + StagingLifetime,
        });
        _database.TemplateOperationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await RebuildClosureAsync(staged.Select(item => item.Id), cancellationToken).ConfigureAwait(false);

        return Result.Success(new TemplateImportPlan(
            operationId,
            catalog.Id,
            false,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyWrite(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    /// <summary>Atomically publishes a capture/import after every expected body was written.</summary>
    public async ValueTask<Result<TemplateId>> FinalizeOperationAsync(
        TemplateOperationId operationId,
        IReadOnlyList<ItemId> writtenBodyItemIds,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == operationId, cancellationToken)
            .ConfigureAwait(false);
        if (operation is null || operation.ActorId != Context.PrincipalId)
        {
            return Result.Failure<TemplateId>(TemplateErrors.NotFound("No such template operation is visible."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateId>(TemplateErrors.NotFound("No such template operation is visible."));
        }

        if (operation.State == TemplateOperationState.Active)
        {
            return Result.Success(operation.TemplateId);
        }

        if (operation.State != TemplateOperationState.Provisioning || operation.ExpiresAt <= _clock.GetUtcNow())
        {
            return Result.Failure<TemplateId>(TemplateErrors.Conflict("This template operation is no longer active."));
        }

        var operationMappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operationId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var expected = operationMappings.Where(mapping => mapping.BodyRequired)
            .Select(mapping => mapping.TargetItemId)
            .ToArray();
        if (!SameSet(expected, writtenBodyItemIds))
        {
            return Result.Failure<TemplateId>(
                TemplateErrors.BodiesIncomplete("Every requested body must be written before publication."));
        }
        var actualBodies = await BodyItemIdsAsync(
            operationMappings.Select(mapping => mapping.TargetItemId),
            cancellationToken).ConfigureAwait(false);
        if (!SameSet(expected, actualBodies))
        {
            return Result.Failure<TemplateId>(
                TemplateErrors.BodiesIncomplete("The staged template bodies do not match the publication plan."));
        }

        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .SingleAsync(candidate => candidate.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (template.Origin == TemplateOrigin.Managed && operation.Kind == TemplateOperationKind.Import)
        {
            return Result.Failure<TemplateId>(
                TemplateErrors.Conflict("Managed templates must be finalized as one workspace batch."));
        }
        var previousRoot = template.RootItemId;
        await _database.Items.IgnoreQueryFilters()
            .Where(item => operationMappings.Select(mapping => mapping.TargetItemId).Contains(item.Id)
                && item.LifecycleState == ItemLifecycleState.Provisioning)
            .ExecuteUpdateAsync(
                update => update.SetProperty(item => item.LifecycleState, ItemLifecycleState.Active),
                cancellationToken)
            .ConfigureAwait(false);
        template.RootItemId = template.PendingRootItemId;
        template.PendingRootItemId = null;
        template.State = TemplateState.Active;
        if (operation.Kind == TemplateOperationKind.Edit)
        {
            template.Title = operation.DraftTitle!;
            template.Description = operation.DraftDescription;
        }
        else if (operation.Kind == TemplateOperationKind.Import)
        {
            template.Title = operation.DraftTitle!;
            template.Description = operation.DraftDescription;
            template.ManagedSource = operation.ManagedSource;
            template.SourceDigest = operation.SourceDigest;
        }
        if (previousRoot is not null)
        {
            template.Revision++;
        }

        var now = _clock.GetUtcNow();
        template.LastModifiedAt = now;
        template.LastModifiedBy = Context.PrincipalId;
        operation.State = TemplateOperationState.Active;
        operation.FinalizedAt = now;
        AddAudit(
            previousRoot is null ? "template.created" : "template.revision_replaced",
            template.Id.Value,
            template.WorkspaceId,
            now);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        if (previousRoot is { } retiredRoot)
        {
            await DeleteTemplateRevisionAsync(retiredRoot, cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(template.Id);
    }

    /// <summary>Marks an unfinished capture/import as abandoned and releases its catalog slot.</summary>
    public async ValueTask<Result<bool>> AbortOperationAsync(
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == operationId, cancellationToken)
            .ConfigureAwait(false);
        if (operation is null || operation.ActorId != Context.PrincipalId)
        {
            return Result.Failure<bool>(TemplateErrors.NotFound("No such template operation is visible."));
        }

        if (operation.State == TemplateOperationState.Active)
        {
            return Result.Failure<bool>(TemplateErrors.Conflict("A finalized template operation cannot be aborted."));
        }

        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .SingleAsync(candidate => candidate.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (template.Origin == TemplateOrigin.Managed
            && !await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(
                TemplateErrors.Forbidden("Only the provisioned managed-template service may abort managed imports."));
        }

        if (operation.State != TemplateOperationState.Aborted)
        {
            operation.State = TemplateOperationState.Aborted;
            operation.FinalizedAt = _clock.GetUtcNow();
            template.PendingRootItemId = null;
            template.LastModifiedAt = operation.FinalizedAt.Value;
            template.LastModifiedBy = Context.PrincipalId;
            AddAudit("template.operation_aborted", template.Id.Value, template.WorkspaceId, operation.FinalizedAt.Value);
            await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        await SweepExpiredBatchAsync(
            operation.WorkspaceId,
            operation.Id,
            null,
            cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }

}
