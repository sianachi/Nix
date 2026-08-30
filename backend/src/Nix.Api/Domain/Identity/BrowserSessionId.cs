using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Identity;

/// <summary>Identifies one revocable browser session owned by Core.</summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct BrowserSessionId(Guid Value) : INixId<BrowserSessionId>
{
    /// <inheritdoc />
    public static BrowserSessionId From(Guid value) => new(value);

    /// <summary>Mints a new time-ordered identifier.</summary>
    public static BrowserSessionId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
