using Nix.Domain.Identity;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Content;

/// <summary>
/// A revision somebody named.
/// </summary>
/// <remarks>
/// <para>
/// Naming a revision pins a <see cref="ContentSnapshot"/> at its <see cref="Seq"/> so retention can
/// never remove the state the name points at - a named version is the one place a snapshot stops
/// being purely derived data. The row itself carries no content; it is a pointer into the log the
/// collaboration service reconstructs the state from, the same way any other "state at seq" read
/// does.
/// </para>
/// <para>
/// Primary key <c>(doc_id, seq)</c>: a revision, identified by its last sequence, can be named at
/// most once. Renaming replaces the row rather than adding a second name at the same point.
/// </para>
/// </remarks>
public sealed class ContentVersion
{
    /// <summary>Gets the document this version belongs to.</summary>
    public required ContentDocId DocId { get; init; }

    /// <summary>Gets the revision's last sequence, and the point the pinned snapshot is taken at.</summary>
    public required long Seq { get; init; }

    /// <summary>Gets the owning tenant, carried on the row for the isolation policy.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>Gets the name somebody gave this revision, 1 to 120 characters.</summary>
    public required string Name { get; init; }

    /// <summary>Gets the principal who named it.</summary>
    public required PrincipalId CreatedBy { get; init; }

    /// <summary>Gets when it was named.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}
