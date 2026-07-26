using System.Globalization;
using Nix.Core.Primitives;

namespace Nix.Core.Tenancy;

/// <summary>
/// Identifies a tenant: one customer organisation, and the isolation boundary every row is
/// filtered by.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct TenantId(Guid Value) : INixId<TenantId>
{
    /// <inheritdoc />
    public static TenantId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static TenantId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
