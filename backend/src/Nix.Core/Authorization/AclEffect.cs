namespace Nix.Core.Authorization;

/// <summary>
/// Whether an access control entry grants or refuses.
/// </summary>
/// <remarks>
/// Deny is not merely "absence of allow". It wins over every allow anywhere in the ancestor chain,
/// which is the first branch of the resolution order and the reason the two are one column rather
/// than two tables.
/// </remarks>
public enum AclEffect
{
    /// <summary>The entry grants its role to its subject.</summary>
    Allow = 0,

    /// <summary>The entry refuses, and outranks any allow in the chain.</summary>
    Deny = 1,
}
