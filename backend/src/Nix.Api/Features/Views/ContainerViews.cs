using System.Collections.Immutable;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Views;
using Nix.Features.Items;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Views;

/// <summary>A container's views, and whether each can currently render.</summary>
/// <param name="Views">The views the container offers, in switcher order.</param>
/// <param name="Unrenderable">
/// The identifiers of views whose configured property no longer exists or no longer fits.
/// </param>
/// <param name="Default">
/// What opens: a view's id, or <c>document</c> for the item's own body. Already resolved, so a
/// default naming a deleted view arrives here as <c>document</c> rather than as a dangling id.
/// </param>
/// <remarks>
/// The second list is what stops a board whose grouping property was deleted from rendering as an
/// empty board - which is indistinguishable from an item with nothing in it, and sends somebody looking for
/// their missing items instead of their missing property.
/// </remarks>
public sealed record ContainerViewSet(
    ImmutableArray<ViewDefinition> Views,
    ImmutableArray<string> Unrenderable,
    string Default);

/// <summary>Reads the views a container offers.</summary>
/// <param name="ItemId">The container.</param>
public sealed record GetContainerViews(ItemId ItemId) : IQuery<Result<ContainerViewSet>>;

/// <summary>Handles <see cref="GetContainerViews"/>.</summary>
public sealed class GetContainerViewsHandler : IQueryHandler<GetContainerViews, Result<ContainerViewSet>>
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="GetContainerViewsHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="schemas">Resolves the schema a view is checked against.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public GetContainerViewsHandler(IItemTree tree, ISchemaResolver schemas, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(permissions);

        _tree = tree;
        _schemas = schemas;
        _permissions = permissions;
    }

    /// <summary>Reads the views.</summary>
    /// <param name="query">The container whose views are wanted.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The views, or why they could not be read.</returns>
    public async ValueTask<Result<ContainerViewSet>> HandleAsync(
        GetContainerViews query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);

        var itemId = query.ItemId;

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ContainerViewSet>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var stored = ViewDefinitionsJson.Read(item.Views);
        var views = stored.Views;
        if (views.IsEmpty)
        {
            return Result.Success(new ContainerViewSet([], [], ViewDefinitionsJson.DocumentView));
        }

        // The schema a view's configuration is checked against is the one its children carry,
        // which is the schema at the container itself.
        var schema = await _schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        var unrenderable = views
            .Where(view => !view.CanRender(schema))
            .Select(view => view.Id)
            .ToImmutableArray();

        return Result.Success(new ContainerViewSet(views, unrenderable, stored.Resolve()));
    }
}

/// <summary>Replaces the views a container offers.</summary>
/// <param name="ItemId">The container.</param>
/// <param name="Views">The views to offer, in switcher order.</param>
/// <param name="DefaultView">
/// Which view opens: a view's id, or <c>document</c> / <see langword="null"/> for the body.
/// </param>
/// <remarks>
/// <b>A whole-set replacement rather than per-view edits.</b> The set is small, bounded and
/// ordered, and the order is part of what is being edited - a switcher's tabs are dragged into an
/// order as often as an individual view is renamed. Per-view endpoints would make reordering a
/// sequence of writes that can half-apply.
/// </remarks>
public sealed record SetContainerViews(ItemId ItemId, ImmutableArray<ViewDefinition> Views, string? DefaultView)
    : ICommand<ImmutableArray<ViewDefinition>>;

