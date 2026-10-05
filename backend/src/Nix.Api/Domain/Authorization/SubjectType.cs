namespace Nix.Domain.Authorization;

/// <summary>
/// What kind of subject an access control entry or role grant names.
/// </summary>
/// <remarks>
/// The distinction is load-bearing in the resolution order rather than merely descriptive: at
/// equal closure depth a <see cref="Principal"/> entry beats a <see cref="Group"/> entry, and
/// among competing group entries the most permissive wins.
/// </remarks>
public enum SubjectType
{
    /// <summary>The entry names one principal directly.</summary>
    Principal = 0,

    /// <summary>The entry names a group; it applies to every current member.</summary>
    Group = 1,
}
