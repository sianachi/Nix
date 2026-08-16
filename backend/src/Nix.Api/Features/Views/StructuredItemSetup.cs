using System.Collections.Immutable;
using System.Text;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Contracts;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Domain.Views;
using Nix.Errors;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Views;

internal sealed record CreateStructuredItemRequest(
    string Type,
    string Title,
    Guid? ParentId,
    SetSchemaRequest Schema,
    SetViewsRequest Views,
    string? PublishInteractiveFormViewId);

internal sealed record AppendViewSetupRequest(
    IReadOnlyList<PropertyDefinitionRequest> Properties,
    IReadOnlyList<ViewRequest> Views,
    bool MakeDefault,
    string? PublishInteractiveFormViewId);

internal sealed record ReplaceViewSetupRequest(
    SetSchemaRequest Schema,
    IReadOnlyList<string> OriginalPropertyKeys,
    IReadOnlyList<ViewRequest> Views,
    string? PublishInteractiveFormViewId);

internal sealed record StructuredItemResponse(
    ItemResponse Item,
    EffectiveSchemaResponse Schema,
    ContainerViewsResponse Views,
    PublicFormLinkResponse? PublicForm);

public sealed record CreateStructuredItem(
    WorkspaceId WorkspaceId,
    string Type,
    string Title,
    ItemId? ParentId,
    PropertySchema Schema,
    ImmutableArray<ViewDefinition> Views,
    string DefaultView) : ICommand<Item>;

public sealed class CreateStructuredItemHandler : ICommandHandler<CreateStructuredItem, Item>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    public CreateStructuredItemHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        _tree = tree;
        _permissions = permissions;
        _session = session;
        _clock = clock;
    }

    public async ValueTask<Result<Item>> HandleAsync(
        CreateStructuredItem command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        if (string.IsNullOrWhiteSpace(command.Type) || string.IsNullOrWhiteSpace(command.Title))
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews("A structured item needs a name and type."));
        }

        if (command.Views.IsDefaultOrEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews(
                "A structured item needs at least one configured view."));
        }

        if (!await _tree.WorkspaceExistsAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false)
            || !await _permissions.CanWriteWorkspaceAsync(command.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.WorkspaceNotFound("This workspace is not visible."));
        }

        if (command.ParentId is { } parentId)
        {
            var parent = await _tree.FindAsync(parentId, cancellationToken).ConfigureAwait(false);
            if (parent is null || parent.WorkspaceId != command.WorkspaceId)
            {
                return Result.Failure<Item>(ItemErrors.ParentNotFound("The selected destination is not visible."));
            }
        }

        if (SetItemSchemaHandler.Validate(command.Schema) is { } schemaError)
        {
            return Result.Failure<Item>(schemaError);
        }

        if (SetContainerViewsHandler.Validate(command.Views, command.DefaultView) is { } viewError)
        {
            return Result.Failure<Item>(viewError);
        }

        var schemaJson = command.Schema.IsEmpty ? null : PropertySchemaJson.Write(command.Schema);
        var viewsJson = ViewDefinitionsJson.Write(command.Views, command.DefaultView);
        if ((schemaJson is not null && Encoding.UTF8.GetByteCount(schemaJson) > PropertyValidator.MaximumBytes)
            || (viewsJson is not null && Encoding.UTF8.GetByteCount(viewsJson) > ViewDefinitionsJson.MaximumBytes))
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews("This setup is too large to store."));
        }

        var now = _clock.GetUtcNow();
        var item = new Item
        {
            Id = ItemId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = command.WorkspaceId,
            Type = command.Type,
            ParentId = command.ParentId,
            Seq = await _tree.NextSiblingSequenceAsync(
                command.WorkspaceId,
                command.ParentId,
                cancellationToken).ConfigureAwait(false),
            Properties = ItemProperties.WithTitle(null, command.Title),
            Schema = schemaJson,
            Views = viewsJson,
            LifecycleState = ItemLifecycleState.Active,
            PurgeAfter = null,
            CreatedBy = context.PrincipalId,
            LastModifiedBy = context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };
        await _tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        return Result.Success(item);
    }
}

