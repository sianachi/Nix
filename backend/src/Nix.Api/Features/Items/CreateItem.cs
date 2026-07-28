using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Nix.Abstractions;
using Nix.Domain.Items;
using Nix.Domain.Primitives;
using Nix.Domain.Properties;
using Nix.Domain.Tenancy;
using Nix.Features.Properties;
using Nix.Messaging;

namespace Nix.Features.Items;

/// <summary>
/// Creates an item under a parent, or at the workspace root.
/// </summary>
/// <param name="WorkspaceId">The workspace to create it in.</param>
/// <param name="Type">Its kind.</param>
/// <param name="Title">Its display name.</param>
/// <param name="ParentId">The parent, or <see langword="null"/> for a workspace root.</param>
/// <param name="Properties">
/// Values to give it on creation, or <see langword="null"/> for none.
/// </param>
/// <remarks>
/// The server mints the identifier and chooses the sibling position. A client that could supply
/// either would be able to collide with an item it cannot see - which, in a system where "cannot
/// see" is the security boundary, is a way to learn that the invisible item exists.
/// </remarks>
public sealed record CreateItem(
    WorkspaceId WorkspaceId,
    string Type,
    string Title,
    ItemId? ParentId,
    JsonObject? Properties) : ICommand<Item>;

/// <summary>
/// Creates an item under a parent, or at the workspace root.
/// </summary>
/// <remarks>
/// The server mints the identifier and chooses the sibling position. A client that could supply
/// either would be able to collide with an item it cannot see - which, in a system where "cannot
/// see" is the security boundary, is a way to learn that the invisible item exists.
/// </remarks>
public sealed class CreateItemHandler : ICommandHandler<CreateItem, Item>
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly ISchemaResolver _schemas;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="CreateItemHandler"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="schemas">Resolves the schema the new item's properties are checked against.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock, injected so timestamps are controllable in tests.</param>
    public CreateItemHandler(
        IItemTree tree,
        IPermissionResolver permissions,
        ISchemaResolver schemas,
        INixSessionContextAccessor session,
        TimeProvider clock)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(permissions);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(clock);

        _tree = tree;
        _permissions = permissions;
        _schemas = schemas;
        _session = session;
        _clock = clock;
    }

    /// <summary>Creates the item.</summary>
    /// <param name="command">
    /// The workspace to create it in; its kind; its display name; the parent, or
    /// <see langword="null"/> for a workspace root; and values to give it on creation, or
    /// <see langword="null"/> for none.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The created item, or why it could not be created.</returns>
    /// <remarks>
    /// <b>Properties are checked here for the same reasons a later write is checked.</b> Creating a
    /// card already in a column is one gesture rather than a create followed by an edit, and the
    /// value it carries has to face the same schema either way - otherwise the way to store a value
    /// the schema refuses would be to supply it a moment earlier.
    /// </remarks>
    public async ValueTask<Result<Item>> HandleAsync(CreateItem command, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);

        var workspaceId = command.WorkspaceId;
        var type = command.Type;
        var title = command.Title;
        var parentId = command.ParentId;
        var properties = command.Properties;

        if (string.IsNullOrWhiteSpace(type))
        {
            return Result.Failure<Item>(ItemErrors.NotFound("An item type is required."));
        }

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        if (!await _tree.WorkspaceExistsAsync(workspaceId, cancellationToken).ConfigureAwait(false)
            || !await _permissions.CanWriteWorkspaceAsync(workspaceId, cancellationToken).ConfigureAwait(false))
        {
            // Not-found rather than forbidden: a workspace the caller cannot see must not be
            // distinguishable from one that does not exist. A reader who may see the workspace but
            // not write to it gets the same answer here, which costs them a clearer message and
            // costs an attacker the ability to map the tenant by watching which refusal comes back.
            return Result.Failure<Item>(
                ItemErrors.WorkspaceNotFound($"No workspace {workspaceId} is visible."));
        }

        if (parentId is { } parent)
        {
            var existing = await _tree.FindAsync(parent, cancellationToken).ConfigureAwait(false);
            if (existing is null || existing.WorkspaceId != workspaceId)
            {
                return Result.Failure<Item>(
                    ItemErrors.ParentNotFound($"No parent {parent} is visible in this workspace."));
            }
        }

        // The title is written last so it wins. A caller that also passed `title` in the bag would
        // otherwise be able to make the stored title disagree with the one it named, and every
        // listing reads the promoted field.
        var bag = ItemProperties.WithTitle(properties?.ToJsonString(), title);

        // The schema the item is about to fall under, resolved from the parent because the item has
        // no row yet to resolve from - which is the question ResolveForChildrenAsync exists to
        // answer.
        var schema = await _schemas
            .ResolveForChildrenAsync(parentId, cancellationToken)
            .ConfigureAwait(false);

        // Supplied rather than complete: a required property is a statement about a finished item,
        // and enforcing it here would make an item impossible to create inside any container that
        // requires anything. Everything actually supplied faces its declaration exactly as a later
        // write would.
        var violations = PropertyValidator.ValidateSupplied(bag, schema);
        if (!violations.IsEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidProperties(violations));
        }

        var now = _clock.GetUtcNow();
        var item = new Item
        {
            Id = ItemId.Create(),
            TenantId = context.TenantId,
            WorkspaceId = workspaceId,
            Type = type,
            ParentId = parentId,
            Seq = await _tree
                .NextSiblingSequenceAsync(workspaceId, parentId, cancellationToken)
                .ConfigureAwait(false),
            Properties = bag,
            LifecycleState = ItemLifecycleState.Active,
            CreatedBy = context.PrincipalId,
            LastModifiedBy = context.PrincipalId,
            CreatedAt = now,
            LastModifiedAt = now,
        };

        await _tree.InsertAsync(item, cancellationToken).ConfigureAwait(false);
        return Result.Success(item);
    }
}

/// <summary>
/// Route handler for creating an item.
/// </summary>
/// <remarks>
/// Named apart from <see cref="CreateItem"/> itself: the command record already owns that
/// identifier in this namespace, and a route handler with the same name would be an ambiguous
/// simple name at the <c>MapPost</c> call site.
/// </remarks>
internal static class CreateItemEndpoint
{
    /// <summary>Handles a request to create an item.</summary>
    /// <param name="workspaceId">The workspace to create it in.</param>
    /// <param name="request">The requested type, title, parent, and properties.</param>
    /// <param name="httpContext">The current request.</param>
    /// <param name="dispatcher">Sends the command to its handler.</param>
    /// <returns>The created item, or a problem describing why it could not be created.</returns>
    internal static async Task<Results<Created<ItemResponse>, ProblemHttpResult>> Handle(
        Guid workspaceId,
        CreateItemRequest request,
        HttpContext httpContext,
        [FromServices] NixDispatcher dispatcher)
    {
        var result = await dispatcher
            .SendAsync<CreateItem, Item>(
                new CreateItem(
                    WorkspaceId.From(workspaceId),
                    request.Type,
                    request.Title,
                    request.ParentId is { } parent ? ItemId.From(parent) : null,
                    request.Properties),
                httpContext.RequestAborted)
            .ConfigureAwait(false);

        return result.Match<Results<Created<ItemResponse>, ProblemHttpResult>>(
            // A new item is a leaf by construction - nothing can have been parented to it between
            // the insert and this line - so this is provable rather than worth a query.
            item => TypedResults.Created($"/api/v1/items/{item.Id}", ItemMapping.ToResponse(item, false)),
            error => TypedResults.Problem(ItemEndpoints.Problem(httpContext, error)));
    }
}
