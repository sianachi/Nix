using Nix.Domain.Items;
using Nix.Domain.Tenancy;
using Nix.Features.Locks;

namespace Nix.Tests.Features.Locks;

/// <summary>
/// The per-lock backoff and the derivation ceiling every password check goes through.
/// </summary>
public sealed class LockPasswordGuardTests
{
    private static readonly TenantId Tenant = TenantId.From(new Guid("7e7e7e7e-1111-4111-8111-7e7e7e7e7e01"));
    private static readonly ItemId Item = ItemId.From(new Guid("7e7e7e7e-1111-4111-8111-7e7e7e7e7e02"));
    private static readonly ItemId OtherItem = ItemId.From(new Guid("7e7e7e7e-1111-4111-8111-7e7e7e7e7e03"));

    /// <summary>One verifier for the whole class: deriving one costs hundreds of milliseconds.</summary>
    private static readonly string Verifier = LockPasswordHasher.Hash("right");

    private static CancellationToken Cancellation => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_free_wrong_answers_are_refused_as_wrong_and_the_next_starts_the_backoff()
    {
        var clock = new MovableClock();
        using var guard = new LockPasswordGuard(clock);

        for (var attempt = 0; attempt < LockPasswordGuard.FreeFailures; attempt++)
        {
            Assert.Equal(PasswordCheckOutcome.Wrong, (await CheckAsync(guard, "wrong")).Outcome);
        }

        // The sixth wrong answer is still checked and still wrong - and it starts a one-minute wait.
        Assert.Equal(PasswordCheckOutcome.Wrong, (await CheckAsync(guard, "wrong")).Outcome);

        var throttled = await CheckAsync(guard, "right");
        Assert.Equal(PasswordCheckOutcome.Throttled, throttled.Outcome);
        Assert.Equal(TimeSpan.FromMinutes(1), throttled.RetryAfter);
    }

    [Fact]
    public async Task The_wait_doubles_with_each_further_wrong_answer_and_the_right_one_clears_it()
    {
        var clock = new MovableClock();
        using var guard = new LockPasswordGuard(clock);
        for (var attempt = 0; attempt <= LockPasswordGuard.FreeFailures; attempt++)
        {
            await CheckAsync(guard, "wrong");
        }

        clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(PasswordCheckOutcome.Wrong, (await CheckAsync(guard, "wrong")).Outcome);
        Assert.Equal(TimeSpan.FromMinutes(2), (await CheckAsync(guard, "right")).RetryAfter);

        clock.Advance(TimeSpan.FromMinutes(2));
        Assert.Equal(PasswordCheckOutcome.Matched, (await CheckAsync(guard, "right")).Outcome);

        // Cleared: the next wrong answer is one of the free ones again.
        Assert.Equal(PasswordCheckOutcome.Wrong, (await CheckAsync(guard, "wrong")).Outcome);
        Assert.Equal(PasswordCheckOutcome.Matched, (await CheckAsync(guard, "right")).Outcome);
    }

    [Fact]
    public async Task One_lock_s_backoff_does_not_reach_another()
    {
        var clock = new MovableClock();
        using var guard = new LockPasswordGuard(clock);
        for (var attempt = 0; attempt <= LockPasswordGuard.FreeFailures; attempt++)
        {
            await CheckAsync(guard, "wrong");
        }

        var other = await guard.VerifyAsync(Tenant, OtherItem, "right", Verifier, Cancellation);

        Assert.Equal(PasswordCheckOutcome.Matched, other.Outcome);
    }

    [Fact]
    public async Task The_backoff_never_exceeds_its_ceiling()
    {
        var clock = new MovableClock();
        using var guard = new LockPasswordGuard(clock);
        for (var attempt = 0; attempt < 30; attempt++)
        {
            var check = await CheckAsync(guard, "wrong");
            if (check.Outcome == PasswordCheckOutcome.Throttled)
            {
                Assert.True(check.RetryAfter <= LockPasswordGuard.MaximumBackoff);
                clock.Advance(check.RetryAfter);
            }
        }
    }

    [Fact]
    public async Task Derivations_beyond_the_ceiling_wait_for_a_slot_rather_than_failing()
    {
        using var guard = new LockPasswordGuard(new MovableClock(), concurrentDerivations: 1);

        // Two derivations at once against a ceiling of one: the second waits for the first.
        var first = Task.Run(async () => await guard.HashAsync(new string('x', 256), Cancellation), Cancellation);
        var results = await Task.WhenAll(
            first,
            Task.Run(async () => await guard.HashAsync("second", Cancellation), Cancellation));

        // Both complete well inside the five-second wait: the ceiling queues rather than refuses
        // while slots come free. Busy is only for a slot that never does.
        Assert.All(results, Assert.NotNull);
    }

    private static ValueTask<PasswordCheck> CheckAsync(LockPasswordGuard guard, string password) =>
        guard.VerifyAsync(Tenant, Item, password, Verifier, Cancellation);

    private sealed class MovableClock : TimeProvider
    {
        private DateTimeOffset _now = new(2026, 9, 22, 12, 0, 0, TimeSpan.Zero);

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan by) => _now += by;
    }
}
