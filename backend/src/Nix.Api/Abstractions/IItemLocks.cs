using Nix.Domain.Items;

namespace Nix.Abstractions;

/// <summary>
/// Item locks and the grants past them, for the tenant and credential of the current unit of work.
/// </summary>
/// <remarks>
/// <para>
/// <b>Not a permission resolver.</b> A lock narrows what somebody who may already read an item can
/// see of it - the body - and every caller asks <see cref="IPermissionResolver"/> first. Nothing
/// here answers whether the item is visible at all.
/// </para>
/// <para>
/// The credential is taken from <see cref="CredentialSessionContext"/>, never from a parameter, so a
/// handler cannot check or issue a grant for a credential other than the one that authenticated.
/// </para>
/// </remarks>
public interface IItemLocks
{
    /// <summary>Whether the item is locked, and until when the current credential has it unlocked.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The lock state as the current credential sees it.</returns>
    public ValueTask<ItemLockState> GetStateAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// Whether the current credential may read the item's body: it is not locked, or this
    /// credential holds an unexpired grant.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when the body may be served.</returns>
    public ValueTask<bool> MayReadBodyAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Whether the item or any of its descendants is locked, whoever has them unlocked.</summary>
    /// <param name="itemId">The root of the subtree.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when at least one item in the subtree is locked.</returns>
    public ValueTask<bool> AnyInSubtreeAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Which of these items are locked, whoever is asking.</summary>
    /// <param name="itemIds">The items.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The locked ones.</returns>
    public ValueTask<IReadOnlySet<ItemId>> LockedAmongAsync(
        IReadOnlyList<ItemId> itemIds,
        CancellationToken cancellationToken);

    /// <summary>The stored verifier, or <see langword="null"/> when the item is not locked.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns>The verifier.</returns>
    public ValueTask<string?> FindVerifierAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Locks an unlocked item.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="verifier">The derived verifier to store.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="false"/> when the item was already locked and nothing was written.</returns>
    public ValueTask<bool> LockAsync(ItemId itemId, string verifier, CancellationToken cancellationToken);

    /// <summary>Replaces a lock's verifier and ends every grant issued under the old one.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="expected">The verifier the current password was checked against.</param>
    /// <param name="verifier">The new verifier.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when the item is no longer locked, or its password changed since the check.
    /// </returns>
    public ValueTask<bool> ChangeVerifierAsync(
        ItemId itemId,
        string expected,
        string verifier,
        CancellationToken cancellationToken);

    /// <summary>Removes a lock and every grant past it.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns><see langword="false"/> when the item was not locked.</returns>
    public ValueTask<bool> RemoveAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>
    /// Issues or extends the current credential's grant past a lock, provided the lock still
    /// carries <paramref name="verifier"/> - the one the password was just checked against.
    /// </summary>
    /// <param name="itemId">The item.</param>
    /// <param name="verifier">The verifier the password was checked against.</param>
    /// <param name="expiresAt">When the grant stops being honoured.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>
    /// <see langword="false"/> when the lock was removed, or its password changed, since the check.
    /// </returns>
    /// <exception cref="InvalidOperationException">The current credential cannot hold a grant.</exception>
    public ValueTask<bool> GrantAsync(
        ItemId itemId,
        string verifier,
        DateTimeOffset expiresAt,
        CancellationToken cancellationToken);

    /// <summary>Whether the item is locked at all, whoever is asking and whatever they have unlocked.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    /// <returns><see langword="true"/> when the item has a lock.</returns>
    public ValueTask<bool> IsLockedAsync(ItemId itemId, CancellationToken cancellationToken);

    /// <summary>Ends the current credential's grant, if it holds one.</summary>
    /// <param name="itemId">The item.</param>
    /// <param name="cancellationToken">Cancels the write.</param>
    /// <returns>A task that completes when the grant is gone.</returns>
    public ValueTask RevokeAsync(ItemId itemId, CancellationToken cancellationToken);
}

/// <summary>An item's lock as one credential sees it.</summary>
/// <param name="Locked">Whether the item has a lock.</param>
/// <param name="UnlockedUntil">
/// When the current credential's grant ends, or <see langword="null"/> when it holds none.
/// </param>
public sealed record ItemLockState(bool Locked, DateTimeOffset? UnlockedUntil);
