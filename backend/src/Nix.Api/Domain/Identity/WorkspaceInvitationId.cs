using System.Globalization;
using Nix.Domain.Primitives;

namespace Nix.Domain.Identity;

/// <summary>Identifies one durable workspace invitation history row.</summary>
/// <param name="Value">The underlying identifier.</param>
public readonly record struct WorkspaceInvitationId(Guid Value) : INixId<WorkspaceInvitationId>
{
    /// <inheritdoc />
    public static WorkspaceInvitationId From(Guid value) => new(value);

    /// <summary>Mints a new time-ordered identifier.</summary>
    public static WorkspaceInvitationId Create() => new(Guid.CreateVersion7());

    /// <inheritdoc />
    public override string ToString() => Value.ToString("D", CultureInfo.InvariantCulture);
}
