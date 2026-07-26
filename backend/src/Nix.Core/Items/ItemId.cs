using System.Globalization;
using Nix.Core.Primitives;

namespace Nix.Core.Items;

/// <summary>
/// Identifies an item: the universal object. A note, task, folder, board, or file, with one parent
/// and exactly one workspace.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct ItemId(Guid Value) : INixId<ItemId>
{
    /// <inheritdoc />
    public static ItemId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static ItemId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
