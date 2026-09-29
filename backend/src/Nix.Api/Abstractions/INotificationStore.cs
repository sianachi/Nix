using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>One slice of a principal's inbox, and the count still unread.</summary>
/// <param name="Items">The notifications in this slice, newest first.</param>
/// <param name="NextCursor">The cursor for the following slice, or <see langword="null"/> on the last one.</param>
/// <param name="Unread">How many of this principal's notifications are unread, regardless of slice.</param>
/// <param name="Revision">
/// The latest of every notification's created-at or read-at instant for this principal, as epoch
/// milliseconds. Callers of <c>watch</c> pass back the highest revision they have already seen.
/// </param>
public sealed record NotificationPage(IReadOnlyList<Notification> Items, string? NextCursor, int Unread, long Revision);

/// <summary>Reads and updates only the session owner's inbox.</summary>
public interface INotificationStore
{
    /// <summary>Reads a page of the caller's notifications, newest first.</summary>
    public Task<NotificationPage> ListAsync(TenantId tenantId, PrincipalId principalId, long? afterSeq, bool unreadOnly, int limit, CancellationToken cancellationToken);

    /// <summary>Reads only the revision and unread count, without paging the rows.</summary>
    public Task<(int Unread, long Revision)> SummaryAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);

    /// <summary>Marks one notification read. Returns <see langword="false"/> when it does not belong to this owner.</summary>
    public Task<bool> MarkReadAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken);

    /// <summary>Marks every unread notification of this owner read.</summary>
    public Task MarkAllReadAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken);
}

/// <summary>
/// Creates notifications on a recipient's behalf. Used by later lanes' background sources
/// (reminders, automations, calendar sync); the caller's session must already be scoped to the
/// recipient principal, the same way <c>AbandonedObjectReaper</c> scopes a session per row.
/// </summary>
public interface INotificationWriter
{
    /// <summary>
    /// Creates a notification, or returns the one that already exists for the same
    /// <paramref name="dedupeKey"/> within the tenant.
    /// </summary>
    public Task<Notification> CreateAsync(
        PrincipalId principal,
        NotificationKind kind,
        string title,
        string body,
        ItemId? itemId,
        WorkspaceId? workspaceId,
        string dedupeKey,
        CancellationToken cancellationToken);
}
