using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Abstractions;

/// <summary>Creates and resolves Core-owned browser sessions.</summary>
/// <remarks>
/// Cookie and signed-session-token resolution happen before a tenant context exists and therefore
/// use exact, security-definer lookups. Creation and revocation run inside the tenant transaction.
/// Test fakes exercise every consumer; the production implementation is database I/O.
/// </remarks>
public interface IBrowserSessions
{
    /// <summary>Resolves the hash of an opaque browser cookie.</summary>
    public ValueTask<AuthenticatedBrowserSession?> FindByTokenHashAsync(
        string tokenHash,
        CancellationToken cancellationToken);

    /// <summary>Resolves the session named by a short-lived Core-signed JWT.</summary>
    public ValueTask<AuthenticatedBrowserSession?> FindByIdAsync(
        BrowserSessionId id,
        CancellationToken cancellationToken);

    /// <summary>Stores a session inside the acting principal's unit of work.</summary>
    public ValueTask AddAsync(BrowserSession session, CancellationToken cancellationToken);

    /// <summary>Revokes the acting principal's session if it still stands.</summary>
    public ValueTask<bool> RevokeAsync(
        BrowserSessionId id,
        DateTimeOffset revokedAt,
        CancellationToken cancellationToken);
}

/// <summary>The safe pre-authentication projection of an active browser session.</summary>
/// <param name="Id">The session row.</param>
/// <param name="TenantId">The tenant it belongs to.</param>
/// <param name="PrincipalId">The human principal it acts as.</param>
/// <param name="PrincipalStatus">The principal's current admission status.</param>
/// <param name="DisplayName">The principal's current display name.</param>
/// <param name="ExpiresAt">The session's hard expiry.</param>
public sealed record AuthenticatedBrowserSession(
    BrowserSessionId Id,
    TenantId TenantId,
    PrincipalId PrincipalId,
    PrincipalStatus PrincipalStatus,
    string DisplayName,
    DateTimeOffset ExpiresAt);
