using System.Collections.Concurrent;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Features.Locks;

/// <summary>
/// Every check of a lock password goes through here: a per-lock backoff after repeated wrong
/// answers, and a ceiling on how many key derivations run at once.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why per lock as well as per address.</b> The route's rate limit bounds what one address may
/// ask for, but a workspace member guessing a colleague's four-character password can spread their
/// guesses across addresses. Counting failures against the lock itself bounds the guesses whoever
/// makes them: after <see cref="FreeFailures"/> wrong answers each further one doubles the wait,
/// up to <see cref="MaximumBackoff"/>, and a right answer clears the count.
/// </para>
/// <para>
/// <b>Why in memory.</b> A refused request rolls its transaction back, so a failure count written
/// to the database would be undone by the very refusal it records. The cost is that each API
/// instance counts on its own and a restart forgets - a guesser gains a factor of the replica
/// count, which the backoff's doubling absorbs within a few steps.
/// </para>
/// <para>
/// <b>Why a derivation ceiling.</b> A derivation costs a few hundred milliseconds of a core, inside
/// a request that already holds a pooled database connection. Unbounded, a burst of attempts is a
/// way to starve both. A request that cannot get a slot within <see cref="SlotWait"/> is refused
/// as busy rather than queued behind everybody else's.
/// </para>
/// </remarks>
public sealed class LockPasswordGuard : IDisposable
{
    /// <summary>Wrong answers allowed before the backoff starts.</summary>
    public const int FreeFailures = 5;

    /// <summary>The longest a lock refuses attempts after repeated wrong answers.</summary>
    public static readonly TimeSpan MaximumBackoff = TimeSpan.FromHours(1);

    /// <summary>How long a request waits for a derivation slot before it is refused as busy.</summary>
    public static readonly TimeSpan SlotWait = TimeSpan.FromSeconds(5);

    /// <summary>How many failure records are kept before stale ones are swept.</summary>
    private const int SweepThreshold = 10_000;

    private readonly TimeProvider _clock;
    private readonly SemaphoreSlim _slots;
    private readonly ConcurrentDictionary<(TenantId Tenant, ItemId Item), Failures> _failures = new();

    /// <summary>Initializes a new instance of the <see cref="LockPasswordGuard"/> class.</summary>
    /// <param name="clock">Judges the backoff.</param>
    public LockPasswordGuard(TimeProvider clock)
        : this(clock, Math.Max(1, Environment.ProcessorCount / 2))
    {
    }

    /// <summary>Initializes a new instance of the <see cref="LockPasswordGuard"/> class.</summary>
    /// <param name="clock">Judges the backoff.</param>
    /// <param name="concurrentDerivations">How many derivations may run at once.</param>
    public LockPasswordGuard(TimeProvider clock, int concurrentDerivations)
    {
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentOutOfRangeException.ThrowIfLessThan(concurrentDerivations, 1);

        _clock = clock;
        _slots = new SemaphoreSlim(concurrentDerivations, concurrentDerivations);
    }

    /// <summary>Checks a password against a lock's verifier.</summary>
    /// <param name="tenantId">The lock's tenant.</param>
    /// <param name="itemId">The locked item.</param>
    /// <param name="password">The presented password.</param>
    /// <param name="verifier">The stored verifier.</param>
    /// <param name="cancellationToken">Cancels the wait for a slot.</param>
    /// <returns>Whether it matched, or why it was not checked.</returns>
    public async ValueTask<PasswordCheck> VerifyAsync(
        TenantId tenantId,
        ItemId itemId,
        string password,
        string verifier,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(password);
        ArgumentNullException.ThrowIfNull(verifier);

        var key = (tenantId, itemId);
        var now = _clock.GetUtcNow();
        if (_failures.TryGetValue(key, out var recorded) && recorded.RetryAt > now)
        {
            return PasswordCheck.Throttled(recorded.RetryAt - now);
        }

        if (!await _slots.WaitAsync(SlotWait, cancellationToken).ConfigureAwait(false))
        {
            return PasswordCheck.Busy;
        }

        bool matched;
        try
        {
            matched = LockPasswordHasher.Verify(password, verifier);
        }
        finally
        {
            _slots.Release();
        }

        if (matched)
        {
            _failures.TryRemove(key, out _);
            return PasswordCheck.Matched;
        }

        RecordFailure(key, now);
        return PasswordCheck.Wrong;
    }

    /// <summary>Derives a verifier for a new password, within the derivation ceiling.</summary>
    /// <param name="password">The new password.</param>
    /// <param name="cancellationToken">Cancels the wait for a slot.</param>
    /// <returns>The verifier, or <see langword="null"/> when no slot came free in time.</returns>
    public async ValueTask<string?> HashAsync(string password, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(password);

        if (!await _slots.WaitAsync(SlotWait, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        try
        {
            return LockPasswordHasher.Hash(password);
        }
        finally
        {
            _slots.Release();
        }
    }

    /// <inheritdoc />
    public void Dispose() => _slots.Dispose();

    private void RecordFailure((TenantId, ItemId) key, DateTimeOffset now)
    {
        if (_failures.Count >= SweepThreshold)
        {
            foreach (var entry in _failures)
            {
                if (entry.Value.RetryAt + MaximumBackoff < now)
                {
                    _failures.TryRemove(entry.Key, out _);
                }
            }
        }

        _failures.AddOrUpdate(
            key,
            _ => new Failures(1, now),
            (_, previous) =>
            {
                var count = previous.Count + 1;
                var excess = count - FreeFailures;
                if (excess <= 0)
                {
                    return new Failures(count, now);
                }

                // One minute after the first failure past the free ones, doubling each time.
                var backoff = TimeSpan.FromMinutes(Math.Pow(2, Math.Min(excess - 1, 10)));
                return new Failures(count, now + (backoff < MaximumBackoff ? backoff : MaximumBackoff));
            });
    }

    private sealed record Failures(int Count, DateTimeOffset RetryAt);
}

/// <summary>The outcome of one password check.</summary>
/// <param name="Outcome">What happened.</param>
/// <param name="RetryAfter">How long to wait, when the check was refused for backoff.</param>
public readonly record struct PasswordCheck(PasswordCheckOutcome Outcome, TimeSpan RetryAfter)
{
    /// <summary>The password matched.</summary>
    public static PasswordCheck Matched => new(PasswordCheckOutcome.Matched, TimeSpan.Zero);

    /// <summary>The password did not match.</summary>
    public static PasswordCheck Wrong => new(PasswordCheckOutcome.Wrong, TimeSpan.Zero);

    /// <summary>No derivation slot came free in time.</summary>
    public static PasswordCheck Busy => new(PasswordCheckOutcome.Busy, TimeSpan.Zero);

    /// <summary>The lock is refusing attempts after repeated wrong answers.</summary>
    /// <param name="retryAfter">How long until it accepts one again.</param>
    /// <returns>The outcome.</returns>
    public static PasswordCheck Throttled(TimeSpan retryAfter) =>
        new(PasswordCheckOutcome.Throttled, retryAfter);
}

/// <summary>What one password check concluded.</summary>
public enum PasswordCheckOutcome
{
    /// <summary>The password matched.</summary>
    Matched,

    /// <summary>The password did not match.</summary>
    Wrong,

    /// <summary>No derivation slot came free in time.</summary>
    Busy,

    /// <summary>The lock is refusing attempts after repeated wrong answers.</summary>
    Throttled,
}
