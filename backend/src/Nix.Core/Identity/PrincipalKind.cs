namespace Nix.Core.Identity;

/// <summary>
/// What sort of identity a principal represents.
/// </summary>
public enum PrincipalKind
{
    /// <summary>A human, provisioned from the tenant's identity provider.</summary>
    User = 0,

    /// <summary>A machine identity acting on its own behalf, not a person's.</summary>
    Service = 1,
}
