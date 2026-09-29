using Microsoft.EntityFrameworkCore;
using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;

namespace Nix.Persistence.Notifications;

/// <summary>
/// Reads and updates a principal's own inbox, and creates notifications on a recipient's behalf.
/// </summary>
/// <remarks>
/// <see cref="INotificationWriter.CreateAsync"/> takes its tenant from the current session, the
/// same as <see cref="PrincipalPreferencesStore"/> and every other principal-scoped store; the
/// caller supplies which principal the notification is for, and row-level security's <c>WITH
/// CHECK</c> refuses the insert if that principal does not match the session that opened it -
/// fail-closed, the same guarantee <c>Rls_refuses_a_forged_owner_on_insert</c> proves for
/// pet_preferences.
/// </remarks>
public sealed class NotificationStore(NixDbContext db, INixSessionContextAccessor session) : INotificationStore, INotificationWriter
{
    /// <inheritdoc />
    public async Task<NotificationPage> ListAsync(TenantId tenantId, PrincipalId principalId, long? afterSeq, bool unreadOnly, int limit, CancellationToken cancellationToken)
    {
        var query = db.Set<Notification>().AsNoTracking()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId);
        if (unreadOnly)
        {
            query = query.Where(row => row.ReadAt == null);
        }

        if (afterSeq is { } cursor)
        {
            query = query.Where(row => row.Seq < cursor);
        }

        var items = await query.OrderByDescending(row => row.Seq).Take(limit).ToListAsync(cancellationToken).ConfigureAwait(false);
        var (unread, revision) = await SummaryAsync(tenantId, principalId, cancellationToken).ConfigureAwait(false);
        var nextCursor = items.Count == limit ? items[^1].Seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
        return new NotificationPage(items, nextCursor, unread, revision);
    }

    /// <inheritdoc />
    public async Task<(int Unread, long Revision)> SummaryAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken)
    {
        var own = db.Set<Notification>().AsNoTracking().Where(row => row.TenantId == tenantId && row.PrincipalId == principalId);
        var unread = await own.CountAsync(row => row.ReadAt == null, cancellationToken).ConfigureAwait(false);

        // The watch revision is the latest instant anything about this inbox changed: a new
        // notification's created_at, or an existing one's read_at. Whichever moved most recently.
        var latestCreated = await own.Select(row => (DateTimeOffset?)row.CreatedAt).MaxAsync(cancellationToken).ConfigureAwait(false);
        var latestRead = await own.Select(row => row.ReadAt).MaxAsync(cancellationToken).ConfigureAwait(false);
        var latest = latestCreated is { } created && (latestRead is null || created > latestRead) ? created
            : latestRead ?? latestCreated;
        return (unread, latest?.ToUnixTimeMilliseconds() ?? 0);
    }

    /// <inheritdoc />
    public async Task<bool> MarkReadAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken) =>
        await db.Set<Notification>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId && row.ReadAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.ReadAt, DateTimeOffset.UtcNow), cancellationToken)
            .ConfigureAwait(false) == 1
        || await db.Set<Notification>().AsNoTracking()
            .AnyAsync(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId, cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task MarkAllReadAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
        await db.Set<Notification>()
            .Where(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.ReadAt == null)
            .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.ReadAt, DateTimeOffset.UtcNow), cancellationToken)
            .ConfigureAwait(false);

    /// <inheritdoc />
    public async Task<Notification> CreateAsync(
        PrincipalId principal,
        NotificationKind kind,
        string title,
        string body,
        ItemId? itemId,
        WorkspaceId? workspaceId,
        string dedupeKey,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(dedupeKey);
        var context = session.Current ?? throw new InvalidOperationException("A session is required.");
        var id = Guid.CreateVersion7();
        var createdAt = DateTimeOffset.UtcNow;
        var kindText = NotificationKindStorage.ToText(kind);
        Guid? itemIdValue = itemId.HasValue ? itemId.Value.Value : null;
        Guid? workspaceIdValue = workspaceId.HasValue ? workspaceId.Value.Value : null;

        // ON CONFLICT DO NOTHING makes this idempotent per (tenant, dedupe key): a redelivered
        // trigger or a retried worker call lands on the row that already exists instead of a
        // second one. The insert is always attempted at the caller-chosen principal; a session
        // scoped to a different principal is refused by row-level security before the select below.
        await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO notification (tenant_id, id, principal_id, kind, title, body, item_id, workspace_id, created_at, dedupe_key)
            VALUES ({context.TenantId.Value}, {id}, {principal.Value}, {kindText}, {title}, {body},
                {itemIdValue}, {workspaceIdValue},
                {createdAt}, {dedupeKey})
            ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
            """, cancellationToken).ConfigureAwait(false);

        return await db.Set<Notification>().AsNoTracking()
            .SingleAsync(row => row.TenantId == context.TenantId && row.DedupeKey == dedupeKey, cancellationToken)
            .ConfigureAwait(false);
    }
}
