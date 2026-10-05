using System.Net;

namespace Nix.Authentication;

/// <summary>
/// Per-client fixed window over failed token validations, so a credential-guessing loop meets a
/// 429 instead of a free oracle.
/// </summary>
/// <remarks>
/// <para>
/// A fixed window rather than a token bucket, because the thing being resisted is a runaway or
/// hostile client presenting invalid tokens in a loop, not a burst that needs smoothing. The same
/// reasoning, and the same honesty, as the collaboration service's <c>RateWindow</c>: this is in
/// memory, so with more than one replica the effective limit is the window times the replica
/// count. That is fine for what it defends against - slowing an online guessing loop - and would
/// not be fine for anything that needs an exact count, which is why nothing else uses it.
/// </para>
/// <para>
/// The clock is injected so tests can move it; the map is swept once it grows past a bound, because
/// an entry per client address for the process's lifetime is a slow leak, and the slow kind is the
/// kind that reaches production.
/// </para>
/// <para>
/// <b>The bound is a real ceiling, not a sweep trigger.</b> A sweep can only remove windows that
/// have expired, and during an active scan every entry was created inside the current window, so
/// sweeping frees nothing. Left there, the map grows without limit - an attacker holding an IPv6
/// /64 has 2^64 source addresses to spend - and every new key pays an O(n) scan inside the same
/// lock that <see cref="IsThrottled"/> takes on every authenticated request. So past
/// <see cref="SweepThreshold"/> live entries the throttle stops tracking <em>new</em> keys until the
/// window turns over, and the sweep itself runs at most once per window. Failing open for new keys
/// past the cap is the correct trade: an attacker who has already burned ten thousand addresses is
/// not stopped by entry 10,001, whereas an unbounded map takes the whole process down with it.
/// Worst case on the heap is <see cref="SweepThreshold"/> x ~120 B, about 1.2 MB.
/// </para>
/// </remarks>
public sealed class FailedAuthenticationThrottle
{
    /// <summary>Configuration key for the failures allowed per window. Default: 10.</summary>
    public const string LimitConfigurationKey = "Nix:RateLimits:FailedAuthenticationLimit";

    /// <summary>Configuration key for the window length in seconds. Default: 300.</summary>
    public const string WindowSecondsConfigurationKey = "Nix:RateLimits:FailedAuthenticationWindowSeconds";

    /// <summary>Failures allowed per window when configuration says nothing.</summary>
    public const int DefaultLimit = 10;

    /// <summary>Window length when configuration says nothing.</summary>
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(5);

    /// <summary>
    /// The most clients tracked at once. Past this, expired windows are swept, and if that frees
    /// nothing no further client is tracked until the window turns over.
    /// </summary>
    public const int SweepThreshold = 10_000;

    // IPAddress keys, not their string form: the address already has value equality and a hash
    // code, and formatting one per request on the authenticated path bought nothing.
    private readonly Dictionary<IPAddress, FailureWindow> _failures = [];
    private readonly Lock _gate = new();
    private readonly TimeProvider _clock;
    private readonly int _limit;
    private readonly TimeSpan _window;

    // When the next sweep is allowed. A sweep is O(n) under the gate, so it runs at most once per
    // window rather than once per insert past the threshold.
    private DateTimeOffset _nextSweepAt = DateTimeOffset.MinValue;

    /// <summary>Initializes a new instance of the <see cref="FailedAuthenticationThrottle"/> class.</summary>
    /// <param name="clock">The clock, injected so tests control time.</param>
    /// <param name="limit">Failures allowed per window before the client is throttled.</param>
    /// <param name="window">How long a window lasts.</param>
    public FailedAuthenticationThrottle(TimeProvider clock, int limit, TimeSpan window)
    {
        ArgumentNullException.ThrowIfNull(clock);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(window, TimeSpan.Zero);

        _clock = clock;
        _limit = limit;
        _window = window;
    }

    /// <summary>How many clients are currently tracked. Never exceeds <see cref="SweepThreshold"/>.</summary>
    public int TrackedClients
    {
        get
        {
            lock (_gate)
            {
                return _failures.Count;
            }
        }
    }

    /// <summary>
    /// Says whether <paramref name="clientKey"/> has failed enough this window to be refused
    /// without another validation attempt.
    /// </summary>
    /// <param name="clientKey">What identifies the client - the remote address.</param>
    /// <param name="retryAfter">How long until the window expires, when throttled; zero otherwise.</param>
    /// <returns><see langword="true"/> when the client is over the limit.</returns>
    public bool IsThrottled(IPAddress clientKey, out TimeSpan retryAfter)
    {
        ArgumentNullException.ThrowIfNull(clientKey);

        var now = _clock.GetUtcNow();
        lock (_gate)
        {
            if (_failures.TryGetValue(clientKey, out var window)
                && now - window.StartedAt < _window
                && window.Count >= _limit)
            {
                retryAfter = window.StartedAt + _window - now;
                return true;
            }
        }

        retryAfter = TimeSpan.Zero;
        return false;
    }

    /// <summary>Records one failed validation for <paramref name="clientKey"/>.</summary>
    /// <param name="clientKey">What identifies the client - the remote address.</param>
    /// <returns>
    /// <see langword="true"/> when this failure is the one that reached the limit, so a caller can
    /// log the crossing once rather than logging every refusal that follows it.
    /// </returns>
    public bool RecordFailure(IPAddress clientKey)
    {
        ArgumentNullException.ThrowIfNull(clientKey);

        var now = _clock.GetUtcNow();
        lock (_gate)
        {
            if (_failures.TryGetValue(clientKey, out var window) && now - window.StartedAt < _window)
            {
                var count = window.Count + 1;
                _failures[clientKey] = window with { Count = count };
                return count == _limit;
            }

            if (_failures.Count >= SweepThreshold)
            {
                if (now >= _nextSweepAt)
                {
                    Sweep(now);
                    _nextSweepAt = now + _window;
                }

                // Still full after sweeping, so every tracked window is live and the map is at its
                // ceiling. New keys go untracked until one turns over - see the class remarks for
                // why failing open here beats an unbounded map.
                if (_failures.Count >= SweepThreshold)
                {
                    return false;
                }
            }

            _failures[clientKey] = new FailureWindow(now, 1);
            return _limit == 1;
        }
    }

    private void Sweep(DateTimeOffset now)
    {
        // Called under the gate. Removing while iterating is safe on Dictionary since .NET Core 3.0.
        foreach (var (key, window) in _failures)
        {
            if (now - window.StartedAt >= _window)
            {
                _failures.Remove(key);
            }
        }
    }

    private readonly record struct FailureWindow(DateTimeOffset StartedAt, int Count);
}
