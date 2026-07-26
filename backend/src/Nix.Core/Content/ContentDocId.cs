using System.Globalization;
using Nix.Core.Primitives;

namespace Nix.Core.Content;

/// <summary>
/// Identifies a content document: the body of a native item.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct ContentDocId(Guid Value) : INixId<ContentDocId>
{
    /// <inheritdoc />
    public static ContentDocId From(Guid value) => new(value);

    /// <inheritdoc />
    public static ContentDocId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
