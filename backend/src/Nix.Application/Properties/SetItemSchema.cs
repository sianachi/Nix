using Nix.Application.Authorization;
using Nix.Application.Items;
using Nix.Application.Persistence;
using Nix.Core.Items;
using Nix.Core.Primitives;
using Nix.Core.Properties;

namespace Nix.Application.Properties;

/// <summary>Replaces the property schema a container declares for its subtree.</summary>
/// <remarks>
/// <para>
/// <b>The schema is refused here rather than repaired.</b> The reader that loads a stored schema is
/// total - it drops what it cannot interpret so that a bad schema never makes the items beneath it
/// unreadable - and this is the counterpart: the one place a person finds out their schema was
/// wrong, while they are looking at it, instead of discovering later that half of it silently did
/// nothing.
/// </para>
/// <para>
/// Editing a schema never touches the values beneath it. A property removed from a schema stops
/// being validated and stops being shown; its values stay where they are and come back if the
/// schema does. See ADR-0007 §4 for why the alternative - invalidating stored data because
/// somebody edited a definition - is the worse failure.
/// </para>
/// </remarks>
public sealed class SetItemSchema
{
    private readonly IItemTree _tree;
    private readonly IPermissionResolver _permissions;
    private readonly INixSessionContextAccessor _session;
    private readonly TimeProvider _clock;

    /// <summary>Initializes a new instance of the <see cref="SetItemSchema"/> class.</summary>
    /// <param name="tree">Item storage.</param>
    /// <param name="permissions">Decides what the caller may change.</param>
    /// <param name="session">The tenant and principal this request runs as.</param>
    /// <param name="clock">The clock.</param>
    public SetItemSchema(
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

    /// <summary>Sets the schema.</summary>
    /// <param name="itemId">The container.</param>
    /// <param name="schema">The schema to declare, or <see langword="null"/> to declare none.</param>
    /// <param name="cancellationToken">Cancels the work.</param>
    /// <returns>The stored schema, or why it could not be stored.</returns>
    public async ValueTask<Result<PropertySchema>> ExecuteAsync(
        ItemId itemId,
        PropertySchema? schema,
        CancellationToken cancellationToken)
    {
        var context = _session.Current
            ?? throw new InvalidOperationException("No session context; the pipeline must establish one.");

        var item = await _tree.FindAsync(itemId, cancellationToken).ConfigureAwait(false);
        if (item is null
            || !await _permissions.CanWriteWorkspaceAsync(item.WorkspaceId, cancellationToken).ConfigureAwait(false))
        {
            return Result.Failure<PropertySchema>(ItemErrors.NotFound($"No item {itemId} is visible."));
        }

        if (item.LifecycleState != ItemLifecycleState.Active)
        {
            return Result.Failure<PropertySchema>(
                ItemErrors.LifecycleConflict("A deleted item's schema cannot be changed."));
        }

        if (schema is null || schema.IsEmpty)
        {
            await _tree
                .UpdateSchemaAsync(itemId, null, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
                .ConfigureAwait(false);

            return Result.Success(PropertySchema.Empty);
        }

        if (Refuse(schema) is { } refusal)
        {
            return Result.Failure<PropertySchema>(refusal);
        }

        var json = PropertySchemaJson.Write(schema);
        if (System.Text.Encoding.UTF8.GetByteCount(json) > PropertyValidator.MaximumBytes)
        {
            // Checked here as well as by the column's constraint, so an oversized schema is a
            // problem document naming the limit rather than a constraint violation surfacing as
            // a 500.
            return Result.Failure<PropertySchema>(
                PropertyErrors.InvalidSchema(
                    $"A schema may be at most {PropertyValidator.MaximumBytes} bytes."));
        }

        await _tree
            .UpdateSchemaAsync(itemId, json, context.PrincipalId, _clock.GetUtcNow(), cancellationToken)
            .ConfigureAwait(false);

        return Result.Success(schema);
    }

    /// <summary>
    /// Every reason a schema is not storable, or null when it is fine.
    /// </summary>
    /// <remarks>
    /// These are the rules the reader cannot enforce, because the reader has to stay total. A
    /// select with no options is the one worth naming: it parses perfectly and then rejects every
    /// value anybody could give it, which looks like a bug in the validator rather than an
    /// unfinished schema.
    /// </remarks>
    private static NixError? Refuse(PropertySchema schema)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);

        foreach (var property in schema.Properties)
        {
            if (property.Key.Length == 0)
            {
                return PropertyErrors.InvalidSchema("Every property needs a key.");
            }

            if (!keys.Add(property.Key))
            {
                return PropertyErrors.InvalidSchema(
                    $"'{property.Key}' is declared more than once; a property cannot mean two things.");
            }

            if (string.Equals(property.Key, ItemProperties.TitleKey, StringComparison.Ordinal))
            {
                // The title is promoted to a first-class field by the API and written by the
                // rename path. A schema redeclaring it would give one value two owners with
                // different rules.
                return PropertyErrors.InvalidSchema(
                    "'title' is managed by the item itself and cannot be redeclared.");
            }

            if (property.Type.HasOptions() && property.Options.IsEmpty)
            {
                return PropertyErrors.InvalidSchema(
                    $"'{property.Label}' is a select and needs at least one option.");
            }

            if (!property.Type.HasOptions() && !property.Options.IsEmpty)
            {
                return PropertyErrors.InvalidSchema(
                    $"'{property.Label}' is not a select, so it cannot carry options.");
            }
        }

        return null;
    }
}
