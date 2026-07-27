using Nix.Application.Authorization;
using Nix.Application.Items;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Properties;

namespace Nix.Application.Properties;

/// <summary>Writes property values onto an item, checked against the schema in force.</summary>
/// <remarks>
/// <para>
/// <b>This is what a board drag and a calendar drag both come down to.</b> Moving a card between
/// columns sets its grouping property; dragging it to another day sets its date. Neither writes
/// anything view-local, which is what makes the change visible in every other view and to
/// everybody else - and is why view definitions carry no placement.
/// </para>
/// <para>
/// <b>A merge, not a replacement.</b> A caller sends the properties it is changing, and everything
/// else stays. Replacing the bag would make a board drag drop every property the board does not
/// display, which is most of them.
/// </para>
/// </remarks>
public sealed class SetItemProperties
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="SetItemProperties"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="schemas">Resolves the schema to check against.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public SetItemProperties(
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

    /// <summary>Writes the properties.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="changes">
    /// The properties to set, as a JSON object. A member set to null clears that property.
    /// </param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The updated item, or why it could not be written.</returns>
    public async ValueTask<Result<Item>> ExecuteAsync(
        ItemId itemId,
        string changes,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(changes);

        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<Item>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<Item>(
                ItemErrors.LifecycleConflict("A deleted item's properties cannot be changed."));
        }

        var merged = ItemProperties.Merge(item.Properties, changes);
        if (merged is null)
        {
            return Result.Failure<Item>(
                PropertyErrors.InvalidSchema("The properties must be a JSON object."));
        }

        // Resolved at the item, not at its parent: an item's own declaration is part of the schema
        // its own values are checked against.
        var schema = await _schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        var violations = PropertyValidator.Validate(merged, schema);
        if (!violations.IsEmpty)
        {
            return Result.Failure<Item>(PropertyErrors.InvalidProperties(violations));
        }

        await _tree
            .UpdatePropertiesAsync(itemId, merged, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        var written = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);

        return written is null
            ? Result.Failure<Item>(ItemErrors.NotFound($"Item {itemId} disappeared during the write."))
            : Result.Success(written);
    }
}