public sealed record AppendViewSetup(
    ItemId ItemId,
    ImmutableArray<PropertyDefinition> Properties,
    ImmutableArray<ViewDefinition> Views,
    bool MakeDefault) : ICommand<Item>;

public sealed class AppendViewSetupHandler : ICommandHandler<AppendViewSetup, Item>
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    public AppendViewSetupHandler(
        IItemTree tree,
        ISchemaResolver schemas,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        _tree = tree;
        _schemas = schemas;
        _permissions = permissions;
        _session = session;
        _clock = clock;
    }

    public async ValueTask<Result<Item>> HandleAsync(
        AppendViewSetup command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var item = await _tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound("This item is not visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(ItemErrors.LifecycleConflict("A deleted item cannot be configured."));
        }

        if (command.Views.IsDefaultOrEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews(
                "A guided setup needs at least one configured view."));
        }

        var effective = await _schemas.ResolveForChildrenAsync(item.Id, cancellationToken).ConfigureAwait(false);
        var additions = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in command.Properties)
        {
            if (effective.Find(property.Key) is not null || !additions.Add(property.Key))
            {
                return Result.Failure<Item>(PropertyErrors.SetupCollision(
                    $"A field already uses '{property.Key}'. Return to Fields and choose another name."));
            }
        }

        var storedViews = ViewDefinitionsJson.Read(item.Views);
        var viewIds = storedViews.Views.Select(view => view.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var view in command.Views)
        {
            if (!viewIds.Add(view.Id))
            {
                return Result.Failure<Item>(PropertyErrors.SetupCollision(
                    $"A view already uses '{view.Id}'. Return to Basics and choose another name."));
            }
        }

        var declared = PropertySchemaJson.Read(item.Schema);
        var mergedSchema = declared with { Properties = [.. declared.Properties, .. command.Properties] };
        var mergedViews = storedViews.Views.AddRange(command.Views);
        var defaultView = command.MakeDefault && !command.Views.IsDefaultOrEmpty
            ? command.Views[0].Id
            : storedViews.Default;
        if (SetItemSchemaHandler.Validate(mergedSchema) is { } schemaError)
        {
            return Result.Failure<Item>(schemaError);
        }

        if (SetContainerViewsHandler.Validate(mergedViews, defaultView) is { } viewError)
        {
            return Result.Failure<Item>(viewError);
        }

        var schemaJson = mergedSchema.IsEmpty ? null : PropertySchemaJson.Write(mergedSchema);
        var viewsJson = ViewDefinitionsJson.Write(mergedViews, defaultView);
        if ((schemaJson is not null && Encoding.UTF8.GetByteCount(schemaJson) > PropertyValidator.MaximumBytes)
            || (viewsJson is not null && Encoding.UTF8.GetByteCount(viewsJson) > ViewDefinitionsJson.MaximumBytes))
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews("This setup is too large to store."));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = _clock.GetUtcNow();
        await _tree.UpdateSchemaAsync(item.Id, schemaJson, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);
        await _tree.UpdateViewsAsync(item.Id, viewsJson, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(item);
    }
}

public sealed record ReplaceViewSetup(
    ItemId ItemId,
    string OriginalViewId,
    PropertySchema Schema,
    ImmutableArray<string> OriginalPropertyKeys,
    ImmutableArray<ViewDefinition> Views) : ICommand<Item>;

