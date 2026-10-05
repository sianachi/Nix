namespace Nix.Domain.Identity;

/// <summary>
/// Whether a principal may act.
/// </summary>
/// <remarks>
/// Checked on every request rather than only at sign-in, because an access token outlives the
/// decision to revoke it. Anything other than <see cref="Active"/> refuses the request even if the
/// token is otherwise valid and unexpired, which is what makes deprovisioning fail closed
/// immediately instead of at the next token exchange.
/// </remarks>
public enum PrincipalStatus
{
    /// <summary>May authenticate and act.</summary>
    Active = 0,

    /// <summary>Temporarily barred; the record and its grants are retained.</summary>
    Suspended = 1,

    /// <summary>Removed at the identity provider. Refused permanently.</summary>
    Deprovisioned = 2,
}
