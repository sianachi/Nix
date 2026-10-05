namespace Nix.Features.Locks;

/// <summary>An item's lock as the calling credential sees it.</summary>
/// <param name="Locked">
/// Whether the item's body and children are behind a password - its own, or an ancestor's.
/// </param>
/// <param name="UnlockedUntil">
/// When this credential's unlock ends, or null while any covering lock is closed to it. Always
/// null when <paramref name="Locked"/> is false.
/// </param>
/// <param name="LockItemId">
/// The item whose password opens this one next: the nearest covering lock this credential has not
/// opened, or the nearest one when all are open. Null when nothing is locked.
/// </param>
/// <param name="SelfLocked">
/// Whether the item carries a lock of its own, which is the one a change or removal acts on.
/// </param>
internal sealed record ItemLockResponse(
    bool Locked,
    DateTimeOffset? UnlockedUntil,
    Guid? LockItemId,
    bool SelfLocked);

/// <summary>Sets a lock, or changes the password of an existing one.</summary>
/// <param name="Password">The new password.</param>
/// <param name="CurrentPassword">The existing password; required when the item is already locked.</param>
internal sealed record SetItemLockRequest(string Password, string? CurrentPassword);

/// <summary>Carries a lock's password, to unlock the item or remove the lock.</summary>
/// <param name="Password">The lock's password.</param>
internal sealed record ItemLockPasswordRequest(string Password);

/// <summary>The result of an unlock.</summary>
/// <param name="UnlockedUntil">When the unlock ends.</param>
internal sealed record UnlockItemResponse(DateTimeOffset UnlockedUntil);