public sealed class ReplaceViewSetupHandler : ICommandHandler<ReplaceViewSetup, Item>
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    public ReplaceViewSetupHandler(
        IItemTree tree,
        ISchemaResolver schemas,
        IPermissionResolver permissions,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);
        _tree = tree;
        _schemas = schemas;
        _permissions = permissions;
        _session = session;
        _clock = clock;
    }

    public async ValueTask<Result<Item>> HandleAsync(
        ReplaceViewSetup command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var item = await _tree.FindAsync(command.ItemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound("This item is not visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(ItemErrors.LifecycleConflict("A deleted item cannot be configured."));
        }

        if (command.Views.IsDefaultOrEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews(
                "A guided setup needs at least one configured view."));
        }

        var originalPropertyKeys = command.OriginalPropertyKeys.ToHashSet(StringComparer.Ordinal);
        if (originalPropertyKeys.Count != command.OriginalPropertyKeys.Length)
        {
            return Result.Failure<Item>(PropertyErrors.SetupCollision(
                "The view setup contains duplicate original field identifiers. Reopen it and try again."));
        }

        var declared = PropertySchemaJson.Read(item.Schema);
        var currentByKey = declared.Properties.ToDictionary(property => property.Key, StringComparer.Ordinal);
        if (originalPropertyKeys.Any(key => !currentByKey.ContainsKey(key)))
        {
            return Result.Failure<Item>(PropertyErrors.SetupCollision(
                "A field was removed while this setup was open. Reopen the studio to use the latest schema."));
        }

        var effective = await _schemas.ResolveForChildrenAsync(item.Id, cancellationToken).ConfigureAwait(false);
        foreach (var property in command.Schema.Properties)
        {
            if (!originalPropertyKeys.Contains(property.Key) && effective.Find(property.Key) is not null)
            {
                return Result.Failure<Item>(PropertyErrors.SetupCollision(
                    $"A field already uses '{property.Key}'. Return to Fields and choose another name."));
            }
        }

        var nextSchema = command.Schema with
        {
            Properties =
            [
                .. declared.Properties.Where(property => !originalPropertyKeys.Contains(property.Key)),
                .. command.Schema.Properties,
            ],
        };

        var stored = ViewDefinitionsJson.Read(item.Views);
        var originalIndex = -1;
        for (var index = 0; index < stored.Views.Length; index++)
        {
            if (string.Equals(stored.Views[index].Id, command.OriginalViewId, StringComparison.Ordinal))
            {
                originalIndex = index;
                break;
            }
        }
        if (originalIndex < 0)
        {
            return Result.Failure<Item>(PropertyErrors.SetupCollision(
                "This view was removed while its setup was open."));
        }

        var original = stored.Views[originalIndex];
        var removedIds = new HashSet<string>(StringComparer.Ordinal) { original.Id };
        if (original.CompanionViewId is { } originalCompanion)
        {
            removedIds.Add(originalCompanion);
        }

        var remaining = stored.Views.Where(view => !removedIds.Contains(view.Id)).ToList();
        var remainingIds = remaining.Select(view => view.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var replacement in command.Views)
        {
            if (!remainingIds.Add(replacement.Id))
            {
                return Result.Failure<Item>(PropertyErrors.SetupCollision(
                    $"A view already uses '{replacement.Id}'. Return to Basics and choose another name."));
            }
        }

        remaining.InsertRange(Math.Min(originalIndex, remaining.Count), command.Views);
        var nextViews = remaining.ToImmutableArray();
        var nextDefault = stored.Default is { } storedDefault && removedIds.Contains(storedDefault)
            ? command.Views[0].Id
            : stored.Default;
        if (SetItemSchemaHandler.Validate(nextSchema) is { } schemaError)
        {
            return Result.Failure<Item>(schemaError);
        }

        if (SetContainerViewsHandler.Validate(nextViews, nextDefault) is { } viewError)
        {
            return Result.Failure<Item>(viewError);
        }

        var schemaJson = nextSchema.IsEmpty ? null : PropertySchemaJson.Write(nextSchema);
        var viewsJson = ViewDefinitionsJson.Write(nextViews, nextDefault);
        if ((schemaJson is not null && Encoding.UTF8.GetByteCount(schemaJson) > PropertyValidator.MaximumBytes)
            || (viewsJson is not null && Encoding.UTF8.GetByteCount(viewsJson) > ViewDefinitionsJson.MaximumBytes))
        {
            return Result.Failure<Item>(PropertyErrors.InvalidViews("This setup is too large to store."));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");
        var now = _clock.GetUtcNow();
        await _tree.UpdateSchemaAsync(item.Id, schemaJson, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);
        await _tree.UpdateViewsAsync(item.Id, viewsJson, context.PrincipalId, now, cancellationToken)
            .ConfigureAwait(false);
        return Result.Success(item);
    }
}

