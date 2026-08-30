using Nix.Domain.Tenancy;

namespace Nix.Domain.Identity;

/// <summary>A revocable server-owned session created by an interactive OIDC code exchange.</summary>
public sealed class BrowserSession
{
    /// <summary>The exact length of the lowercase SHA-256 hex lookup.</summary>
    public const int TokenHashLength = 64;

    /// <summary>The session row.</summary>
    public required BrowserSessionId Id { get; init; }

    /// <summary>The tenant carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>The active human principal this session acts as.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>SHA-256 of the opaque cookie token. The token itself is never stored.</summary>
    public required string TokenHash { get; init; }

    /// <summary>When Core completed the interactive sign-in.</summary>
    public required DateTimeOffset CreatedAt { get; init; }

    /// <summary>The hard session end. There is no unbounded browser credential.</summary>
    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>When the browser explicitly ended the session, if it has.</summary>
    public DateTimeOffset? RevokedAt { get; set; }
}
