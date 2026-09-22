namespace Nix.Features.Locks;

/// <summary>An item's lock as the calling credential sees it.</summary>
/// <param name="Locked">Whether the item's body is behind a password.</param>
/// <param name="UnlockedUntil">
/// When this credential's unlock ends, or null when it holds none. Always null when
/// <paramref name="Locked"/> is false.
/// </param>
internal sealed record ItemLockResponse(bool Locked, DateTimeOffset? UnlockedUntil);

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
