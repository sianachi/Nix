namespace Nix.Persistence.Sql.Statements;

/// <summary>
/// Setting, checking and removing item locks, and issuing the grants past them.
/// </summary>
/// <remarks>
/// <para>
/// <b>Nothing here decides whether the caller may see the item.</b> Every statement is reached
/// only after the handler has asked the permission resolver, so these answer the narrower
/// question - is this body locked, and has this credential unlocked it - and nothing wider.
/// </para>
/// <para>
/// The clock is a parameter rather than <c>now()</c>, so expiry is judged against the same instant
/// the handler reported to the caller, and a test can move it.
/// </para>
/// <para>
/// Index dependencies: <c>AK_item_lock_tenant_id_item_id</c> for every lock probe (an index-only
/// scan, since every statement filters on the tenant too) and <c>PK_item_unlock</c> for grants.
/// </para>
/// </remarks>
public static class ItemLockSql
{
    /// <summary>
    /// Whether the item is locked, and until when this credential may read it anyway.
    /// </summary>
    /// <remarks>
    /// A null credential - a caller who authenticated some way that cannot unlock - matches no
    /// grant, so the second column is null and the lock holds.
    /// </remarks>
    public const string State = """
        SELECT EXISTS (
                   SELECT 1 FROM item_lock
                   WHERE item_lock.tenant_id = @tenant_id AND item_lock.item_id = @item_id
               ) AS locked,
               (
                   SELECT item_unlock.expires_at FROM item_unlock
                   WHERE item_unlock.tenant_id = @tenant_id
                     AND item_unlock.item_id = @item_id
                     AND item_unlock.credential_id = @credential_id
                     AND item_unlock.expires_at > @now
               ) AS unlocked_until
        """;

    /// <summary>Whether this credential may read the body: it is not locked, or it is unlocked.</summary>
    public const string MayReadBody = """
        SELECT NOT EXISTS (
                   SELECT 1 FROM item_lock
                   WHERE item_lock.tenant_id = @tenant_id AND item_lock.item_id = @item_id
               )
            OR EXISTS (
                   SELECT 1 FROM item_unlock
                   WHERE item_unlock.tenant_id = @tenant_id
                     AND item_unlock.item_id = @item_id
                     AND item_unlock.credential_id = @credential_id
                     AND item_unlock.expires_at > @now
               )
        """;

    /// <summary>
    /// Whether the item, or any active item under it, is locked. Trashed descendants are not
    /// counted: an export leaves them out, and the collaboration service withholds a locked body
    /// on its own if one is ever included.
    /// </summary>
    /// <remarks>
    /// Driven from the tenant's locks rather than the subtree's descendants: a tenant has few locks
    /// and a workspace export may have a hundred thousand descendants, so this costs one closure
    /// probe per lock instead of one lock probe per descendant. The closure carries the depth-0
    /// self edge, so the root is covered by the same join.
    /// </remarks>
    public const string AnyInSubtree = """
        SELECT EXISTS (
            SELECT 1
            FROM item_lock
            JOIN item_closure AS edge
              ON edge.tenant_id = item_lock.tenant_id
             AND edge.descendant_id = item_lock.item_id
             AND edge.ancestor_id = @item_id
            JOIN item
              ON item.tenant_id = item_lock.tenant_id
             AND item.id = item_lock.item_id
            WHERE item_lock.tenant_id = @tenant_id
              AND (edge.depth = 0 OR item.lifecycle_state = 'active')
        )
        """;

    /// <summary>Which of a set of items are locked.</summary>
    public const string LockedAmong = """
        SELECT item_id FROM item_lock
        WHERE tenant_id = @tenant_id AND item_id = ANY(@item_ids)
        """;

    /// <summary>The stored verifier, or no row when the item is not locked.</summary>
    public const string Verifier = """
        SELECT password_hash FROM item_lock
        WHERE tenant_id = @tenant_id AND item_id = @item_id
        """;

    /// <summary>
    /// Locks an unlocked item. Writes nothing when it is already locked, so a second lock cannot
    /// silently replace the first password.
    /// </summary>
    public const string Lock = """
        INSERT INTO item_lock (item_id, tenant_id, password_hash, locked_by, locked_at)
        VALUES (@item_id, @tenant_id, @password_hash, @principal_id, @now)
        ON CONFLICT (item_id) DO NOTHING
        """;

    /// <summary>
    /// Replaces a lock's verifier - only if it still carries the one the current password was
    /// checked against, so of two changes racing from the same old password the second finds
    /// nothing to replace rather than overwriting a password it never proved.
    /// </summary>
    public const string ChangeVerifier = """
        UPDATE item_lock
        SET password_hash = @password_hash, locked_by = @principal_id, locked_at = @now
        WHERE tenant_id = @tenant_id AND item_id = @item_id AND password_hash = @expected_hash
        """;

    /// <summary>
    /// Drops every grant past one lock. Run with <see cref="ChangeVerifier"/>, so nobody holding an
    /// unlock from the old password keeps reading under the new one.
    /// </summary>
    public const string RevokeAll = """
        DELETE FROM item_unlock
        WHERE tenant_id = @tenant_id AND item_id = @item_id
        """;

    /// <summary>Removes a lock; its grants go with it by cascade.</summary>
    public const string Remove = """
        DELETE FROM item_lock
        WHERE tenant_id = @tenant_id AND item_id = @item_id
        """;

    /// <summary>
    /// Issues or extends one credential's grant - only while the lock still carries the verifier the
    /// password was just checked against - and sweeps the tenant's expired grants while here.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The verifier condition closes two races the key derivation's few hundred milliseconds open:
    /// a lock removed meanwhile (the insert would otherwise fail the foreign key), and a password
    /// changed meanwhile (the insert would otherwise issue a grant under the old password after
    /// the change revoked every other). Either way no row is written and the caller is told.
    /// </para>
    /// <para>
    /// <c>FOR SHARE</c> on the lock row makes a concurrent change or removal wait for this grant
    /// and then revoke it, or - if it committed first - leaves this insert with nothing to select.
    /// </para>
    /// <para>
    /// The sweep is housekeeping rather than enforcement - every read compares the expiry with the
    /// clock - and it runs here because an unlock is the only thing that adds rows. It skips rows
    /// another transaction holds rather than waiting on them: waiting on another credential's
    /// grant is how two unlocks deadlock.
    /// </para>
    /// </remarks>
    public const string Grant = """
        DELETE FROM item_unlock
        WHERE (item_id, credential_id) IN (
            SELECT item_id, credential_id FROM item_unlock
            WHERE tenant_id = @tenant_id AND expires_at <= @now
            FOR UPDATE SKIP LOCKED);

        INSERT INTO item_unlock (item_id, credential_id, tenant_id, principal_id, expires_at)
        SELECT item_lock.item_id, @credential_id, item_lock.tenant_id, @principal_id, @expires_at
        FROM item_lock
        WHERE item_lock.tenant_id = @tenant_id
          AND item_lock.item_id = @item_id
          AND item_lock.password_hash = @password_hash
        FOR SHARE
        ON CONFLICT (item_id, credential_id)
        DO UPDATE SET expires_at = EXCLUDED.expires_at, principal_id = EXCLUDED.principal_id
        """;

    /// <summary>Ends one credential's grant: the "lock again" button.</summary>
    public const string Revoke = """
        DELETE FROM item_unlock
        WHERE tenant_id = @tenant_id AND item_id = @item_id AND credential_id = @credential_id
        """;
}
