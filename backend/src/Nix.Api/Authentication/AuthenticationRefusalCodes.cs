namespace Nix.Authentication;

/// <summary>
/// The stable codes an authentication refusal carries, spelled once for the middleware that
/// writes them, the exchange endpoint that shares them, and the tests that assert them.
/// </summary>
/// <remarks>
/// These are wire contract: clients branch on them, so a respelling is a breaking change even
/// though no OpenAPI schema names them.
/// </remarks>
public static class AuthenticationRefusalCodes
{
    /// <summary>A request with no usable credentials.</summary>
    public const string Unauthenticated = "auth.unauthenticated";

    /// <summary>A principal who exists but may no longer act.</summary>
    public const string PrincipalInactive = "auth.principal_inactive";

    /// <summary>A session whose access token has been revoked or deleted.</summary>
    public const string TokenRevoked = "auth.token_revoked";

    /// <summary>A session whose access token has passed its chosen expiry.</summary>
    public const string TokenExpired = "auth.token_expired";

    /// <summary>A token that stands but does not reach this route.</summary>
    public const string InsufficientScope = "auth.insufficient_scope";

    /// <summary>The registered provider could not safely complete first-login provisioning.</summary>
    public const string ProvisioningUnavailable = "auth.provisioning_unavailable";
}
