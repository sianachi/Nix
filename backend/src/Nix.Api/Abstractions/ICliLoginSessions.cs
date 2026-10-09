using Nix.Domain.Identity;

namespace Nix.Abstractions;

/// <summary>Exact capability lookups for durable, single-use CLI browser approvals.</summary>
/// <remarks>Production uses narrow Postgres security-definer functions; an I/O fake covers coordinator behavior.</remarks>
public interface ICliLoginSessions
{
    /// <summary>Creates a bounded ten-minute pairing with no identity until browser approval.</summary>
    public ValueTask<bool> StartAsync(string deviceHash, string userHash, CancellationToken cancellationToken);

    /// <summary>Finds a live pending browser challenge from its exact displayed-code hash.</summary>
    public ValueTask<DateTimeOffset?> FindPendingAsync(string userHash, CancellationToken cancellationToken);

    /// <summary>Approves or refuses a pending challenge using the exact standing browser-cookie hash.</summary>
    public ValueTask<bool> DecideAsync(string userHash, string browserHash, bool approve, CancellationToken cancellationToken);

    /// <summary>Atomically consumes one approved challenge and creates a parent-bound session.</summary>
    public ValueTask<CliLoginRedemption> RedeemAsync(string deviceHash, BrowserSessionId sessionId, string refreshHash, CancellationToken cancellationToken);

    /// <summary>Resolves only a standing CLI session, including its source browser session.</summary>
    public ValueTask<AuthenticatedBrowserSession?> FindByRefreshHashAsync(string refreshHash, CancellationToken cancellationToken);

    /// <summary>Idempotently revokes only the CLI session named by its exact refresh hash.</summary>
    public ValueTask RevokeAsync(string refreshHash, CancellationToken cancellationToken);
}

/// <summary>The closed outcome of a challenge redemption.</summary>
public sealed record CliLoginRedemption(string Status, AuthenticatedBrowserSession? Session);
