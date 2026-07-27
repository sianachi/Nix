using Nix.Application.Authorization;
using Nix.Application.Items;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Properties;

namespace Nix.Application.Properties;

/// <summary>Reads the property schema in force at an item.</summary>
/// <remarks>
/// What the interface needs before it can render a property panel, a list view's columns, or a
/// board's grouping choices: the merged result of every ancestor's declaration, which is not
/// something a client can compute because it cannot see the ancestors.
/// </remarks>
public sealed class GetEffectiveSchema
{
    private readonly IItemTree _tree;
    private readonly ISchemaResolver _schemas;
    private readonly IPermissionResolver _permissions;

    /// <summary>Initializes a new instance of the <see cref="GetEffectiveSchema"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="schemas">Resolves the ancestor chain.</param>
    /// <param name="permissions">Decides what the caller may read.</param>
    public GetEffectiveSchema(IItemTree tree, ISchemaResolver schemas, IPermissionResolver permissions)
    {
        ArgumentNullException.ThrowIfNull(tree);
        ArgumentNullException.ThrowIfNull(schemas);
        ArgumentNullException.ThrowIfNull(permissions);

        _tree = tree;
        _schemas = schemas;
        _permissions = permissions;
    }

    /// <summary>Reads the effective schema.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The schema, or why it could not be read.</returns>
    public async ValueTask<Result<EffectiveSchema>> ExecuteAsync(
        ItemId itemId,
        CancellationToken cancellationToken)
    {
        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanReadWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<EffectiveSchema>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        var effective = await _schemas.ResolveForItemAsync(itemId, cancellationToken).ConfigureAwait(false);

        // The item's own declaration is returned alongside the merged result, because an editor
        // needs to know which properties this container declares and which it merely inherits -
        // without that, saving the panel back would copy every inherited property onto the item
        // and quietly break the inheritance it was showing.
        var declared = PropertySchemaJson.Read(item.Schema);

        return Result.Success(new EffectiveSchema(effective, declared, item.Schema is not null));
    }
}

/// <summary>The schema at an item, and how much of it is the item's own.</summary>
/// <param name="Effective">Every ancestor's declaration merged, nearest winning.</param>
/// <param name="Declared">What this item declares itself.</param>
/// <param name="DeclaresSchema">Whether this item declares anything at all.</param>
public sealed record EffectiveSchema(
    PropertySchema Effective,
    PropertySchema Declared,
    bool DeclaresSchema);
