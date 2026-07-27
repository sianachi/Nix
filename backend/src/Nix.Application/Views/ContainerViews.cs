using System.Collections.Immutable;
using Nix.Application.Authorization;
using Nix.Application.Items;
using Nix.Application.Persistence;
using Nix.Application.Properties;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Properties;
using Nix.Core.Views;

namespace Nix.Application.Views;

/// <summary>A container's views, and whether each can currently render.</summary>
/// <param name="Views">The views the container offers, in switcher order.</param>
/// <param name="Unrenderable">
/// The identifiers of views whose configured property no longer exists or no longer fits.
/// </param>
/// <remarks>
/// The second list is what stops a board whose grouping property was deleted from rendering as an
/// empty board - which is indistinguishable from an empty folder, and sends somebody looking for
/// their missing items instead of their missing property.
/// </remarks>
public sealed record ContainerViewSet(
    ImmutableArray<ViewDefinition> Views,
    ImmutableArray<string> Unrenderable);

/// <summary>Reads the views a container offers.</summary>
public sealed class GetContainerViews
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="GetContainerViews"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="schemas">Resolves the schema a view is checked against.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public GetContainerViews(IItemTree tree, ISchemaResolver schemas, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(permissions);

        _tree = tree;
        _schemas = schemas;
        _permissions = permissions;
    }

    /// <summary>Reads the views.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The views, or why they could not be read.</returns>
    public async ValueTask<Result<ContainerViewSet>> ExecuteAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<ContainerViewSet>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var views = ViewDefinitionsJson.Read(item.Views);
        if (views.IsEmpty)
        {
            return Result.Success(new ContainerViewSet([], []));
        }

        // The schema a view's configuration is checked against is the one its children carry,
        // which is the schema at the container itself.
        var schema = await _schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        var unrenderable = views
            .Where(view => !view.CanRender(schema))
            .Select(view => view.Id)
            .ToImmutableArray();

        return Result.Success(new ContainerViewSet(views, unrenderable));
    }
}

/// <summary>Replaces the views a container offers.</summary>
/// <remarks>
/// <b>A whole-set replacement rather than per-view edits.</b> The set is small, bounded and
/// ordered, and the order is part of what is being edited - a switcher's tabs are dragged into an
/// order as often as an individual view is renamed. Per-view endpoints would make reordering a
/// sequence of writes that can half-apply.
/// </remarks>
public sealed class SetContainerViews
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="SetContainerViews"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public SetContainerViews(
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
    /// <param name="itemId">The container.</param>
    /// <param name="views">The views to offer, in switcher order.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The stored views, or why they could not be stored.</returns>
    public async ValueTask<Result<ImmutableArray<ViewDefinition>>> ExecuteAsync(
        ItemId itemId,
        ImmutableArray<ViewDefinition> views,
        CancellationToken cancellationToken)
    {
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

        if (Refuse(views) is { } refusal)
        {
            return Result.Failure<ImmutableArray<ViewDefinition>>(refusal);
        }

        var json = ViewDefinitionsJson.Write(views);
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
    private static NixError? Refuse(ImmutableArray<ViewDefinition> views)
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

            var missing = view.Kind switch
            {
                ViewKind.Board when view.GroupBy is null => "a board needs a property to group by",
                ViewKind.Calendar when view.DateProperty is null => "a calendar needs a date property",
                _ => null,
            };

            if (missing is not null)
            {
                return PropertyErrors.InvalidViews($"'{view.Name}': {missing}.");
            }
        }

        return null;
    }
}
