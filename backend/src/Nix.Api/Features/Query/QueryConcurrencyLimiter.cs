using Nix.Domain.Identity;

namespace Nix.Features.Query;

/// <summary>
/// Bounds how many ad-hoc queries one principal may have running at once.
/// </summary>
/// <remarks>
/// <para>
/// The <c>queries</c> rate-limit policy runs before authentication, so it can only count requests
/// per address; this counts statements per principal, after the session is known, and is what
/// stops one caller - one assistant loop, one dashboard with many tiles - from holding several
/// workspace scans open at once. A request over the bound is refused at once rather than queued:
/// a queue would only move the wait somewhere the caller cannot see it.
/// </para>
/// <para>
/// Process-local, like the rate limiter beside it: with several API replicas the bound is per
/// replica. A singleton, held in memory only while a query runs; an idle principal costs nothing.
/// </para>
/// </remarks>
public sealed class QueryConcurrencyLimiter
{
    /// <summary>The most ad-hoc queries one principal may have in flight.</summary>
    public const int MaximumInFlight = 4;

    private readonly Dictionary<PrincipalId, int> _inFlight = [];
    private readonly Lock _gate = new();

    /// <summary>Takes a slot for <paramref name="principal"/>, or answers null when none is free.</summary>
    /// <param name="principal">The acting principal.</param>
    /// <returns>A lease to dispose when the query ends, or <see langword="null"/>.</returns>
    public IDisposable? TryEnter(PrincipalId principal)
    {
        lock (_gate)
        {
            _inFlight.TryGetValue(principal, out var count);
            if (count >= MaximumInFlight)
            {
                return null;
            }

            _inFlight[principal] = count + 1;
        }

        return new Lease(this, principal);
    }

    private void Exit(PrincipalId principal)
    {
        lock (_gate)
        {
            if (_inFlight.TryGetValue(principal, out var count) && count > 1)
            {
                _inFlight[principal] = count - 1;
            }
            else
            {
                _inFlight.Remove(principal);
            }
        }
    }

    private sealed class Lease(QueryConcurrencyLimiter owner, PrincipalId principal) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                owner.Exit(principal);
            }
        }
    }
}
