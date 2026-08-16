using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Identity;

/// <summary>
/// Identifies a personal access token: a credential a principal issued for a non-browser client.
/// Names the row, never the secret - the secret is shown once at creation and only its hash is
/// kept.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct PersonalAccessTokenId(Guid Value) : INixId<PersonalAccessTokenId>
{
    /// <inheritdoc />
    public static PersonalAccessTokenId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static PersonalAccessTokenId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
