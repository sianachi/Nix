using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Locks;

/// <summary>
/// A password an item's body is held behind.
/// </summary>
/// <remarks>
/// <para>
/// <b>A lock withholds the body; it does not encrypt it.</b> The body stays in the content log as
/// it always was, and Core refuses to hand it to a credential that has not presented the password
/// recently. That protects against somebody at an unlocked session and against other members of a
/// shared workspace. It does not protect against anybody who can read the database, and nothing
/// in this type should be read as a claim that it does.
/// </para>
/// <para>
/// Titles and properties are outside the lock on purpose: they are what a tree, a board or a
/// search result needs to draw a row, and hiding them would make a locked item invisible rather
/// than closed.
/// </para>
/// </remarks>
public sealed class ItemLock
{
    /// <summary>Gets the locked item.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>Gets the tenant the item belongs to.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>
    /// Gets the password verifier, in the self-describing format the hasher writes. Never the
    /// password, and never returned by any read.
    /// </summary>
    public required string PasswordHash { get; init; }

    /// <summary>Gets the principal who set the lock, or last changed its password.</summary>
    public required PrincipalId LockedBy { get; init; }

    /// <summary>Gets when the lock was set, or its password last changed.</summary>
    public required DateTimeOffset LockedAt { get; init; }
}