internal static class StructuredItemSetupEndpoints
{
    internal static async Task<Results<Created<StructuredItemResponse>, ProblemHttpResult>> Create(
        Guid workspaceId,
        CreateStructuredItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IPublicFormStore publicForms,
        [FromServices] ISchemaResolver schemas,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] PublicFormTokenService tokens,
        [FromServices] TimeProvider clock)
    {
        if (!PropertyMapping.TryToDomain(request.Schema, out var schema, out var unknownType))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidSchema($"'{unknownType}' is not a property type.")));
        }

        if (!ViewMapping.TryToDomain(request.Views, out var views, out var unknownKind))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews($"'{unknownKind}' is not a view kind.")));
        }

        var result = await dispatcher.SendAsync<CreateStructuredItem, Item>(
            new CreateStructuredItem(
                WorkspaceId.From(workspaceId),
                request.Type,
                request.Title,
                request.ParentId is { } parent ? ItemId.From(parent) : null,
                schema,
                views,
                request.Views.Default ?? ViewDefinitionsJson.DocumentView),
            httpContext.RequestAborted).ConfigureAwait(false);

        if (result.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, result.Error));
        }

        var item = result.Value;
        var publicForm = await PublishIfRequested(
            request.PublishInteractiveFormViewId,
            views,
            item,
            httpContext,
            publicForms,
            schemas,
            session,
            tokens,
            clock).ConfigureAwait(false);
        if (request.PublishInteractiveFormViewId is not null && publicForm is null)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews("The interactive form could not be published.")));
        }

        var response = new StructuredItemResponse(
            ItemMapping.ToResponse(item, false),
            PropertyMapping.ToResponse(schema, schema),
            new ContainerViewsResponse([.. views.Select(ViewMapping.ToResponse)], [], request.Views.Default ?? "document"),
            publicForm);
        return TypedResults.Created($"/api/v1/items/{item.Id}", response);
    }

    internal static async Task<Results<Ok<StructuredItemResponse>, ProblemHttpResult>> Append(
        Guid itemId,
        AppendViewSetupRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IPublicFormStore publicForms,
        [FromServices] ISchemaResolver schemas,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] PublicFormTokenService tokens,
        [FromServices] TimeProvider clock)
    {
        var schemaRequest = new SetSchemaRequest(request.Properties, true);
        if (!PropertyMapping.TryToDomain(schemaRequest, out var schema, out var unknownType))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidSchema($"'{unknownType}' is not a property type.")));
        }

        var viewsRequest = new SetViewsRequest(request.Views, null);
        if (!ViewMapping.TryToDomain(viewsRequest, out var views, out var unknownKind))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews($"'{unknownKind}' is not a view kind.")));
        }

        var result = await dispatcher.SendAsync<AppendViewSetup, Item>(
            new AppendViewSetup(ItemId.From(itemId), schema.Properties, views, request.MakeDefault),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, result.Error));
        }

        var effective = await dispatcher.QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
            new GetEffectiveSchema(ItemId.From(itemId)),
            httpContext.RequestAborted).ConfigureAwait(false);
        var stored = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
            new GetContainerViews(ItemId.From(itemId)),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (effective.IsFailure || stored.IsFailure)
        {
            var error = effective.IsFailure ? effective.Error : stored.Error;
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, error));
        }

        var publicForm = await PublishIfRequested(
            request.PublishInteractiveFormViewId,
            views,
            result.Value,
            httpContext,
            publicForms,
            schemas,
            session,
            tokens,
            clock).ConfigureAwait(false);
        if (request.PublishInteractiveFormViewId is not null && publicForm is null)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews("The interactive form could not be published.")));
        }

        return TypedResults.Ok(new StructuredItemResponse(
            ItemMapping.ToResponse(result.Value, false),
            PropertyMapping.ToResponse(effective.Value.Effective, effective.Value.Declared),
            new ContainerViewsResponse(
                [.. stored.Value.Views.Select(ViewMapping.ToResponse)],
                stored.Value.Unrenderable,
                stored.Value.Default),
            publicForm));
    }

    internal static async Task<Results<Ok<StructuredItemResponse>, ProblemHttpResult>> Replace(
        Guid itemId,
        string viewId,
        ReplaceViewSetupRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher,
        [FromServices] IPublicFormStore publicForms,
        [FromServices] ISchemaResolver schemas,
        [FromServices] INixSessionContextAccessor session,
        [FromServices] PublicFormTokenService tokens,
        [FromServices] TimeProvider clock)
    {
        if (!PropertyMapping.TryToDomain(request.Schema, out var schema, out var unknownType))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidSchema($"'{unknownType}' is not a property type.")));
        }

        var viewsRequest = new SetViewsRequest(request.Views, null);
        if (!ViewMapping.TryToDomain(viewsRequest, out var views, out var unknownKind))
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews($"'{unknownKind}' is not a view kind.")));
        }

        var result = await dispatcher.SendAsync<ReplaceViewSetup, Item>(
            new ReplaceViewSetup(
                ItemId.From(itemId),
                viewId,
                schema,
                [.. request.OriginalPropertyKeys ?? []],
                views),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (result.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, result.Error));
        }

        var effective = await dispatcher.QueryAsync<GetEffectiveSchema, Result<EffectiveSchema>>(
            new GetEffectiveSchema(ItemId.From(itemId)),
            httpContext.RequestAborted).ConfigureAwait(false);
        var stored = await dispatcher.QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
            new GetContainerViews(ItemId.From(itemId)),
            httpContext.RequestAborted).ConfigureAwait(false);
        if (effective.IsFailure || stored.IsFailure)
        {
            var error = effective.IsFailure ? effective.Error : stored.Error;
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, error));
        }

        var publicForm = await PublishIfRequested(
            request.PublishInteractiveFormViewId,
            views,
            result.Value,
            httpContext,
            publicForms,
            schemas,
            session,
            tokens,
            clock).ConfigureAwait(false);
        if (request.PublishInteractiveFormViewId is not null && publicForm is null)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(
                httpContext,
                PropertyErrors.InvalidViews("The interactive form could not be published.")));
        }

        return TypedResults.Ok(new StructuredItemResponse(
            ItemMapping.ToResponse(result.Value, false),
            PropertyMapping.ToResponse(effective.Value.Effective, effective.Value.Declared),
            new ContainerViewsResponse(
                [.. stored.Value.Views.Select(ViewMapping.ToResponse)],
                stored.Value.Unrenderable,
                stored.Value.Default),
            publicForm));
    }

    private static async Task<PublicFormLinkResponse?> PublishIfRequested(
        string? viewId,
        ImmutableArray<ViewDefinition> views,
        Item item,
        HttpContext httpContext,
        IPublicFormStore publicForms,
        ISchemaResolver schemas,
        INixSessionContextAccessor session,
        PublicFormTokenService tokens,
        TimeProvider clock)
    {
        if (viewId is null)
        {
            return null;
        }

        var view = views.FirstOrDefault(
            candidate => string.Equals(candidate.Id, viewId, StringComparison.Ordinal));
        return view is null
            ? null
            : await PublicFormEndpoints.PublishConfiguredAsync(
                item,
                view,
                httpContext,
                publicForms,
                schemas,
                session,
                tokens,
                clock).ConfigureAwait(false);
    }
}