/// <summary>Handles <see cref="SetContainerViews"/>.</summary>
public sealed class SetContainerViewsHandler
    : ICommandHandler<SetContainerViews, ImmutableArray<ViewDefinition>>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="SetContainerViewsHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public SetContainerViewsHandler(
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

    /// <summary>Sets the views.</summary>
    /// <param name="command">The container, the views to offer, and which one opens.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The stored views, or why they could not be stored.</returns>
    public async ValueTask<Result<ImmutableArray<ViewDefinition>>> HandleAsync(
        SetContainerViews command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var itemId = command.ItemId;
        var views = command.Views;
        var defaultView = command.DefaultView;

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                ItemErrors.LifecycleConflict("A deleted container's views cannot be changed."));
        }

        if (Refuse(views, defaultView) is { } refusal)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(refusal);
        }

        var json = ViewDefinitionsJson.Write(views, defaultView);
        if (json is not null
            && System.Text.Encoding.UTF8.GetByteCount(json) > ViewDefinitionsJson.MaximumBytes)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(
                PropertyErrors.InvalidViews(
                    $"A container's views may be at most {ViewDefinitionsJson.MaximumBytes} bytes."));
        }

        await _tree
            .UpdateViewsAsync(itemId, json, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(views);
    }

    /// <summary>
    /// Every reason a view set is not storable, or null when it is fine.
    /// </summary>
    /// <remarks>
    /// <b>What is deliberately not checked here: whether the configured property exists.</b> A
    /// board may be configured before the property it groups by is declared, and a property may be
    /// deleted from under a board that was fine yesterday. Refusing either would make the order of
    /// two independent edits matter. The read path reports such a view as unrenderable instead,
    /// which is a thing the interface can explain.
    /// </remarks>
    private static NixError? Refuse(ImmutableArray<ViewDefinition> views, string? defaultView)
    {
        if (views.Length > ViewDefinitionsJson.MaximumViews)
        {
            return PropertyErrors.InvalidViews(
                $"A container may offer at most {ViewDefinitionsJson.MaximumViews} views.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);

        foreach (var view in views)
        {
            if (view.Id.Length == 0)
            {
                return PropertyErrors.InvalidViews("Every view needs an identifier.");
            }

            if (!ids.Add(view.Id))
            {
                return PropertyErrors.InvalidViews(
                    $"'{view.Id}' is used by more than one view; a shared link names one view.");
            }

            if (view.Name.Length == 0)
            {
                return PropertyErrors.InvalidViews("Every view needs a name.");
            }

            // The word names the item's own body in the same field that names a view, so a view
            // may not answer to it. Ids are slugs derived from names, and "Document" is a name
            // somebody will reasonably pick.
            if (string.Equals(view.Id, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal))
            {
                return PropertyErrors.InvalidViews(
                    $"'{ViewDefinitionsJson.DocumentView}' is reserved for the item's own body; "
                        + "give this view another name.");
            }

            // What each kind needs is declared once, in ViewKinds.All. A kind with no requirement,
            // and a kind whose required field is set, both pass.
            if (ViewKinds.Find(view.Kind)?.Requirement is { } requirement
                && requirement.Read(view) is null)
            {
                return PropertyErrors.InvalidViews($"'{view.Name}': {requirement.Missing}.");
            }

            // The one per-kind field whose value set is closed. Not gated to galleries - like
            // coverProperty on a board, a size on a kind that does not read it is stored and
            // ignored (ADR-0020: cheap to ignore, expensive to police) - but the *value* has to be
            // one this build defines, because nothing anywhere gives "huge" a meaning to fall back
            // to. Mode's strays are defaulted instead; GalleryCardSizes says why the two differ.
            if (view.CardSize is { } size && !GalleryCardSizes.IsValid(size))
            {
                return PropertyErrors.InvalidViews(
                    $"'{view.Name}': '{size}' is not a card size; "
                        + $"use '{GalleryCardSizes.Small}', '{GalleryCardSizes.Medium}' or '{GalleryCardSizes.Large}'.");
            }
        }

        // A default has to name something that will still be there once this write lands. Storing
        // one that does not would resolve to the document on the next read, so the person's choice
        // would appear to have been taken and then quietly discarded.
        if (defaultView is { } chosen
            && chosen.Length > 0
            && !string.Equals(chosen, ViewDefinitionsJson.DocumentView, StringComparison.Ordinal)
            && !ids.Contains(chosen))
        {
            return PropertyErrors.InvalidViews(
                $"'{chosen}' is not one of these views, so it cannot be the one that opens.");
        }

        return null;
    }
}

/// <summary>
/// Route handler for reading the views a container offers.
/// </summary>
/// <remarks>
/// Named apart from <see cref="GetContainerViews"/> itself: the query record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapGet</c> call site.
/// </remarks>
internal static class GetContainerViewsEndpoint
{
    /// <summary>Handles a request for the views a container offers.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the query to its handler.</param>
    /// <returns>The views, or a problem describing why they could not be read.</returns>
    internal static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            views => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. views.Views.Select(ViewMapping.ToResponse)],
                    views.Unrenderable,
                    views.Default)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}

/// <summary>
/// Route handler for replacing the views a container offers.
/// </summary>
/// <remarks>
/// Named apart from <see cref="SetContainerViews"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPut</c> call site.
/// </remarks>
internal static class SetContainerViewsEndpoint
{
    /// <summary>Handles a request to replace the views a container offers.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="request">The views to offer, and which one should open.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command and the follow-up query to their handlers.</param>
    /// <returns>The stored views, or a problem describing why the write failed.</returns>
    internal static async Task<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>> Handle(
        Guid itemId,
        SetViewsRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        if (!ViewMapping.TryToDomain(request, out var views, out var unknownKind))
        {
            return TypedResults.Problem(
                StructureEndpoints.Problem(
                    httpContext,
                    PropertyErrors.InvalidViews($"'{unknownKind}' is not a view kind.")));
        }

        var stored = await dispatcher
            .SendAsync<SetContainerViews, ImmutableArray<ViewDefinition>>(
                new SetContainerViews(ItemId.From(itemId), views, request.Default),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        if (stored.IsFailure)
        {
            return TypedResults.Problem(StructureEndpoints.Problem(httpContext, stored.Error));
        }

        // Read back so the response carries the unrenderable list, which the write path does not
        // compute and the caller needs in order to say anything honest about what it just saved.
        var reread = await dispatcher
            .QueryAsync<GetContainerViews, Result<ContainerViewSet>>(
                new GetContainerViews(ItemId.From(itemId)),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return reread.Match<Results<Ok<ContainerViewsResponse>, ProblemHttpResult>>(
            set => TypedResults.Ok(
                new ContainerViewsResponse(
                    [.. set.Views.Select(ViewMapping.ToResponse)],
                    set.Unrenderable,
                    set.Default)),
            error => TypedResults.Problem(StructureEndpoints.Problem(httpContext, error)));
    }
}
