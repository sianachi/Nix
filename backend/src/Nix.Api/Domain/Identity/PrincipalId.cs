using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Identity;

/// <summary>
/// Identifies a principal: an identity provisioned from the customer's identity provider. Not an
/// item, and never addressable as one.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct PrincipalId(Guid Value) : INixId<PrincipalId>
{
    /// <inheritdoc />
    public static PrincipalId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static PrincipalId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
