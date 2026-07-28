using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Tenancy;

/// <summary>
/// Identifies a workspace: an organisational container inside one tenant, and the unit of item
/// containment, membership, quota, and retention configuration.
/// </summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct WorkspaceId(Guid Value) : INixId<WorkspaceId>
{
    /// <inheritdoc />
    public static WorkspaceId From(Guid value) => new(value);

    /// <summary>Mints a new, time-ordered identifier.</summary>
    /// <returns>A new identifier.</returns>
    public static WorkspaceId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
