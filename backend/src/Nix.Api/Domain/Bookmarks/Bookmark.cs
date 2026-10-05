using Nix.Domain.Identity;
using Nix.Domain.Items;
using Nix.Domain.Tenancy;

namespace Nix.Domain.Bookmarks;

/// <summary>
/// One item a principal has kept.
/// </summary>
/// <remarks>
/// <para>
/// <b>Personal state about a shared thing.</b> An item belongs to a workspace and is read by
/// everybody in it; a bookmark belongs to one person. That is why this is its own row keyed by
/// principal rather than a flag on the item - a flag would put one reader's shelf on everybody
/// else's document, and the first person to bookmark something would appear to have bookmarked it
/// for the whole team.
/// </para>
/// <para>
/// <b>It carries no title.</b> The item's name lives on the item and changes there; a copy here
/// would be a second one to keep in step, and the read joins for it rather than storing it. A
/// bookmark is a reference, and a reference that remembers what its target used to be called is a
/// stale fact waiting to be believed.
/// </para>
/// </remarks>
public sealed class Bookmark
{
    /// <summary>The principal whose shelf this is.</summary>
    public required PrincipalId PrincipalId { get; init; }

    /// <summary>The tenant, carried for row-level security.</summary>
    public required TenantId TenantId { get; init; }

    /// <summary>The item kept.</summary>
    public required ItemId ItemId { get; init; }

    /// <summary>
    /// Where this sits in the shelf. Read back highest first.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A sequence rather than an ordering on <see cref="CreatedAt"/>, and the difference only shows
    /// up later. Today they agree: a new bookmark takes the next number, so highest-first is
    /// most-recent-first and no interface has to explain an order nobody chose. The moment somebody
    /// drags one to the top, "when it was kept" and "where it sits" become different facts, and a
    /// list ordered on a timestamp could only honour that by lying about when.
    /// </para>
    /// <para>
    /// Assigned by the database rather than by the application, so two tabs bookmarking at once
    /// cannot both claim the same position.
    /// </para>
    /// </remarks>
    public required long Seq { get; init; }

    /// <summary>When it was kept. Reported, never ordered on - see <see cref="Seq"/>.</summary>
    public required DateTimeOffset CreatedAt { get; init; }
}
