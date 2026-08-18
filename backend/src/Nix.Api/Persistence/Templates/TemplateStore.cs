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

/// <summary>
/// Template catalog and staging persistence. Every public method assumes the authenticated,
/// tenant-scoped transaction established by the request pipeline.
/// </summary>
public sealed class TemplateStore :
    ITemplateCatalogStore,
    ITemplateDraftStore,
    ITemplateStagingStore,
    ITemplateApplicationStore,
    ITemplateManagedStore,
    ITemplateAuthorizationStore
{
    private const int MaximumTemplateItems = 200;
    private const int MaximumTemplateDepth = 32;
    private const int MaximumCatalogTemplates = 1000;
    private const int MaximumStageSweepEntries = 25;
    private const int MaximumManagedBatchMappings = MaximumCatalogTemplates * MaximumTemplateItems;
    private const int RetainedManagedOperationHistory = 8;
    private const int MaximumManagedOperationHistory = 16;
    private const int DeletionBatchSize = 256;
    private static readonly TimeSpan StagingLifetime = TimeSpan.FromMinutes(30);

    private readonly NixDbContext _database;
    private readonly IPermissionResolver _permissions;
    private readonly ISchemaResolver _schemas;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;
    private readonly TemplateDefinitionValidator _validator;
    private readonly TemplateMergePlanner _mergePlanner;

    /// <summary>Initializes the store.</summary>
    public TemplateStore(
        NixDbContext database,
        IPermissionResolver permissions,
        ISchemaResolver schemas,
        INixSessionContextAccessor session,
        TimeProvider clock,
        TemplateDefinitionValidator validator,
        TemplateMergePlanner mergePlanner)
    {
        ArgumentNullException.ThrowIfNull(database);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentNullException.ThrowIfNull(validator);
        ArgumentNullException.ThrowIfNull(mergePlanner);

        _database = database;
        _permissions = permissions;
        _schemas = schemas;
        _session = session;
        _clock = clock;
        _validator = validator;
        _mergePlanner = mergePlanner;
    }

    private NixSessionContext Context => _session.Current
        ?? throw new InvalidOperationException("Template work requires an authenticated tenant session.");

    private async ValueTask<bool> IsManagedTemplatePrincipalAsync(CancellationToken cancellationToken) =>
        await _database.Principals.AnyAsync(
            principal => principal.Id == Context.PrincipalId
                && principal.Kind == Nix.Domain.Identity.PrincipalKind.Service
                && principal.CanManageTemplates,
            cancellationToken).ConfigureAwait(false);

    /// <summary>Authorizes cheap import admission before archive bytes are parsed.</summary>
    public async ValueTask<Result<TemplateWorkspaceAuthorization>> AuthorizeImportAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateWorkspaceAuthorization>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }

        var canWrite = await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var canManageTemplates = canWrite
            && await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(new TemplateWorkspaceAuthorization(
            Context.TenantId,
            Context.PrincipalId,
            workspaceId,
            canWrite,
            canManageTemplates));
    }

    /// <summary>Lists active templates in a readable workspace.</summary>
    public async ValueTask<Result<TemplateLibrarySnapshot>> ListAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        if (!await _permissions.CanReadWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateLibrarySnapshot>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }

        var rows = await _database.WorkspaceTemplates
            .Where(template => template.WorkspaceId == workspaceId && template.State == TemplateState.Active)
            .OrderByDescending(template => template.LastModifiedAt)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (rows.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<TemplateLibrarySnapshot>(
                TemplateErrors.Invalid(
                    $"A workspace may expose at most {MaximumCatalogTemplates:N0} active templates."));
        }
        var canManage = await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false);

        var rootIds = rows.Where(template => template.RootItemId is not null)
            .Select(template => template.RootItemId!.Value)
            .ToArray();
        var roots = rootIds.Length == 0
            ? new Dictionary<ItemId, Item>()
            : await _database.Items.IgnoreQueryFilters()
                .Where(item => rootIds.Contains(item.Id)
                    && item.LifecycleState == ItemLifecycleState.Active)
                .ToDictionaryAsync(item => item.Id, cancellationToken)
                .ConfigureAwait(false);
        var childCounts = rootIds.Length == 0
            ? new Dictionary<ItemId, int>()
            : await _database.ItemClosure
                .Where(edge => rootIds.Contains(edge.AncestorId) && edge.Depth > 0)
                .GroupBy(edge => edge.AncestorId)
                .Select(group => new { RootId = group.Key, Count = group.Count() })
                .ToDictionaryAsync(row => row.RootId, row => row.Count, cancellationToken)
                .ConfigureAwait(false);

        var result = new List<TemplateCatalogSnapshot>(rows.Count);
        foreach (var row in rows)
        {
            var shape = row.RootItemId is { } rootId && roots.TryGetValue(rootId, out var root)
                ? Shape(root, childCounts.GetValueOrDefault(rootId))
                : new TemplateShape(0, 0, 0, []);
            result.Add(new TemplateCatalogSnapshot(
                row,
                shape,
                canManage));
        }

        return Result.Success(new TemplateLibrarySnapshot(result, canManage));
    }

    /// <summary>Reads one active template and its hidden tree.</summary>
    public async ValueTask<Result<TemplateDetailSnapshot>> DetailAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDetailSnapshot>(TemplateErrors.NotFound("No such template is visible."));
        }

        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (items.Count == 0)
        {
            return Result.Failure<TemplateDetailSnapshot>(
                TemplateErrors.Invalid("This template has no active root and cannot be used."));
        }

        var bodyItems = await BodyItemIdsAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var root = BuildTree(items, bodyItems);
        var canManage = await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new TemplateDetailSnapshot(template, Shape(items), root, canManage));
    }

    /// <summary>Reads one active template item by stable source identity.</summary>
    public async ValueTask<Result<TemplateItemSnapshot>> ItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var detail = await DetailAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (detail.IsFailure)
        {
            return Result.Failure<TemplateItemSnapshot>(detail.Error);
        }

        var found = FindSnapshot(detail.Value.Root, sourceId);
        return found is null
            ? Result.Failure<TemplateItemSnapshot>(TemplateErrors.NotFound("No such template item is visible."))
            : Result.Success(found);
    }

    /// <summary>Creates a complete editable copy while the active revision remains visible.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> BeginDraftAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (InvalidKey(idempotencyKey))
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.Invalid("An idempotency key is required."));
        }

        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.Id == templateId && candidate.State == TemplateState.Active,
                cancellationToken)
            .ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.NotFound("No such template is visible."));
        }

        if (template.Origin != TemplateOrigin.User)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Managed("Managed templates are read-only. Duplicate one before editing it."));
        }

        await SweepExpiredAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false);
        await LockTemplateAsync(template.Id, cancellationToken).ConfigureAwait(false);
        await LockIdempotencyKeyAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        if (await IdempotencyKeyBelongsElsewhereAsync(
            TemplateOperationKind.Edit,
            idempotencyKey,
            cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template operation."));
        }
        var existingDraft = await _database.TemplateOperations.FirstOrDefaultAsync(
            operation => operation.ActorId == Context.PrincipalId
                && operation.IdempotencyKey == idempotencyKey
                && operation.Kind == TemplateOperationKind.Edit,
            cancellationToken).ConfigureAwait(false);
        if (existingDraft is not null && existingDraft.TemplateId != templateId)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This idempotency key belongs to another template draft."));
        }
        await _database.Entry(template).ReloadAsync(cancellationToken).ConfigureAwait(false);
        if (await DraftReplayAsync(templateId, idempotencyKey, cancellationToken).ConfigureAwait(false) is { } replay)
        {
            return Result.Success(replay);
        }

        if (template.PendingRootItemId is not null)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This template already has a draft or revision being prepared."));
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplateDraftPlan>(TemplateErrors.Invalid("The template has no active root."));
        }

        var operationId = TemplateOperationId.Create();
        var now = _clock.GetUtcNow();
        var expiresAt = now + StagingLifetime;
        var targetIds = source.ToDictionary(item => item.Id, _ => ItemId.Create());
        var bodySources = await BodyItemIdsAsync(source.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        var staged = new List<Item>(source.Count);
        var mappings = new List<TemplateOperationItem>(source.Count);
        foreach (var item in source)
        {
            var targetId = targetIds[item.Id];
            staged.Add(CloneTemplateItem(
                item,
                template.Id,
                item.TemplateSourceId!.Value,
                item.ParentId is { } parent ? targetIds[parent] : null,
                targetId,
                false,
                null,
                now));
            mappings.Add(new TemplateOperationItem
            {
                OperationId = operationId,
                TenantId = Context.TenantId,
                TemplateSourceId = item.TemplateSourceId.Value,
                SourceItemId = item.Id,
                TargetItemId = targetId,
                ItemType = item.Type,
                BodyRequired = bodySources.Contains(item.Id),
            });
        }

        template.PendingRootItemId = targetIds[source[0].Id];
        _database.Items.AddRange(staged);
        _database.TemplateOperations.Add(new TemplateOperation
        {
            Id = operationId,
            TenantId = Context.TenantId,
            WorkspaceId = template.WorkspaceId,
            TemplateId = template.Id,
            Kind = TemplateOperationKind.Edit,
            IdempotencyKey = idempotencyKey,
            ActorId = Context.PrincipalId,
            DraftTitle = template.Title,
            DraftDescription = template.Description,
            State = TemplateOperationState.Provisioning,
            CreatedAt = now,
            ExpiresAt = expiresAt,
        });
        _database.TemplateOperationItems.AddRange(mappings);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await RebuildClosureAsync(staged.Select(item => item.Id), cancellationToken).ConfigureAwait(false);

        return Result.Success(new TemplateDraftPlan(
            operationId,
            template.Id,
            template.Title,
            template.Description,
            expiresAt,
            BuildTree(staged, bodySources.Select(sourceId => targetIds[sourceId]).ToHashSet()),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    /// <summary>Reads a caller-owned provisioning draft without exposing another active revision.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> DraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        return loaded.IsFailure
            ? Result.Failure<TemplateDraftPlan>(loaded.Error)
            : Result.Success(await DraftPlanAsync(loaded.Value, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Updates catalog metadata in a draft; it is applied only by Save.</summary>
    public async ValueTask<Result<TemplateDraftPlan>> UpdateDraftMetadataAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        string? title,
        string? description,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateDraftPlan>(loaded.Error);
        }
        await LockWorkspaceTemplatesAsync(loaded.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);

        var operation = loaded.Value;
        var nextTitle = operation.DraftTitle;
        if (title is not null)
        {
            if (string.IsNullOrWhiteSpace(title) || title.Length > 200)
            {
                return Result.Failure<TemplateDraftPlan>(
                    TemplateErrors.Invalid("A template title must be between 1 and 200 characters."));
            }

            nextTitle = title.Trim();
        }

        if (description is { Length: > 1000 })
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Invalid("A template description may contain at most 1,000 characters."));
        }

        var nextDescription = description ?? operation.DraftDescription;
        var now = _clock.GetUtcNow();
        var updated = await _database.TemplateOperations
            .Where(candidate => candidate.Id == operationId
                && candidate.TemplateId == templateId
                && candidate.ActorId == Context.PrincipalId
                && candidate.Kind == TemplateOperationKind.Edit
                && candidate.State == TemplateOperationState.Provisioning
                && candidate.ExpiresAt > now)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.DraftTitle, nextTitle)
                    .SetProperty(candidate => candidate.DraftDescription, nextDescription),
                cancellationToken)
            .ConfigureAwait(false);
        if (updated != 1)
        {
            return Result.Failure<TemplateDraftPlan>(
                TemplateErrors.Conflict("This template draft is no longer active."));
        }

        operation.DraftTitle = nextTitle;
        operation.DraftDescription = nextDescription;
        return Result.Success(await DraftPlanAsync(operation, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Updates only a provisioning draft envelope.</summary>
    public async ValueTask<Result<TemplateItemSnapshot>> UpdateDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        string? title,
        string? properties,
        string? schema,
        string? views,
        CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateItemSnapshot>(loaded.Error);
        }
        await LockWorkspaceTemplatesAsync(loaded.Value.WorkspaceId, cancellationToken).ConfigureAwait(false);

        var mapping = await _database.TemplateOperationItems
            .FirstOrDefaultAsync(
                candidate => candidate.OperationId == operationId && candidate.TemplateSourceId == sourceId,
                cancellationToken)
            .ConfigureAwait(false);
        if (mapping is null)
        {
            return Result.Failure<TemplateItemSnapshot>(TemplateErrors.NotFound("No such draft item is visible."));
        }

        var item = await _database.Items.IgnoreQueryFilters()
            .AsNoTracking()
            .SingleAsync(candidate => candidate.Id == mapping.TargetItemId, cancellationToken)
            .ConfigureAwait(false);
        var nextProperties = properties ?? item.Properties;
        if (item.ParentId is null)
        {
            nextProperties = ItemProperties.WithTitle(null, ItemProperties.ReadTitle(nextProperties));
        }
        if (title is not null)
        {
            if (string.IsNullOrWhiteSpace(title) || title.Length > 200)
            {
                return Result.Failure<TemplateItemSnapshot>(
                    TemplateErrors.Invalid("An item title must be between 1 and 200 characters."));
            }

            nextProperties = ItemProperties.WithTitle(nextProperties, title.Trim());
        }

        var nextSchema = schema ?? item.Schema;
        var nextViews = views ?? item.Views;
        var declared = PropertySchemaJson.Read(nextSchema);
        var effective = item.ParentId is { } parentId && declared.Inherit
            ? PropertySchema.Merge(
                await ResolveHiddenTemplateSchemaAsync(
                    parentId,
                    templateId,
                    cancellationToken).ConfigureAwait(false),
                declared)
            : declared;
        // Editing a template item drawn from the workspace: tolerate a view whose column the
        // schema no longer declares, exactly as the live container does. See ValidateViewDependencies.
        if (_validator.ValidateEnvelope(nextProperties, nextSchema, nextViews, effective, tolerateViewDrift: true)
            is { } refusal)
        {
            return Result.Failure<TemplateItemSnapshot>(TemplateErrors.Invalid(refusal));
        }

        var now = _clock.GetUtcNow();
        var updated = await _database.Items.IgnoreQueryFilters()
            .Where(candidate => candidate.Id == item.Id
                && candidate.LifecycleState == ItemLifecycleState.Provisioning
                && _database.TemplateOperationItems.Any(candidateMapping =>
                    candidateMapping.OperationId == operationId
                    && candidateMapping.TemplateSourceId == sourceId
                    && candidateMapping.TargetItemId == candidate.Id)
                && _database.TemplateOperations.Any(candidateOperation =>
                    candidateOperation.Id == operationId
                    && candidateOperation.TemplateId == templateId
                    && candidateOperation.ActorId == Context.PrincipalId
                    && candidateOperation.Kind == TemplateOperationKind.Edit
                    && candidateOperation.State == TemplateOperationState.Provisioning
                    && candidateOperation.ExpiresAt > now))
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(candidate => candidate.Properties, nextProperties)
                    .SetProperty(candidate => candidate.Schema, nextSchema)
                    .SetProperty(candidate => candidate.Views, nextViews)
                    .SetProperty(candidate => candidate.LastModifiedBy, Context.PrincipalId)
                    .SetProperty(candidate => candidate.LastModifiedAt, now),
                cancellationToken)
            .ConfigureAwait(false);
        if (updated != 1)
        {
            return Result.Failure<TemplateItemSnapshot>(
                TemplateErrors.Conflict("This template draft is no longer active."));
        }
        var draft = await DraftPlanAsync(loaded.Value, cancellationToken).ConfigureAwait(false);
        return Result.Success(FindSnapshot(draft.Root, sourceId)!);
    }

    /// <summary>Publishes an edit operation after Collab has hydrated all of its draft bodies.</summary>
    public async ValueTask<Result<TemplateId>> SaveDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateId>(loaded.Error);
        }

        var expected = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operationId && mapping.BodyRequired)
            .Select(mapping => mapping.TargetItemId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        return await FinalizeOperationAsync(operationId, expected, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Resolves a portable draft item identity to its provisioning body target.</summary>
    public async ValueTask<Result<TemplateItemAuthorization>> AuthorizeDraftItemAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var loaded = await LoadDraftAsync(templateId, operationId, cancellationToken).ConfigureAwait(false);
        if (loaded.IsFailure)
        {
            return Result.Failure<TemplateItemAuthorization>(loaded.Error);
        }

        var mapping = await _database.TemplateOperationItems
            .FirstOrDefaultAsync(
                candidate => candidate.OperationId == operationId && candidate.TemplateSourceId == sourceId,
                cancellationToken)
            .ConfigureAwait(false);
        if (mapping is null)
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such draft item is visible."));
        }

        return Result.Success(new TemplateItemAuthorization(
            templateId,
            sourceId,
            mapping.TargetItemId,
            Context.TenantId,
            Context.PrincipalId,
            loaded.Value.WorkspaceId,
            mapping.ItemType,
            true,
            true));
    }

    /// <summary>Deletes a user-authored catalog entry and its hidden item revisions.</summary>
    public async ValueTask<Result<bool>> DeleteAsync(TemplateId templateId, CancellationToken cancellationToken)
    {
        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        var template = await _database.WorkspaceTemplates
            .AsTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == templateId, cancellationToken)
            .ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<bool>(TemplateErrors.NotFound("No such template is visible."));
        }

        if (template.Origin != TemplateOrigin.User)
        {
            return Result.Failure<bool>(
                TemplateErrors.Managed("Managed templates are removed by their source, not from the workspace."));
        }

        await DeleteProvisioningApplicationTargetsAsync(templateId, cancellationToken).ConfigureAwait(false);
        await _database.TemplateApplications
            .Where(application => application.TemplateId == templateId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _database.TemplateOperations
            .Where(operation => operation.TemplateId == templateId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);

        template.RootItemId = null;
        template.PendingRootItemId = null;
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await DeleteHiddenTemplateItemsAsync(templateId, cancellationToken).ConfigureAwait(false);

        _database.WorkspaceTemplates.Remove(template);
        AddAudit("template.deleted", template.Id.Value, template.WorkspaceId, _clock.GetUtcNow());
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return Result.Success(true);
    }

    private async ValueTask DeleteProvisioningApplicationTargetsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            var itemIds = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.LifecycleState == ItemLifecycleState.Provisioning
                    && _database.TemplateApplicationItems.Any(mapping => mapping.TargetItemId == item.Id
                        && mapping.Created
                        && _database.TemplateApplications.Any(application =>
                            application.Id == mapping.ApplicationId
                            && application.TemplateId == templateId))
                    && !_database.Items.IgnoreQueryFilters().Any(child =>
                        child.ParentId == item.Id
                        && child.LifecycleState == ItemLifecycleState.Provisioning))
                .OrderBy(item => item.Id)
                .Select(item => item.Id)
                .Take(DeletionBatchSize)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (itemIds.Length == 0)
            {
                return;
            }

            await DeleteItemBatchAsync(itemIds, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask DeleteHiddenTemplateItemsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            var itemIds = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.TemplateId == templateId
                    && !_database.Items.IgnoreQueryFilters().Any(child => child.ParentId == item.Id))
                .OrderBy(item => item.Id)
                .Select(item => item.Id)
                .Take(DeletionBatchSize)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
            if (itemIds.Length == 0)
            {
                return;
            }

            await DeleteItemBatchAsync(itemIds, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask DeleteItemBatchAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        await _database.ItemClosure
            .Where(edge => itemIds.Contains(edge.AncestorId) || itemIds.Contains(edge.DescendantId))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _database.Items.IgnoreQueryFilters()
            .Where(item => itemIds.Contains(item.Id))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    /// <summary>Calculates server-owned additions before an application begins.</summary>
    public async ValueTask<Result<TemplatePreflight>> PreflightAsync(
        TemplateId templateId,
        TemplateApplicationMode mode,
        ItemId? targetItemId,
        ItemId? parentItemId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such template is visible."));
        }

        var source = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        if (source.Count == 0)
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.Invalid("The template has no active root."));
        }
        var canApply = await _permissions.CanWriteWorkspaceAsync(template.WorkspaceId, cancellationToken)
            .ConfigureAwait(false);
        // Preflighting an application of a captured template: the source came from a workspace and
        // is tolerated the same way it was at capture, so a template that saved can also be applied.
        var templateConflict = _validator.ValidateTemplateTree(source, tolerateViewDrift: true);

        if (mode == TemplateApplicationMode.Create)
        {
            if (parentItemId is { } parent
                && (await RegularItemAsync(parent, cancellationToken).ConfigureAwait(false) is not { } parentItem
                    || parentItem.WorkspaceId != template.WorkspaceId))
            {
                return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such destination is visible."));
            }

            var root = source[0];
            IReadOnlyList<string> createConflicts = templateConflict is null ? [] : [templateConflict];
            return Result.Success(new TemplatePreflight(
                templateId,
                mode,
                PropertySchemaJson.Read(root.Schema).Properties.Length,
                ViewDefinitionsJson.Read(root.Views).Views.Length,
                source.Count,
                createConflicts,
                canApply && createConflicts.Count == 0));
        }

        if (targetItemId is not { } targetId
            || await RegularItemAsync(targetId, cancellationToken).ConfigureAwait(false) is not { } target
            || target.WorkspaceId != template.WorkspaceId)
        {
            return Result.Failure<TemplatePreflight>(TemplateErrors.NotFound("No such target is visible."));
        }

        var effectiveTargetSchema = await _schemas.ResolveForItemAsync(targetId, cancellationToken).ConfigureAwait(false);
        var merge = _mergePlanner.Plan(
            target.Schema,
            source[0].Schema,
            target.Views,
            source[0].Views,
            effectiveTargetSchema);
        var prior = await PriorTargetMapAsync(
            templateId,
            targetId,
            template.WorkspaceId,
            source.Select(item => item.TemplateSourceId!.Value).ToArray(),
            cancellationToken).ConfigureAwait(false);
        var conflicts = merge.Conflicts.ToList();
        if (templateConflict is not null)
        {
            conflicts.Add(templateConflict);
        }
        if (prior.IsFailure)
        {
            conflicts.Add(prior.Error.Message);
        }
        var priorSources = prior.IsSuccess ? prior.Value.Keys.ToHashSet() : [];
        var itemAdditions = source.Skip(1).Count(item => !priorSources.Contains(item.TemplateSourceId!.Value));
        return Result.Success(new TemplatePreflight(
            templateId,
            mode,
            merge.FieldAdditions,
            merge.ViewAdditions,
            itemAdditions,
            conflicts,
            canApply && conflicts.Count == 0));
    }

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

    /// <summary>Publishes one complete managed-directory snapshot as an all-or-nothing catalog swap.</summary>
    public async ValueTask<Result<ManagedTemplateBatchResult>> FinalizeManagedBatchAsync(
        WorkspaceId workspaceId,
        IReadOnlyList<ManagedTemplateFinalization> managedEntries,
        IReadOnlyList<string> activeStableKeys,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(managedEntries);
        ArgumentNullException.ThrowIfNull(activeStableKeys);
        if (!await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.NotFound("No such workspace is visible."));
        }
        if (!await IsManagedTemplatePrincipalAsync(cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Forbidden("Only the provisioned managed-template service may publish managed templates."));
        }

        if (managedEntries.Count > MaximumCatalogTemplates
            || activeStableKeys.Count > MaximumCatalogTemplates
            || activeStableKeys.Any(static key => string.IsNullOrWhiteSpace(key) || key.Length > 160)
            || activeStableKeys.Distinct(StringComparer.Ordinal).Count() != activeStableKeys.Count
            || managedEntries.Select(imported => imported.StableKey).Distinct(StringComparer.Ordinal).Count() != managedEntries.Count)
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Invalid(
                    $"A managed snapshot may name at most {MaximumCatalogTemplates:N0} distinct stable keys."));
        }

        var requestedKeys = activeStableKeys.ToHashSet(StringComparer.Ordinal);
        if (!requestedKeys.SetEquals(managedEntries.Select(imported => imported.StableKey)))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Invalid("Every active stable key must have exactly one import result."));
        }

        await LockTemplateStagesAsync(cancellationToken).ConfigureAwait(false);
        await LockWorkspaceTemplatesAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        var catalogs = await _database.WorkspaceTemplates
            .AsTracking()
            .Where(template => template.WorkspaceId == workspaceId && template.Origin == TemplateOrigin.Managed)
            .OrderBy(template => template.Id)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (catalogs.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                $"The managed catalog exceeds its {MaximumCatalogTemplates:N0}-template storage bound."));
        }
        var byKey = catalogs.ToDictionary(template => template.StableKey, StringComparer.Ordinal);
        if (managedEntries.Any(imported => !byKey.TryGetValue(imported.StableKey, out var catalog)
            || catalog.Id != imported.TemplateId))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Conflict("The managed catalog changed while the snapshot was being staged."));
        }

        var suppliedOperationIds = managedEntries
            .Where(imported => imported.OperationId is not null)
            .Select(imported => imported.OperationId!.Value)
            .ToHashSet();
        var outstanding = await (
            from operation in _database.TemplateOperations.AsTracking()
            join template in _database.WorkspaceTemplates on operation.TemplateId equals template.Id
            where operation.WorkspaceId == workspaceId
                && operation.Kind == TemplateOperationKind.Import
                && operation.State == TemplateOperationState.Provisioning
                && template.Origin == TemplateOrigin.Managed
            select operation)
            .OrderBy(operation => operation.Id)
            .Take(MaximumCatalogTemplates + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (outstanding.Count > MaximumCatalogTemplates)
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                "The managed staging set exceeds the catalog bound; expire abandoned imports before retrying."));
        }
        if (!suppliedOperationIds.SetEquals(outstanding.Select(operation => operation.Id)))
        {
            return Result.Failure<ManagedTemplateBatchResult>(
                TemplateErrors.Conflict("The managed snapshot does not match every staged import."));
        }

        var operations = outstanding.ToDictionary(operation => operation.Id);
        var mappingQuery = _database.TemplateOperationItems
            .AsNoTracking()
            .Where(mapping => suppliedOperationIds.Contains(mapping.OperationId));

        var importsByOperation = managedEntries
            .Where(imported => imported.OperationId is not null)
            .ToDictionary(imported => imported.OperationId!.Value);
        var writtenByOperation = importsByOperation.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.WrittenTargetItemIds.ToHashSet());
        if (writtenByOperation.Any(pair => pair.Value.Count != importsByOperation[pair.Key].WrittenTargetItemIds.Count))
        {
            return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Invalid(
                "A managed import lists the same written body target more than once."));
        }

        var mappingCounts = new Dictionary<TemplateOperationId, int>();
        var expectedBodyCounts = new Dictionary<TemplateOperationId, int>();
        var mappingCount = 0;
        await foreach (var mapping in mappingQuery.AsAsyncEnumerable().WithCancellation(cancellationToken)
                           .ConfigureAwait(false))
        {
            mappingCount++;
            if (mappingCount > MaximumManagedBatchMappings)
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    $"A managed snapshot may stage at most {MaximumManagedBatchMappings:N0} item mappings."));
            }

            if (!writtenByOperation.TryGetValue(mapping.OperationId, out var writtenTargets))
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    "A staged managed item belongs to an operation outside this snapshot."));
            }

            mappingCounts[mapping.OperationId] = mappingCounts.GetValueOrDefault(mapping.OperationId) + 1;
            if (!mapping.BodyRequired)
            {
                continue;
            }

            expectedBodyCounts[mapping.OperationId] = expectedBodyCounts.GetValueOrDefault(mapping.OperationId) + 1;
            if (!writtenTargets.Contains(mapping.TargetItemId))
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.BodiesIncomplete(
                    $"Every body for managed template '{importsByOperation[mapping.OperationId].StableKey}' must be written."));
            }
        }

        var actualBodyCounts = suppliedOperationIds.Count == 0
            ? new Dictionary<TemplateOperationId, int>()
            : await _database.TemplateOperationItems
                .Where(mapping => suppliedOperationIds.Contains(mapping.OperationId)
                    && _database.ContentDocs.Any(document => document.ItemId == mapping.TargetItemId))
                .GroupBy(mapping => mapping.OperationId)
                .Select(group => new { OperationId = group.Key, Count = group.Count() })
                .ToDictionaryAsync(row => row.OperationId, row => row.Count, cancellationToken)
                .ConfigureAwait(false);
        var now = _clock.GetUtcNow();
        foreach (var imported in managedEntries)
        {
            var catalog = byKey[imported.StableKey];
            if (imported.OperationId is null)
            {
                if (catalog.State != TemplateState.Active
                    || !string.Equals(catalog.SourceDigest, imported.Digest, StringComparison.Ordinal))
                {
                    return Result.Failure<ManagedTemplateBatchResult>(
                        TemplateErrors.Conflict($"Managed template '{imported.StableKey}' is not unchanged."));
                }

                continue;
            }

            var operation = operations[imported.OperationId.Value];
            if (operation.ActorId != Context.PrincipalId
                || operation.TemplateId != catalog.Id
                || operation.ExpiresAt <= now
                || catalog.PendingRootItemId is null
                || !string.Equals(operation.SourceDigest, imported.Digest, StringComparison.Ordinal))
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.Conflict($"Managed template '{imported.StableKey}' has stale staging state."));
            }

            if (mappingCounts.GetValueOrDefault(operation.Id) is not (> 0 and <= MaximumTemplateItems))
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.Conflict(
                        $"Managed template '{imported.StableKey}' has no staged items or exceeds the item limit."));
            }

            var expectedBodies = expectedBodyCounts.GetValueOrDefault(operation.Id);
            if (expectedBodies != writtenByOperation[operation.Id].Count)
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.BodiesIncomplete(
                        $"Every body for managed template '{imported.StableKey}' must be written."));
            }
            if (actualBodyCounts.GetValueOrDefault(operation.Id) != expectedBodies)
            {
                return Result.Failure<ManagedTemplateBatchResult>(
                    TemplateErrors.BodiesIncomplete(
                        $"The staged bodies for managed template '{imported.StableKey}' do not match its plan."));
            }
        }

        if (suppliedOperationIds.Count > 0)
        {
            var activatedItems = await _database.Items.IgnoreQueryFilters()
                .Where(item => item.LifecycleState == ItemLifecycleState.Provisioning
                    && _database.TemplateOperationItems.Any(mapping =>
                        suppliedOperationIds.Contains(mapping.OperationId)
                        && mapping.TargetItemId == item.Id))
                .ExecuteUpdateAsync(
                    update => update.SetProperty(item => item.LifecycleState, ItemLifecycleState.Active),
                cancellationToken)
                .ConfigureAwait(false);
            if (activatedItems != mappingCount)
            {
                return Result.Failure<ManagedTemplateBatchResult>(TemplateErrors.Conflict(
                    "A staged managed item is missing or no longer in provisioning state."));
            }
        }

        var activated = 0;
        var unchanged = 0;
        var previousRoots = new List<ItemId>();
        foreach (var imported in managedEntries)
        {
            if (imported.OperationId is null)
            {
                unchanged++;
                continue;
            }

            var operation = operations[imported.OperationId.Value];
            var catalog = byKey[imported.StableKey];
            var previousRoot = catalog.RootItemId;
            catalog.RootItemId = catalog.PendingRootItemId;
            catalog.PendingRootItemId = null;
            catalog.State = TemplateState.Active;
            catalog.Title = operation.DraftTitle!;
            catalog.Description = operation.DraftDescription;
            catalog.ManagedSource = operation.ManagedSource;
            catalog.SourceDigest = operation.SourceDigest;
            catalog.LastModifiedBy = Context.PrincipalId;
            catalog.LastModifiedAt = now;
            if (previousRoot is not null)
            {
                catalog.Revision++;
                previousRoots.Add(previousRoot.Value);
            }

            operation.State = TemplateOperationState.Active;
            operation.FinalizedAt = now;
            AddAudit(
                previousRoot is null ? "template.managed_created" : "template.managed_replaced",
                catalog.Id.Value,
                workspaceId,
                now);
            activated++;
        }

        var retired = 0;
        foreach (var catalog in catalogs.Where(catalog => catalog.State == TemplateState.Active
                     && !requestedKeys.Contains(catalog.StableKey)))
        {
            catalog.State = TemplateState.Inactive;
            catalog.SourceDigest = null;
            catalog.LastModifiedBy = Context.PrincipalId;
            catalog.LastModifiedAt = now;
            AddAudit("template.managed_retired", catalog.Id.Value, workspaceId, now);
            retired++;
        }

        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        await TrimManagedOperationHistoryAsync(workspaceId, cancellationToken).ConfigureAwait(false);
        foreach (var previousRoot in previousRoots)
        {
            await DeleteTemplateRevisionAsync(previousRoot, cancellationToken).ConfigureAwait(false);
        }

        return Result.Success(new ManagedTemplateBatchResult(activated, unchanged, retired));
    }

    /// <summary>Deletes expired staging envelopes and their bodies without touching active revisions.</summary>
    public ValueTask<Result<TemplateStageSweepResult>> SweepExpiredAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken) =>
        SweepExpiredBatchAsync(workspaceId, null, null, cancellationToken);

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

    /// <summary>Authorizes a source or staged target body for one in-progress operation.</summary>
    public async ValueTask<Result<TemplateOperationAuthorization>> AuthorizeOperationItemAsync(
        Guid operationId,
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .FirstOrDefaultAsync(candidate => candidate.Id == TemplateOperationId.From(operationId), cancellationToken)
            .ConfigureAwait(false);
        if (operation is not null)
        {
            if (operation.ActorId != Context.PrincipalId
                || operation.State != TemplateOperationState.Provisioning
                || operation.ExpiresAt <= _clock.GetUtcNow()
                || !await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTypedId = TemplateOperationId.From(operationId);
            var mapping = await _database.TemplateOperationItems
                .FirstOrDefaultAsync(
                    candidate => candidate.OperationId == operationTypedId
                        && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                    cancellationToken)
                .ConfigureAwait(false);
            if (mapping is null)
            {
                return Result.Failure<TemplateOperationAuthorization>(
                    TemplateErrors.NotFound("No such staging item is visible."));
            }

            var operationTargetCanWrite = mapping.TargetItemId == itemId
                && mapping.BodyRequired
                && await _database.Items.IgnoreQueryFilters().AnyAsync(
                    candidate => candidate.Id == itemId
                        && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                    cancellationToken).ConfigureAwait(false);

            return Result.Success(new TemplateOperationAuthorization(
                operationId,
                itemId,
                Context.TenantId,
                Context.PrincipalId,
                operation.WorkspaceId,
                mapping.ItemType,
                mapping.SourceItemId == itemId,
                mapping.TargetItemId == itemId,
                operationTargetCanWrite));
        }

        var applicationTypedId = TemplateApplicationId.From(operationId);
        var application = await _database.TemplateApplications
            .FirstOrDefaultAsync(candidate => candidate.Id == applicationTypedId, cancellationToken)
            .ConfigureAwait(false);
        if (application is null
            || application.ActorId != Context.PrincipalId
            || application.State != TemplateOperationState.Provisioning
            || application.ExpiresAt <= _clock.GetUtcNow()
            || !await _permissions.CanWriteWorkspaceAsync(application.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }

        var applicationMapping = await _database.TemplateApplicationItems
            .FirstOrDefaultAsync(
                candidate => candidate.ApplicationId == applicationTypedId
                    && (candidate.SourceItemId == itemId || candidate.TargetItemId == itemId),
                cancellationToken)
            .ConfigureAwait(false);
        if (applicationMapping is null)
        {
            return Result.Failure<TemplateOperationAuthorization>(
                TemplateErrors.NotFound("No such staging item is visible."));
        }


        var applicationTargetCanWrite = applicationMapping.TargetItemId == itemId
            && applicationMapping.Created
            && applicationMapping.BodyRequired
            && await _database.Items.IgnoreQueryFilters().AnyAsync(
                candidate => candidate.Id == itemId
                    && candidate.LifecycleState == ItemLifecycleState.Provisioning,
                cancellationToken).ConfigureAwait(false);

        var sourceItem = await _database.Items.IgnoreQueryFilters()
            .SingleAsync(candidate => candidate.Id == applicationMapping.SourceItemId, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(new TemplateOperationAuthorization(
            operationId,
            itemId,
            Context.TenantId,
            Context.PrincipalId,
            application.WorkspaceId,
            sourceItem.Type,
            applicationMapping.SourceItemId == itemId,
            applicationMapping.TargetItemId == itemId,
            applicationTargetCanWrite));
    }

    /// <summary>Authorizes an active hidden template body for read or user-template editing.</summary>
    public async ValueTask<Result<TemplateItemAuthorization>> AuthorizeTemplateItemAsync(
        TemplateId templateId,
        Guid sourceId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var activeIds = (await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false))
            .Where(item => item.TemplateSourceId == sourceId)
            .ToList();
        if (activeIds.Count != 1)
        {
            return Result.Failure<TemplateItemAuthorization>(TemplateErrors.NotFound("No such template item is visible."));
        }

        var item = activeIds[0];
        return Result.Success(new TemplateItemAuthorization(
            templateId,
            sourceId,
            item.Id,
            Context.TenantId,
            Context.PrincipalId,
            template.WorkspaceId,
            item.Type,
            true,
            false));
    }

    /// <summary>Returns a parent-first envelope snapshot for template-profile export.</summary>
    public async ValueTask<Result<TemplateExportSnapshot>> ExportAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var template = await ActiveTemplateAsync(templateId, cancellationToken).ConfigureAwait(false);
        if (template is null
            || !await _permissions.CanReadWorkspaceAsync(template.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateExportSnapshot>(TemplateErrors.NotFound("No such template is visible."));
        }

        var items = await ActiveTreeAsync(template, cancellationToken).ConfigureAwait(false);
        var byItem = items.ToDictionary(item => item.Id, item => item.TemplateSourceId!.Value);
        var bodies = await BodyItemIdsAsync(items.Select(item => item.Id), cancellationToken).ConfigureAwait(false);
        return Result.Success(new TemplateExportSnapshot(
            template.Id,
            template.WorkspaceId,
            template.ProfileKey,
            template.Title,
            template.Description,
            template.Origin,
            template.Revision,
            template.IncludeBody,
            template.IncludeChildren,
            items.Select(item => new TemplateExportItem(
                item.TemplateSourceId!.Value,
                item.ParentId is { } parent ? byItem[parent] : null,
                item.Id,
                item.Type,
                ItemProperties.ReadTitle(item.Properties),
                item.Seq,
                item.Properties,
                item.Schema,
                item.Views,
                bodies.Contains(item.Id))).ToArray()));
    }

    private async ValueTask<WorkspaceTemplate?> ActiveTemplateAsync(
        TemplateId templateId,
        CancellationToken cancellationToken) =>
        await _database.WorkspaceTemplates.AsTracking().FirstOrDefaultAsync(
            template => template.Id == templateId
                && template.State == TemplateState.Active
                && template.RootItemId != null,
            cancellationToken).ConfigureAwait(false);

    private async ValueTask<Item?> RegularItemAsync(ItemId itemId, CancellationToken cancellationToken)
    {
        var item = await _database.Items.AsNoTracking()
            .FirstOrDefaultAsync(candidate => candidate.Id == itemId, cancellationToken)
            .ConfigureAwait(false);
        if (item is null
            || item.TemplateId is not null
            || item.LifecycleState != ItemLifecycleState.Active
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return item;
    }

    private async ValueTask<Item?> LockRegularItemAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var tenantId = Context.TenantId.Value;
        var item = await _database.Items
            .FromSqlInterpolated(
                $"SELECT * FROM item WHERE tenant_id = {tenantId} AND id = {itemId.Value} FOR UPDATE")
            .IgnoreQueryFilters()
            .AsTracking()
            .SingleOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);
        return item is { TemplateId: null, LifecycleState: ItemLifecycleState.Active } ? item : null;
    }

    private async ValueTask<List<Item>> LockItemsAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.Select(itemId => itemId.Value).Distinct().ToArray();
        if (ids.Length == 0)
        {
            return [];
        }

        return await _database.Items
            .FromSqlRaw(
                "SELECT * FROM item WHERE tenant_id = @tenant_id AND id = ANY(@item_ids) ORDER BY id FOR UPDATE",
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("item_ids", NpgsqlDbType.Array | NpgsqlDbType.Uuid) { Value = ids })
            .IgnoreQueryFilters()
            .AsTracking()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<Result<bool>> EnsureCatalogCapacityAsync(
        WorkspaceId workspaceId,
        bool addingCatalog,
        CancellationToken cancellationToken)
    {
        if (!addingCatalog)
        {
            return Result.Success(true);
        }

        var count = await _database.WorkspaceTemplates
            .Where(template => template.WorkspaceId == workspaceId)
            .Take(MaximumCatalogTemplates)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);
        return count < MaximumCatalogTemplates
            ? Result.Success(true)
            : Result.Failure<bool>(TemplateErrors.Conflict(
                $"A workspace may contain at most {MaximumCatalogTemplates:N0} template catalog entries; "
                + "remove one before adding another."));
    }

    private async ValueTask<List<Item>> ActiveTreeAsync(
        WorkspaceTemplate template,
        CancellationToken cancellationToken)
    {
        if (template.RootItemId is not { } rootId)
        {
            return [];
        }

        return await (
            from edge in _database.ItemClosure
            join item in _database.Items.IgnoreQueryFilters() on edge.DescendantId equals item.Id
            where edge.AncestorId == rootId
                && item.TemplateId == template.Id
                && item.LifecycleState == ItemLifecycleState.Active
            orderby edge.Depth, item.Seq
            select item)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<PropertySchema> ResolveHiddenTemplateSchemaAsync(
        ItemId itemId,
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var declarations = await (
            from edge in _database.ItemClosure
            join item in _database.Items.IgnoreQueryFilters() on edge.AncestorId equals item.Id
            where edge.DescendantId == itemId
                && item.TemplateId == templateId
                && item.LifecycleState == ItemLifecycleState.Provisioning
            orderby edge.Depth
            select item.Schema)
            .Take(MaximumTemplateDepth + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var effective = PropertySchema.Empty;
        var any = false;
        foreach (var schema in declarations)
        {
            var declared = PropertySchemaJson.Read(schema);
            effective = any ? PropertySchema.Merge(declared, effective) : declared;
            any = true;
            if (!declared.Inherit)
            {
                break;
            }
        }

        return effective;
    }

    private async ValueTask<List<Item>> SourceTreeAsync(
        WorkspaceId workspaceId,
        ItemId rootId,
        bool includeChildren,
        CancellationToken cancellationToken)
    {
        var root = await RegularItemAsync(rootId, cancellationToken).ConfigureAwait(false);
        if (root is null || root.WorkspaceId != workspaceId || root.LifecycleState != ItemLifecycleState.Active)
        {
            return [];
        }

        if (!includeChildren)
        {
            return [root];
        }

        return await (
            from edge in _database.ItemClosure
            join item in _database.Items on edge.DescendantId equals item.Id
            where edge.AncestorId == rootId && item.LifecycleState == ItemLifecycleState.Active
            orderby edge.Depth, item.Seq
            select item)
            .Take(MaximumTemplateItems + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask<HashSet<ItemId>> BodyItemIdsAsync(
        IEnumerable<ItemId> itemIds,
        CancellationToken cancellationToken)
    {
        var ids = itemIds.ToArray();
        return await _database.ContentDocs
            .Where(document => ids.Contains(document.ItemId))
            .Select(document => document.ItemId)
            .ToHashSetAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask DeleteTemplateRevisionAsync(
        ItemId rootItemId,
        CancellationToken cancellationToken)
    {
        var itemIds = await _database.ItemClosure
            .Where(edge => edge.AncestorId == rootItemId)
            .Select(edge => edge.DescendantId)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        if (itemIds.Length == 0)
        {
            itemIds = [rootItemId];
        }

        var isRequiredByProvisioningApplication = await (
            from mapping in _database.TemplateApplicationItems
            join application in _database.TemplateApplications
                on mapping.ApplicationId equals application.Id
            where itemIds.Contains(mapping.SourceItemId)
                && application.State == TemplateOperationState.Provisioning
            select mapping.ApplicationId)
            .AnyAsync(cancellationToken)
            .ConfigureAwait(false);
        if (isRequiredByProvisioningApplication)
        {
            return;
        }

        await _database.ItemClosure
            .Where(edge => itemIds.Contains(edge.AncestorId) || itemIds.Contains(edge.DescendantId))
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        await _database.Items.IgnoreQueryFilters()
            .Where(item => itemIds.Contains(item.Id) && item.TemplateId != null)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async ValueTask DeleteRetiredTemplateRevisionsAsync(
        TemplateId templateId,
        CancellationToken cancellationToken)
    {
        var catalog = await _database.WorkspaceTemplates
            .AsNoTracking()
            .FirstOrDefaultAsync(template => template.Id == templateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null)
        {
            return;
        }

        var retainedRoots = new[] { catalog.RootItemId, catalog.PendingRootItemId }
            .Where(static itemId => itemId is not null)
            .Select(static itemId => itemId!.Value)
            .ToHashSet();
        var retiredRoots = await _database.Items.IgnoreQueryFilters()
            .Where(item => item.TemplateId == templateId
                && item.ParentId == null
                && !retainedRoots.Contains(item.Id))
            .Select(item => item.Id)
            .ToArrayAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var retiredRoot in retiredRoots)
        {
            await DeleteTemplateRevisionAsync(retiredRoot, cancellationToken).ConfigureAwait(false);
        }
    }

    private async ValueTask TrimManagedOperationHistoryAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH ranked AS MATERIALIZED (
                SELECT operation.operation_id,
                       row_number() OVER (
                           PARTITION BY operation.template_id
                           ORDER BY operation.finalized_at DESC NULLS LAST,
                                    operation.created_at DESC,
                                    operation.operation_id DESC) AS revision_rank
                  FROM template_operation operation
                  JOIN workspace_template template
                    ON template.tenant_id = operation.tenant_id
                   AND template.template_id = operation.template_id
                 WHERE operation.tenant_id = @tenant_id
                   AND operation.workspace_id = @workspace_id
                   AND operation.kind = 'import'
                   AND operation.state = 'active'
                   AND template.origin = 'managed'
            ), deletable AS (
                SELECT ranked.operation_id
                  FROM ranked
                 WHERE ranked.revision_rank > @retained
                   AND NOT EXISTS (
                       SELECT 1
                         FROM template_operation_item operation_item
                         JOIN template_application_item application_item
                           ON application_item.tenant_id = operation_item.tenant_id
                          AND application_item.source_item_id = operation_item.target_item_id
                         JOIN template_application application
                           ON application.tenant_id = application_item.tenant_id
                          AND application.application_id = application_item.application_id
                        WHERE operation_item.operation_id = ranked.operation_id
                          AND application.state = 'provisioning'
                   )
            )
            DELETE FROM template_operation operation
             USING deletable
             WHERE operation.operation_id = deletable.operation_id
               AND operation.tenant_id = @tenant_id
            """;

        await _database.Database.ExecuteSqlRawAsync(
            sql,
            [
                new NpgsqlParameter("tenant_id", NpgsqlDbType.Uuid) { Value = Context.TenantId.Value },
                new NpgsqlParameter("workspace_id", NpgsqlDbType.Uuid) { Value = workspaceId.Value },
                new NpgsqlParameter("retained", NpgsqlDbType.Integer) { Value = RetainedManagedOperationHistory },
            ],
            cancellationToken).ConfigureAwait(false);
    }

    private static TemplateShape Shape(List<Item> items)
    {
        if (items.Count == 0)
        {
            return new TemplateShape(0, 0, 0, []);
        }

        var schema = PropertySchemaJson.Read(items[0].Schema);
        var views = ViewDefinitionsJson.Read(items[0].Views).Views;
        return new TemplateShape(
            schema.Properties.Length,
            views.Length,
            items.Count - 1,
            views.Select(view => ViewKinds.ToText(view.Kind)).Distinct(StringComparer.Ordinal).ToArray());
    }

    private static TemplateShape Shape(Item root, int childCount)
    {
        var schema = PropertySchemaJson.Read(root.Schema);
        var views = ViewDefinitionsJson.Read(root.Views).Views;
        return new TemplateShape(
            schema.Properties.Length,
            views.Length,
            childCount,
            views.Select(view => ViewKinds.ToText(view.Kind)).Distinct(StringComparer.Ordinal).ToArray());
    }

    private static TemplateItemSnapshot BuildTree(List<Item> items, HashSet<ItemId> bodies)
    {
        var children = items.ToLookup(item => item.ParentId);
        TemplateItemSnapshot Build(Item item) => new(
            item.TemplateSourceId!.Value,
            item.Type,
            ItemProperties.ReadTitle(item.Properties),
            item.Seq,
            item.Properties,
            item.Schema,
            item.Views,
            bodies.Contains(item.Id),
            children[item.Id].OrderBy(child => child.Seq).Select(Build).ToArray());

        return Build(items.Single(item => item.ParentId is null));
    }

    private static TemplateItemSnapshot? FindSnapshot(TemplateItemSnapshot current, Guid sourceId)
    {
        if (current.SourceId == sourceId)
        {
            return current;
        }

        foreach (var child in current.Children)
        {
            if (FindSnapshot(child, sourceId) is { } found)
            {
                return found;
            }
        }

        return null;
    }

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

    private async ValueTask<Result<Dictionary<Guid, ItemId>>> PriorTargetMapAsync(
        TemplateId templateId,
        ItemId targetItemId,
        WorkspaceId workspaceId,
        IReadOnlyList<Guid> currentSourceIds,
        CancellationToken cancellationToken) =>
        await LoadPriorTargetMapAsync(
            templateId,
            targetItemId,
            workspaceId,
            currentSourceIds,
            cancellationToken).ConfigureAwait(false);

    private async ValueTask<Result<Dictionary<Guid, ItemId>>> LoadPriorTargetMapAsync(
        TemplateId templateId,
        ItemId targetItemId,
        WorkspaceId workspaceId,
        IReadOnlyList<Guid> currentSourceIds,
        CancellationToken cancellationToken)
    {
        var currentSources = currentSourceIds.ToArray();
        var rows = await (
            from application in _database.TemplateApplications
            join mapping in _database.TemplateApplicationItems on application.Id equals mapping.ApplicationId
            where application.TemplateId == templateId
                && application.TargetItemId == targetItemId
                && application.State == TemplateOperationState.Active
                && currentSources.Contains(mapping.TemplateSourceId)
            select new { mapping.TemplateSourceId, mapping.TargetItemId })
            .Distinct()
            .Take(MaximumTemplateItems + 1)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (rows.Count > MaximumTemplateItems)
        {
            return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                "This target has more historical template mappings than one template can contain."));
        }

        var result = new Dictionary<Guid, ItemId>(rows.Count);
        foreach (var row in rows)
        {
            if (result.TryGetValue(row.TemplateSourceId, out var existing)
                && existing != row.TargetItemId)
            {
                return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                    $"Template source '{row.TemplateSourceId}' maps to more than one target item."));
            }

            result[row.TemplateSourceId] = row.TargetItemId;
        }

        var targetIds = result.Values.Distinct().ToArray();
        var activeTargets = targetIds.Length == 0
            ? []
            : await _database.Items.IgnoreQueryFilters()
                .Where(item => targetIds.Contains(item.Id)
                    && item.WorkspaceId == workspaceId
                    && item.TemplateId == null
                    && item.LifecycleState == ItemLifecycleState.Active)
                .Select(item => item.Id)
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
        if (activeTargets.Length != targetIds.Length)
        {
            return Result.Failure<Dictionary<Guid, ItemId>>(TemplateErrors.Conflict(
                "A previously mapped template target is deleted or no longer belongs to this workspace; "
                + "the application will not recreate or write through it."));
        }

        return Result.Success(result);
    }

    private async ValueTask<Result<TemplateCapturePlan?>> CaptureReplayAsync(
        WorkspaceId workspaceId,
        ItemId sourceItemId,
        string title,
        string? description,
        bool includeBody,
        bool includeChildren,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey
                && candidate.Kind == TemplateOperationKind.Capture,
            cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Success<TemplateCapturePlan?>(null);
        }

        var catalog = await _database.WorkspaceTemplates
            .FirstOrDefaultAsync(template => template.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null
            || operation.WorkspaceId != workspaceId
            || operation.SourceItemId != sourceItemId
            || !string.Equals(operation.DraftTitle, title, StringComparison.Ordinal)
            || !string.Equals(operation.DraftDescription, description, StringComparison.Ordinal)
            || catalog.IncludeBody != includeBody
            || catalog.IncludeChildren != includeChildren)
        {
            return Result.Failure<TemplateCapturePlan?>(
                TemplateErrors.Conflict("This idempotency key belongs to a different template capture."));
        }

        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return Result.Success<TemplateCapturePlan?>(new TemplateCapturePlan(
            operation.Id,
            operation.TemplateId,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    private async ValueTask<TemplateDraftPlan?> DraftReplayAsync(
        TemplateId templateId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.TemplateId == templateId
                    && candidate.ActorId == Context.PrincipalId
                    && candidate.IdempotencyKey == idempotencyKey
                    && candidate.Kind == TemplateOperationKind.Edit
                    && candidate.State == TemplateOperationState.Provisioning,
                cancellationToken)
            .ConfigureAwait(false);
        if (operation is null || operation.ExpiresAt <= _clock.GetUtcNow())
        {
            return null;
        }

        return await DraftPlanAsync(operation, cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Result<TemplateOperation>> LoadDraftAsync(
        TemplateId templateId,
        TemplateOperationId operationId,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(
                candidate => candidate.Id == operationId
                    && candidate.TemplateId == templateId
                    && candidate.ActorId == Context.PrincipalId
                    && candidate.Kind == TemplateOperationKind.Edit,
                cancellationToken)
            .ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.NotFound("No such template draft is visible."));
        }

        if (operation.State != TemplateOperationState.Provisioning || operation.ExpiresAt <= _clock.GetUtcNow())
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.Conflict("This template draft is no longer active."));
        }

        if (!await _permissions.CanWriteWorkspaceAsync(operation.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<TemplateOperation>(TemplateErrors.NotFound("No such template draft is visible."));
        }

        return Result.Success(operation);
    }

    private async ValueTask<TemplateDraftPlan> DraftPlanAsync(
        TemplateOperation operation,
        CancellationToken cancellationToken)
    {
        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetIds = mappings.Select(mapping => mapping.TargetItemId).ToArray();
        var items = await _database.Items.IgnoreQueryFilters()
            .Where(item => targetIds.Contains(item.Id))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var bodyTargets = mappings.Where(mapping => mapping.BodyRequired)
            .Select(mapping => mapping.TargetItemId)
            .ToHashSet();
        return new TemplateDraftPlan(
            operation.Id,
            operation.TemplateId,
            operation.DraftTitle!,
            operation.DraftDescription,
            operation.ExpiresAt,
            BuildTree(items, bodyTargets),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId!.Value.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId!.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray());
    }

    private async ValueTask ReleaseExpiredDraftAsync(
        WorkspaceTemplate template,
        CancellationToken cancellationToken)
    {
        if (template.PendingRootItemId is null)
        {
            return;
        }

        var now = _clock.GetUtcNow();
        var expired = await _database.TemplateOperations
            .AsTracking()
            .FirstOrDefaultAsync(
                operation => operation.TemplateId == template.Id
                    && operation.Kind == TemplateOperationKind.Edit
                    && operation.State == TemplateOperationState.Provisioning
                    && operation.ExpiresAt <= now,
                cancellationToken)
            .ConfigureAwait(false);
        if (expired is null)
        {
            return;
        }

        expired.State = TemplateOperationState.Aborted;
        expired.FinalizedAt = now;
        template.PendingRootItemId = null;
        template.LastModifiedBy = Context.PrincipalId;
        template.LastModifiedAt = now;
        AddAudit("template.draft_expired", template.Id.Value, template.WorkspaceId, now);
        await _database.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    }

    private async ValueTask<Result<TemplateImportPlan?>> ImportReplayAsync(
        WorkspaceId workspaceId,
        TemplateImportDescriptor descriptor,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var operation = await _database.TemplateOperations.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey
                && candidate.Kind == TemplateOperationKind.Import,
            cancellationToken).ConfigureAwait(false);
        if (operation is null)
        {
            return Result.Success<TemplateImportPlan?>(null);
        }

        var catalog = await _database.WorkspaceTemplates
            .FirstOrDefaultAsync(template => template.Id == operation.TemplateId, cancellationToken)
            .ConfigureAwait(false);
        if (catalog is null
            || operation.WorkspaceId != workspaceId
            || catalog.Origin != descriptor.Origin
            || !string.Equals(operation.DraftTitle, descriptor.Title, StringComparison.Ordinal)
            || !string.Equals(operation.DraftDescription, descriptor.Description, StringComparison.Ordinal)
            || !string.Equals(operation.ManagedSource, descriptor.ManagedSource, StringComparison.Ordinal)
            || !string.Equals(operation.SourceDigest, descriptor.Digest, StringComparison.Ordinal)
            || catalog.IncludeBody != descriptor.IncludeBody
            || catalog.IncludeChildren != descriptor.IncludeChildren
            || !string.Equals(catalog.ProfileKey, descriptor.StableKey, StringComparison.Ordinal))
        {
            return Result.Failure<TemplateImportPlan?>(
                TemplateErrors.Conflict("This idempotency key belongs to a different template import."));
        }

        var mappings = await _database.TemplateOperationItems
            .Where(mapping => mapping.OperationId == operation.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (operation.State == TemplateOperationState.Active
            && descriptor.Origin == TemplateOrigin.Managed
            && (catalog.State != TemplateState.Active
                || catalog.RootItemId is null
                || !string.Equals(catalog.SourceDigest, operation.SourceDigest, StringComparison.Ordinal)
                || !mappings.Any(mapping => mapping.TargetItemId == catalog.RootItemId.Value)))
        {
            // Managed-file idempotency keys are stable by digest. A retained A operation must not
            // replay after the catalog moved to B: its mappings describe the retired A revision,
            // not a no-op against B. Retire only the completed operation record (application
            // mappings independently retain any old source items they still need), freeing the
            // digest key for a fresh A revision.
            await _database.TemplateOperations
                .Where(candidate => candidate.Id == operation.Id)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);
            return Result.Success<TemplateImportPlan?>(null);
        }

        return Result.Success<TemplateImportPlan?>(new TemplateImportPlan(
            operation.Id,
            operation.TemplateId,
            operation.State == TemplateOperationState.Active,
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired).Select(mapping => new TemplateBodyWrite(
                mapping.TemplateSourceId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray()));
    }

    private async ValueTask<TemplateApplicationPlan?> ApplicationReplayAsync(
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var application = await _database.TemplateApplications.FirstOrDefaultAsync(
            candidate => candidate.ActorId == Context.PrincipalId
                && candidate.IdempotencyKey == idempotencyKey,
            cancellationToken).ConfigureAwait(false);
        if (application is null)
        {
            return null;
        }

        var mappings = await _database.TemplateApplicationItems
            .Where(mapping => mapping.ApplicationId == application.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return new TemplateApplicationPlan(
            application.Id,
            application.TemplateId,
            application.TargetItemId,
            application.State == TemplateOperationState.Active,
            mappings.Where(mapping => mapping.Created).Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Select(mapping => new TemplateItemMapping(
                mapping.SourceItemId.Value,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray(),
            mappings.Where(mapping => mapping.BodyRequired
                && application.State != TemplateOperationState.Active).Select(mapping => new TemplateBodyCopy(
                mapping.SourceItemId,
                mapping.TargetItemId,
                mapping.ItemType)).ToArray());
    }

    private void AddAudit(string action, Guid subjectId, WorkspaceId workspaceId, DateTimeOffset at) =>
        _database.AuditEvents.Add(new AuditEvent
        {
            Id = AuditEventId.Create(),
            TenantId = Context.TenantId,
            WorkspaceId = workspaceId,
            ActorId = Context.PrincipalId,
            Action = action,
            SubjectId = subjectId,
            SubjectType = "template",
            OccurredAt = at,
        });

    private static bool InvalidKey(string value) => string.IsNullOrWhiteSpace(value) || value.Length > 160;

    private static bool SameSet(IEnumerable<ItemId> expected, IEnumerable<ItemId> actual) =>
        expected.ToHashSet().SetEquals(actual);

    private static string OriginText(TemplateOrigin origin) => origin switch
    {
        TemplateOrigin.Seed => "seeded",
        TemplateOrigin.User => "user-authored",
        TemplateOrigin.Managed => "managed",
        _ => throw new ArgumentOutOfRangeException(nameof(origin), origin, "Unknown template origin."),
    };
}
