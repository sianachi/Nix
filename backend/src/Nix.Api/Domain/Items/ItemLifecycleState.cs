namespace Nix.Domain.Items;

/// <summary>
/// Where an item sits in the deletion lifecycle.
/// </summary>
/// <remarks>
/// <para>
/// Soft deletion is a flag flip on the item itself, never a cascade: the subtree stays intact and
/// descendants become invisible by closure-table derivation. Restoring is the same flip back.
/// </para>
/// <para>
/// Purge is the irreversible step - children reparent to the grandparent, blobs and the content
/// log are deleted, and only the audit trail survives. Every transition into
/// <see cref="Purged"/> is blocked while a legal hold covers the item.
/// </para>
/// </remarks>
public enum ItemLifecycleState
{
    /// <summary>Visible and editable.</summary>
    Active = 0,

    /// <summary>Soft-deleted. Recoverable by flipping back to <see cref="Active"/>.</summary>
    Deleted = 1,

    /// <summary>Content destroyed. Terminal.</summary>
    Purged = 2,

    /// <summary>
    /// Hidden staging state used while collaboration bodies are being hydrated. It is never
    /// returned by ordinary item reads.
    /// </summary>
    Provisioning = 3,
}
