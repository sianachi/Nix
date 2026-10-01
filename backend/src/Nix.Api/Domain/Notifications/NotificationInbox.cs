using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Notifications;

/// <summary>
/// A principal's inbox revision: a counter bumped in the same transaction as every change to their
/// notifications (a new one, one read, all read).
/// </summary>
/// <remarks>
/// The watch long-poll compares this with the revision a client last saw. It is a counter rather
/// than a timestamp because the row lock serialises bumps in commit order: a notification stamped
/// before a concurrent mark-read but committed after it still moves the revision forward, which a
/// max(created_at, read_at) watermark cannot guarantee.
/// </remarks>
public sealed class NotificationInbox
{
    /// <summary>Gets the tenant whose principal owns this inbox.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the owner.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>Gets the number of changes applied to this inbox.</summary>
    public required long Revision { get; init; }
}
