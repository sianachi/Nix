using Nix.Abstractions;
using Nix.Domain.Identity;
using Nix.Domain.Notifications;
using Nix.Domain.Tenancy;
using Nix.Features.Notifications;
using Nix.Persistence;

namespace Nix.Tests.Features.Notifications;

public sealed class PreferencesTests
{
    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public void Known_zones_valid_times_and_a_bounded_mute_list_are_accepted()
    {
        Assert.True(PreferencesValidation.IsValid(new PreferencesInput("Europe/London", "22:00", "07:00", "09:00", true, true, [])));
        Assert.True(PreferencesValidation.IsValid(PreferencesValidation.Default));
        Assert.True(PreferencesValidation.IsValid(new PreferencesInput("Etc/UTC", null, null, "09:00", true, true, [.. Enumerable.Range(0, 200).Select(_ => Guid.NewGuid())])));
    }

    [Fact]
    public void An_unknown_zone_a_bad_time_shape_and_an_over_long_mute_list_are_refused()
    {
        Assert.False(PreferencesValidation.IsValid(null));
        Assert.False(PreferencesValidation.IsValid(new PreferencesInput("Not/AZone", null, null, "09:00", true, true, [])));
        Assert.False(PreferencesValidation.IsValid(new PreferencesInput("Etc/UTC", null, null, "9am", true, true, [])));
        Assert.False(PreferencesValidation.IsValid(new PreferencesInput("Etc/UTC", "25:00", null, "09:00", true, true, [])));
        Assert.False(PreferencesValidation.IsValid(new PreferencesInput("Etc/UTC", null, null, "09:00", true, true, [.. Enumerable.Range(0, 201).Select(_ => Guid.NewGuid())])));
    }

    [Fact]
    public async Task A_stale_save_does_not_overwrite_another_devices_edit()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var store = new MemoryStore();
        var handler = new SavePreferencesHandler(store, session);
        var input = new PreferencesInput("Europe/London", null, null, "09:00", true, true, []);
        var first = await handler.HandleAsync(new(0, input), Cancellation);
        var second = await handler.HandleAsync(new(0, input with { DueReminders = false }), Cancellation);
        Assert.True(first.IsSuccess);
        Assert.Equal(1, first.Value.Revision);
        Assert.True(second.IsFailure);
        Assert.Equal("notifications.preferences_conflict", second.Error.Code);

        var read = await new GetPreferencesHandler(store, session).HandleAsync(new(), Cancellation);
        Assert.True(read.DueReminders);
    }

    [Fact]
    public async Task Reading_before_any_save_returns_the_default_document_at_revision_zero()
    {
        var session = new ScopedNixSessionContextAccessor();
        session.Set(new NixSessionContext(TenantId.Create(), null, PrincipalId.Create()));
        var read = await new GetPreferencesHandler(new MemoryStore(), session).HandleAsync(new(), Cancellation);
        Assert.Equal(0, read.Revision);
        Assert.Equal(PreferencesValidation.Default.TimeZone, read.TimeZone);
    }

    private sealed class MemoryStore : IPrincipalPreferencesStore
    {
        private PrincipalPreferences? _saved;

        public ValueTask<PrincipalPreferences?> FindAsync(TenantId tenantId, PrincipalId principalId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_saved is { } row && row.TenantId == tenantId && row.PrincipalId == principalId ? row : null);

        public Task<bool> SaveAsync(PrincipalPreferences preferences, long expectedRevision, CancellationToken cancellationToken)
        {
            if ((_saved?.Revision ?? 0) != expectedRevision)
            {
                return Task.FromResult(false);
            }

            _saved = preferences;
            return Task.FromResult(true);
        }
    }
}
