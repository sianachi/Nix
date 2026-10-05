using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;
using Nix.Features.Notifications;
using Nix.Persistence;

namespace Nix.Tests.Features.Notifications;

public sealed class PushSubscriptionHandlersTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    // A 65-byte key is an uncompressed P-256 point, so it starts with 0x04; other lengths are zeros.
    private static string Base64Url(int byteCount)
    {
        var bytes = new byte[byteCount];
        if (byteCount == 65)
        {
            bytes[0] = 0x04;
        }

        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    [Fact]
    public async Task A_disallowed_endpoint_is_refused_before_it_is_stored()
    {
        var (session, store) = MakeSession();
        var handler = new AddPushSubscriptionHandler(store, session);
        var result = await handler.HandleAsync(new("https://attacker.example.com/collect", Base64Url(65), Base64Url(16), "agent"), Cancellation);
        Assert.True(result.IsFailure);
        Assert.Equal("notifications.invalid_subscription", result.Error.Code);
        Assert.Empty(await store.ListAsync(session.Current!.Value.TenantId, session.Current!.Value.PrincipalId, Cancellation));
    }

    [Fact]
    public async Task An_eleventh_device_is_refused_but_re_registering_an_existing_one_is_not()
    {
        var (session, store) = MakeSession();
        var handler = new AddPushSubscriptionHandler(store, session);
        for (var index = 0; index < 10; index++)
        {
            var added = await handler.HandleAsync(new($"https://fcm.googleapis.com/fcm/send/{index}", Base64Url(65), Base64Url(16), "agent"), Cancellation);
            Assert.True(added.IsSuccess);
        }

        var eleventh = await handler.HandleAsync(new("https://fcm.googleapis.com/fcm/send/10", Base64Url(65), Base64Url(16), "agent"), Cancellation);
        Assert.True(eleventh.IsFailure);
        Assert.Equal("notifications.too_many_subscriptions", eleventh.Error.Code);

        var reRegistered = await handler.HandleAsync(new("https://fcm.googleapis.com/fcm/send/0", Base64Url(65), Base64Url(16), "agent"), Cancellation);
        Assert.True(reRegistered.IsSuccess);
    }

    [Fact]
    public async Task Removing_a_device_removes_only_the_matching_endpoint()
    {
        var (session, store) = MakeSession();
        var add = new AddPushSubscriptionHandler(store, session);
        await add.HandleAsync(new("https://fcm.googleapis.com/fcm/send/a", Base64Url(65), Base64Url(16), "agent"), Cancellation);
        await add.HandleAsync(new("https://fcm.googleapis.com/fcm/send/b", Base64Url(65), Base64Url(16), "agent"), Cancellation);

        var remove = new RemovePushSubscriptionHandler(store, session);
        var removed = await remove.HandleAsync(new("https://fcm.googleapis.com/fcm/send/a"), Cancellation);
        Assert.True(removed.IsSuccess);
        Assert.True(removed.Value);

        var remaining = await store.ListAsync(session.Current!.Value.TenantId, session.Current!.Value.PrincipalId, Cancellation);
        Assert.Single(remaining);
        Assert.Equal("https://fcm.googleapis.com/fcm/send/b", remaining[0].Endpoint);

        var again = await remove.HandleAsync(new("https://fcm.googleapis.com/fcm/send/a"), Cancellation);
        Assert.True(again.IsSuccess);
        Assert.False(again.Value);
    }

    private static (ScopedNixSessionContextAccessor Session, MemoryPushSubscriptionStore Store) MakeSession()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        return (session, new MemoryPushSubscriptionStore());
    }

    private sealed class MemoryPushSubscriptionStore : IPushSubscriptionStore
    {
        private readonly List<PushSubscription> _rows = [];

        public Task<IReadOnlyList<PushSubscription>> ListAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<PushSubscription>>(_rows.Where(row => row.TenantId == tenantId && row.PrincipalId == principalId).ToList());

        public Task LockAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<PushSubscription> SaveAsync(PushSubscription subscription, CancellationToken cancellationToken)
        {
            var index = _rows.FindIndex(row => row.TenantId == subscription.TenantId && row.PrincipalId == subscription.PrincipalId && row.Endpoint == subscription.Endpoint);
            if (index >= 0)
            {
                _rows[index] = subscription;
            }
            else
            {
                _rows.Add(subscription);
            }

            return Task.FromResult(subscription);
        }

        public Task<bool> RemoveAsync(TenantId tenantId, PrincipalId principalId, string endpoint, CancellationToken cancellationToken)
        {
            var removed = _rows.RemoveAll(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Endpoint == endpoint);
            return Task.FromResult(removed == 1);
        }

        public Task<bool> RemoveByIdAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken)
        {
            var removed = _rows.RemoveAll(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id);
            return Task.FromResult(removed == 1);
        }

        public Task RecordDeliveredAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken)
        {
            var index = _rows.FindIndex(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id);
            if (index >= 0)
            {
                var row = _rows[index];
                _rows[index] = new PushSubscription
                {
                    TenantId = row.TenantId,
                    Id = row.Id,
                    PrincipalId = row.PrincipalId,
                    Endpoint = row.Endpoint,
                    P256dh = row.P256dh,
                    Auth = row.Auth,
                    UserAgent = row.UserAgent,
                    CreatedAt = row.CreatedAt,
                    LastSuccessAt = DateTimeOffset.UtcNow,
                    Failures = 0,
                };
            }
            return Task.CompletedTask;
        }

        public Task RecordFailedAsync(TenantId tenantId, PrincipalId principalId, Guid id, CancellationToken cancellationToken)
        {
            var index = _rows.FindIndex(row => row.TenantId == tenantId && row.PrincipalId == principalId && row.Id == id);
            if (index >= 0)
            {
                var row = _rows[index];
                var failures = row.Failures + 1;
                if (failures >= 5)
                {
                    _rows.RemoveAt(index);
                }
                else
                {
                    _rows[index] = new PushSubscription
                    {
                        TenantId = row.TenantId,
                        Id = row.Id,
                        PrincipalId = row.PrincipalId,
                        Endpoint = row.Endpoint,
                        P256dh = row.P256dh,
                        Auth = row.Auth,
                        UserAgent = row.UserAgent,
                        CreatedAt = row.CreatedAt,
                        LastSuccessAt = row.LastSuccessAt,
                        Failures = failures,
                    };
                }
            }
            return Task.CompletedTask;
        }
    }
}
