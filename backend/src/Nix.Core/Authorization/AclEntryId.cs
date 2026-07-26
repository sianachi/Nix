using System.Globalization;
using Nix.Core.Primitives;

namespace Nix.Core.Authorization;

/// <summary>
/// Identifies an access control entry: one grant or denial, attached to one item, for one subject.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct AclEntryId(Guid Value) : INixId<AclEntryId>
{
    /// <inheritdoc />
    public static AclEntryId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static AclEntryId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
