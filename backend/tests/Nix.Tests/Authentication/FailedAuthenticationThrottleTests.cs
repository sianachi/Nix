using System.Net;
using Nix.Authentication;

namespace Nix.Tests.Authentication;

/// <summary>
/// The failed-authentication window: enough invalid tokens from one address turn 401 into 429,
/// time passing turns it back, and the map that remembers all this never outgrows its bound.
/// </summary>
public sealed class FailedAuthenticationThrottleTests
{
    private static readonly DateTimeOffset Start = new(2026, 8, 9, 12, 0, 0, TimeSpan.Zero);
    private static readonly IPAddress Client = IPAddress.Parse("10.0.0.1");
    private static readonly IPAddress OtherClient = IPAddress.Parse("10.0.0.2");

    [Fact]
    public void Failures_below_the_limit_do_not_throttle()
    {
        var throttle = Throttle(new ManualClock(Start), limit: 3);

        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);

        Assert.False(throttle.IsThrottled(Client, out var retryAfter));
        Assert.Equal(TimeSpan.Zero, retryAfter);
    }

    [Fact]
    public void The_limiting_failure_throttles_and_says_how_long_the_refusal_lasts()
    {
        var clock = new ManualClock(Start);
        var throttle = Throttle(clock, limit: 3);

        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        clock.Advance(TimeSpan.FromMinutes(1));

        Assert.True(throttle.IsThrottled(Client, out var retryAfter));
        Assert.Equal(TimeSpan.FromMinutes(4), retryAfter);
    }

    [Fact]
    public void Only_the_failure_that_reaches_the_limit_reports_the_crossing()
    {
        var throttle = Throttle(new ManualClock(Start), limit: 3);

        Assert.False(throttle.RecordFailure(Client));
        Assert.False(throttle.RecordFailure(Client));
        Assert.True(throttle.RecordFailure(Client));
        Assert.False(throttle.RecordFailure(Client));
    }

    [Fact]
    public void The_window_expiring_lets_the_client_try_again()
    {
        var clock = new ManualClock(Start);
        var throttle = Throttle(clock, limit: 3);

        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        clock.Advance(TimeSpan.FromMinutes(5));

        Assert.False(throttle.IsThrottled(Client, out _));
    }

    [Fact]
    public void A_failure_after_the_window_expires_starts_a_fresh_count_rather_than_resuming_the_old_one()
    {
        var clock = new ManualClock(Start);
        var throttle = Throttle(clock, limit: 3);

        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        clock.Advance(TimeSpan.FromMinutes(6));
        throttle.RecordFailure(Client);

        Assert.False(throttle.IsThrottled(Client, out _));
    }

    [Fact]
    public void One_client_over_the_limit_does_not_throttle_another()
    {
        var throttle = Throttle(new ManualClock(Start), limit: 1);

        throttle.RecordFailure(Client);

        Assert.True(throttle.IsThrottled(Client, out _));
        Assert.False(throttle.IsThrottled(OtherClient, out _));
    }

    [Fact]
    public void A_scan_of_fresh_addresses_cannot_grow_the_map_past_its_bound()
    {
        // The bound is what makes this class safe to defend with: every window here is live, so a
        // sweep frees nothing, and without a real ceiling an attacker holding an IPv6 /64 could
        // trade addresses for this process's whole memory budget.
        var throttle = Throttle(new ManualClock(Start), limit: 3);

        for (var i = 0; i < FailedAuthenticationThrottle.SweepThreshold + 500; i++)
        {
            throttle.RecordFailure(new IPAddress(0x0A000000L + i));
        }

        Assert.Equal(FailedAuthenticationThrottle.SweepThreshold, throttle.TrackedClients);
    }

    [Fact]
    public void A_client_already_tracked_keeps_counting_after_the_map_reaches_its_bound()
    {
        // Failing open applies to new keys only: an address the throttle already knows must still
        // reach the limit, or filling the map would be a way to switch the defence off.
        var throttle = Throttle(new ManualClock(Start), limit: 3);
        throttle.RecordFailure(Client);

        for (var i = 0; i < FailedAuthenticationThrottle.SweepThreshold + 500; i++)
        {
            throttle.RecordFailure(new IPAddress(0x0A000000L + i));
        }

        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);

        Assert.True(throttle.IsThrottled(Client, out _));
    }

    [Fact]
    public void The_bound_lifts_once_the_window_the_map_filled_in_has_turned_over()
    {
        var clock = new ManualClock(Start);
        var throttle = Throttle(clock, limit: 3);
        for (var i = 0; i < FailedAuthenticationThrottle.SweepThreshold + 500; i++)
        {
            throttle.RecordFailure(new IPAddress(0x0A000000L + i));
        }

        clock.Advance(TimeSpan.FromMinutes(6));
        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);
        throttle.RecordFailure(Client);

        Assert.True(throttle.IsThrottled(Client, out _));
    }

    private static FailedAuthenticationThrottle Throttle(TimeProvider clock, int limit) =>
        new(clock, limit, TimeSpan.FromMinutes(5));

    /// <summary>A clock a test can move, so window expiry is asserted rather than awaited.</summary>
    private sealed class ManualClock(DateTimeOffset start) : TimeProvider
    {
        private DateTimeOffset _now = start;

        public void Advance(TimeSpan by) => _now += by;

        public override DateTimeOffset GetUtcNow() => _now;
    }
}
