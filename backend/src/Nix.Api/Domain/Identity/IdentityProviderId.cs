using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Identity;

/// <summary>
/// Identifies a registered identity provider. A tenant may register more than one, and a token is
/// only accepted if its issuer and audience match a registration that is enabled.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct IdentityProviderId(Guid Value) : INixId<IdentityProviderId>
{
    /// <inheritdoc />
    public static IdentityProviderId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static IdentityProviderId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
