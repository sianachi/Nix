using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;
using Nix.Features.Notifications;
using Nix.Persistence;

namespace Nix.Tests.Features.Notifications;

public sealed class NotificationHandlersTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Marking_one_notification_read_lowers_the_unread_count_and_refuses_an_unknown_id()
    {
        var (session, store) = MakeSession();
        var created = await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.Reminder, "Title", "Body", null, null, "key-1", Cancellation);

        var markRead = new MarkNotificationReadHandler(store, session);
        var result = await markRead.HandleAsync(new(created.Id), Cancellation);
        Assert.True(result.IsSuccess);
        Assert.Equal(0, result.Value.Unread);

        var missing = await markRead.HandleAsync(new(Guid.NewGuid()), Cancellation);
        Assert.True(missing.IsFailure);
        Assert.Equal("notifications.not_found", missing.Error.Code);
    }

    [Fact]
    public async Task Marking_all_read_clears_every_unread_notification()
    {
        var (session, store) = MakeSession();
        await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.Reminder, "One", "Body", null, null, "key-1", Cancellation);
        await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.System, "Two", "Body", null, null, "key-2", Cancellation);

        var result = await new MarkAllNotificationsReadHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.True(result.IsSuccess);
        Assert.Equal(0, result.Value.Unread);

        var (unread, _) = await store.SummaryAsync(session.Current!.Value.TenantId, session.Current!.Value.PrincipalId, Cancellation);
        Assert.Equal(0, unread);
    }

    [Fact]
    public async Task Listing_pages_by_the_seq_cursor_newest_first()
    {
        var (session, store) = MakeSession();
        for (var index = 0; index < 3; index++)
        {
            await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.System, $"Title {index}", "Body", null, null, $"key-{index}", Cancellation);
        }

        var handler = new GetNotificationsHandler(store, session);
        var page = await handler.HandleAsync(new(null, false), Cancellation);
        Assert.Equal(3, page.Items.Count);
        Assert.Equal("Title 2", page.Items[0].Title);
        Assert.Equal("Title 0", page.Items[2].Title);
    }

    [Fact]
    public async Task Creating_twice_with_the_same_dedupe_key_is_idempotent()
    {
        var (session, store) = MakeSession();
        var first = await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.System, "First", "Body", null, null, "same-key", Cancellation);
        var second = await store.CreateAsync(session.Current!.Value.PrincipalId, NotificationKind.System, "Second", "Body", null, null, "same-key", Cancellation);
        Assert.Equal(first.Id, second.Id);
        Assert.Equal("First", second.Title);
    }

    private static (ScopedNixSessionContextAccessor Session, MemoryNotificationStore Store) MakeSession()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        return (session, new MemoryNotificationStore(session));
    }

    private sealed class MemoryNotificationStore(INixSessionContextAccessor session) : INotificationStore, INotificationWriter
    {
        private readonly List<Notification> _rows = [];
        private long _nextSeq = 1;

        public Task<NotificationPage> ListAsync(TenantId tenantId, PrincipalId principalId, long? afterSeq, bool unreadOnly, int limit, CancellationToken cancellationToken)
        {
            IEnumerable<Notification> query = _rows.Where(row => row.TenantId == tenantId && row.PrincipalId == principalId);
            if (unreadOnly)
            {
                query = query.Where(row => row.ReadAt is null);
            }

            if (afterSeq is { } cursor)
            {
                query = query.Where(row => row.Seq < cursor);
            }

            var items = query.OrderByDescending(row => row.Seq).Take(limit).ToList();
            var (unread, revision) = SummaryAsync(tenantId, principalId, cancellationToken).GetAwaiter().GetResult();
            return Task.FromResult(new NotificationPage(items, items.Count == limit ? items[^1].Seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : null, unread, revision));
        }

        public Task<(int Unread, long Revision)> SummaryAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken)
        {
            var own = _rows.Where(row => row.TenantId == tenantId && row.PrincipalId == principalId).ToList();
            var unread = own.Count(row => row.ReadAt is null);
            var latest = own.Count == 0 ? (DateTimeOffset?)null : own.Max(row => row.ReadAt is { } read && read > row.CreatedAt ? read : row.CreatedAt);
            return Task.FromResult((unread, latest?.ToUnixTimeMilliseconds() ?? 0));
        }

        public Task<bool> MarkReadAsync(TenantId tenantId, PrincipalId principalId, Guid notificationId, CancellationToken cancellationToken)
        {
            var index = _rows.FindIndex(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == notificationId);
            if (index < 0)
            {
                return Task.FromResult(false);
            }

            _rows[index] = _rows[index].ReadAt is null ? CloneWithRead(_rows[index]) : _rows[index];
            return Task.FromResult(true);
        }

        public Task MarkAllReadAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken)
        {
            for (var index = 0; index < _rows.Count; index++)
            {
                if (_rows[index].TenantId == tenantId && _rows[index].PrincipalId == principalId && _rows[index].ReadAt is null)
                {
                    _rows[index] = CloneWithRead(_rows[index]);
                }
            }

            return Task.CompletedTask;
        }

        public Task<Notification> CreateAsync(PrincipalId principal, NotificationKind kind, string title, string body, ItemId? itemId, WorkspaceId? workspaceId, string dedupeKey, CancellationToken cancellationToken)
        {
            var existing = _rows.FirstOrDefault(row => row.DedupeKey == dedupeKey);
            if (existing is not null)
            {
                return Task.FromResult(existing);
            }

            var created = new Notification
            {
                TenantId = session.Current!.Value.TenantId,
                Id = Guid.NewGuid(),
                PrincipalId = principal,
                Kind = kind,
                Title = title,
                Body = body,
                ItemId = itemId,
                WorkspaceId = workspaceId,
                CreatedAt = DateTimeOffset.UtcNow,
                Seq = _nextSeq++,
                DedupeKey = dedupeKey,
            };
            _rows.Add(created);
            return Task.FromResult(created);
        }

        private static Notification CloneWithRead(Notification row) => new()
        {
            TenantId = row.TenantId,
            Id = row.Id,
            PrincipalId = row.PrincipalId,
            Kind = row.Kind,
            Title = row.Title,
            Body = row.Body,
            ItemId = row.ItemId,
            WorkspaceId = row.WorkspaceId,
            CreatedAt = row.CreatedAt,
            Seq = row.Seq,
            ReadAt = DateTimeOffset.UtcNow,
            DedupeKey = row.DedupeKey,
        };
    }
}
