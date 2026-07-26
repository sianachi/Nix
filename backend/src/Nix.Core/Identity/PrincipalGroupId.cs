using System.Globalization;
using Nix.Core.Primitives;

namespace Nix.Core.Identity;

/// <summary>
/// Identifies a group of principals. Groups are provisioning input - membership arrives from the
/// identity provider - and are subjects of access control entries alongside principals.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct PrincipalGroupId(Guid Value) : INixId<PrincipalGroupId>
{
    /// <inheritdoc />
    public static PrincipalGroupId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static PrincipalGroupId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
