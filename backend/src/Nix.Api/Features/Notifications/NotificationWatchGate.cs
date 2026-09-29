using System.Collections.Concurrent;

namespace Nix.Features.Notifications;

/// <summary>
/// Bounds how many <c>notifications/watch</c> long-polls one principal can hold open at once.
/// </summary>
/// <remarks>
/// The watch route is deliberately outside the writes rate limiter (it is a read, and must never
/// queue behind one), so nothing else stops a client with several tabs from pinning several
/// long-lived transactions. This is the bound instead: at most two outstanding per principal, the
/// same shape the Go worker's own pet-runtime watch enforces, checked before a unit of work opens
/// rather than after.
/// </remarks>
public sealed class NotificationWatchGate
{
    /// <summary>The most watches one principal may hold open at the same time.</summary>
    public const int MaxConcurrent = 2;

    private readonly ConcurrentDictionary<Guid, int> active = new();

    /// <summary>Claims a slot for this principal. Returns <see langword="false"/> when none is free.</summary>
    public bool TryEnter(Guid principalId)
    {
        while (true)
        {
            var current = active.GetOrAdd(principalId, 0);
            if (current >= MaxConcurrent)
            {
                return false;
            }

            if (active.TryUpdate(principalId, current + 1, current))
            {
                return true;
            }
        }
    }

    /// <summary>Releases the slot claimed by a matching <see cref="TryEnter"/>.</summary>
    public void Exit(Guid principalId)
    {
        while (true)
        {
            if (!active.TryGetValue(principalId, out var current))
            {
                return;
            }

            var next = Math.Max(0, current - 1);
            if (next == 0)
            {
                if (active.TryRemove(new KeyValuePair<Guid, int>(principalId, current)))
                {
                    return;
                }
            }
            else if (active.TryUpdate(principalId, next, current))
            {
                return;
            }
        }
    }
}
